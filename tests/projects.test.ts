import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';

function fixture() {
  const db = new AtlasDatabase(':memory:');
  const projects = new ProjectStore(db.db);
  return { db, projects };
}

const snapshot: Snapshot = {
  id: 'lib',
  name: 'Library',
  prefix: '/users/0',
  serverId: null,
  collections: [],
  items: [
    {
      key: 'P1',
      data: {
        itemType: 'journalArticle',
        title: 'First',
        creators: [],
        tags: [{ tag: 'method/source' }],
        collections: [],
      },
    },
    {
      key: 'P2',
      data: {
        itemType: 'journalArticle',
        title: 'Second',
        creators: [],
        tags: [],
        collections: [],
      },
    },
  ],
};

test('v3 migration seeds exactly one example and survives reopen without touching library data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-projects-'));
  const path = join(dir, 'atlas.sqlite');
  try {
    let db = new AtlasDatabase(path);
    db.applySnapshots([snapshot]);
    db.patchPaper('lib:P1', { status: 'reading', tags: ['method/curated'] });
    const projects = new ProjectStore(db.db);
    const example = projects.list();
    assert.equal(example.length, 1);
    assert.equal(example[0].name, 'Example project');
    assert.equal(example[0].summary, '');
    assert.equal(example[0].githubUrl, '');
    assert.equal(example[0].overleafUrl, '');
    assert.deepEqual(example[0].paperIds, []);
    assert.equal(projects.detail(example[0].id)?.notes.length, 0);
    assert.equal(
      (
        db.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=3').get() as {
          count: number;
        }
      ).count,
      1,
    );
    db.close();

    db = new AtlasDatabase(path);
    const reopened = new ProjectStore(db.db);
    assert.deepEqual(reopened.list(), example);
    assert.equal(db.paper('lib:P1')?.status, 'reading');
    assert.deepEqual(db.paper('lib:P1')?.tags, ['method/curated']);
    assert.deepEqual(db.paper('lib:P1')?.zoteroTags, ['method/source']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project tags share Atlas definitions while source tags remain separate', () => {
  const { db, projects } = fixture();
  try {
    db.applySnapshots([snapshot]);
    const tag = db.createTag({ name: 'method/source', description: 'Curated' });
    const project = projects.create({
      name: 'Research',
      tags: [' method/source ', 'method/source', 'task/evaluate'],
    });
    assert.deepEqual(project.tags, ['method/source', 'task/evaluate']);
    const rows = db.db
      .prepare(
        `
      SELECT td.id,td.origin,td.name FROM project_tags pt JOIN tag_definitions td ON td.id=pt.tag_id
      WHERE pt.project_id=? ORDER BY td.name
    `,
      )
      .all(project.id) as { id: string; origin: string; name: string }[];
    assert.equal(rows.find((row) => row.name === 'method/source')?.id, tag.id);
    assert.ok(rows.every((row) => row.origin === 'atlas'));
    assert.equal(
      db.library().tags.find((item) => item.name === 'method/source' && item.origin === 'zotero')
        ?.description,
      '',
    );
    assert.deepEqual(db.paper('lib:P1')?.tags, []);
  } finally {
    db.close();
  }
});

test('paper links require actual paper_state IDs and invalid changes roll back', () => {
  const { db, projects } = fixture();
  try {
    db.applySnapshots([snapshot]);
    const project = projects.create({
      name: 'Research',
      paperIds: ['lib:P1', 'lib:P1'],
      tags: ['data/valid'],
    });
    assert.deepEqual(project.paperIds, ['lib:P1']);
    assert.throws(
      () =>
        projects.patch(project.id, {
          name: 'Changed',
          tags: ['data/new'],
          paperIds: ['lib:P2', 'lib:NOPE'],
        }),
      /Unknown paperId/,
    );
    assert.deepEqual(projects.detail(project.id)?.project, project);
    assert.equal(
      db.library().tags.some((tag) => tag.name === 'data/new'),
      false,
    );
    assert.throws(
      () => projects.create({ name: 'Failed', paperIds: ['lib:NOPE'] }),
      /Unknown paperId/,
    );
    assert.equal(projects.list().length, 2);
    assert.deepEqual(
      projects.patch(project.id, { paperIds: ['lib:P2'], status: 'paused' })?.paperIds,
      ['lib:P2'],
    );
    assert.equal(projects.patch('missing', { name: 'X' }), null);
    assert.equal(projects.detail('missing'), null);
  } finally {
    db.close();
  }
});

test('project validation limits and link rules reject unsafe values atomically', () => {
  const { db, projects } = fixture();
  try {
    const project = projects.create({
      name: 'Research',
      githubUrl: 'https://github.com/owner/repo/',
      overleafUrl: 'https://www.overleaf.com/project/abc123/',
    });
    assert.equal(project.githubUrl, 'https://github.com/owner/repo');
    assert.equal(project.overleafUrl, 'https://www.overleaf.com/project/abc123');
    for (const url of [
      'http://github.com/owner/repo',
      'https://github.com/owner/repo/issues',
      'https://user:token@github.com/owner/repo',
      'https://github.com/owner/repo?token=secret',
      'https://github.com/owner/repo#readme',
      'https://evil.example/owner/repo',
    ])
      assert.throws(() => projects.patch(project.id, { githubUrl: url }));
    for (const url of [
      'https://overleaf.com/project/abc',
      'https://www.overleaf.com/project/',
      'https://www.overleaf.com/read/abc?auth=1',
      'https://www.overleaf.com/project/abc/other',
      'https://me:pass@www.overleaf.com/read/abc',
    ])
      assert.throws(() => projects.patch(project.id, { overleafUrl: url }));
    assert.throws(() => projects.patch(project.id, { name: 'Changed', tags: ['valid', 'a//b'] }));
    assert.throws(() =>
      projects.patch(project.id, { tags: Array.from({ length: 101 }, (_, i) => `tag-${i}`) }),
    );
    assert.throws(() => projects.patch(project.id, { summary: 'x'.repeat(200001) }));
    assert.throws(() => projects.patch(project.id, { status: 'unknown' }));
    assert.deepEqual(projects.detail(project.id)?.project, project);
    assert.deepEqual(projects.patch(project.id, { githubUrl: '', overleafUrl: '' })?.githubUrl, '');
  } finally {
    db.close();
  }
});

test('notes belong to one project, organize by folder and pin, and can be restored', () => {
  const { db, projects } = fixture();
  try {
    const a = projects.create({ name: 'A' }),
      b = projects.create({ name: 'B' });
    const note = projects.createNote(a.id, {
      body: '# Method\n\n$x^2$',
      folder: 'Methods',
      pinned: true,
    })!;
    assert.equal(note.title, 'Untitled note');
    assert.equal(note.folder, 'Methods');
    assert.equal(note.pinned, true);
    assert.equal(projects.detail(a.id)?.project.noteCount, 1);
    assert.equal(projects.detail(b.id)?.project.noteCount, 0);
    assert.equal(projects.patchNote(b.id, note.id, { title: 'Stolen' }), null);
    assert.equal(projects.patchNote(a.id, note.id, { archived: true })?.archived, true);
    assert.equal(projects.detail(a.id)?.project.noteCount, 0);
    assert.equal(projects.detail(a.id)?.notes[0].body, '# Method\n\n$x^2$');
    assert.equal(
      projects.patchNote(a.id, note.id, { archived: false, title: 'Method' })?.title,
      'Method',
    );
    assert.equal(projects.detail(a.id)?.project.noteCount, 1);
    assert.throws(() => projects.patchNote(a.id, note.id, { body: 'x'.repeat(1000001) }));
    assert.equal(projects.detail(a.id)?.notes[0].title, 'Method');
    assert.equal(projects.createNote('missing', { title: 'Nope' }), null);
  } finally {
    db.close();
  }
});

test('assets store private bytes and resolve only under their owning project', () => {
  const { db, projects } = fixture();
  try {
    const a = projects.create({ name: 'A' }),
      b = projects.create({ name: 'B' });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const metadata = projects.addAsset(a.id, {
      filename: 'plot.png',
      contentType: 'image/png',
      data: bytes,
    })!;
    assert.equal(metadata.size, 4);
    assert.equal('data' in metadata, false);
    assert.deepEqual(projects.asset(a.id, metadata.id)?.data, bytes);
    assert.equal(projects.asset(b.id, metadata.id), null);
    assert.equal(
      projects.addAsset('missing', { filename: 'plot.png', contentType: 'image/png', data: bytes }),
      null,
    );
    assert.throws(() =>
      projects.addAsset(a.id, { filename: '../plot.png', contentType: 'image/png', data: bytes }),
    );
    assert.throws(() =>
      projects.addAsset(a.id, { filename: 'plot.svg', contentType: 'image/svg+xml', data: bytes }),
    );
    assert.throws(() =>
      projects.addAsset(a.id, {
        filename: 'huge.png',
        contentType: 'image/png',
        data: new Uint8Array(8 * 1024 * 1024 + 1),
      }),
    );
    assert.equal(
      (db.db.prepare('SELECT COUNT(*) AS count FROM project_assets').get() as { count: number })
        .count,
      1,
    );
  } finally {
    db.close();
  }
});
