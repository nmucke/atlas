import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot, type SourceItem } from '../server/database.ts';

const paperKey = 'PAPER001';
const paperId = `lib:${paperKey}`;
function source(key: string, data: Record<string, unknown>): SourceItem {
  return { key, data };
}
function paper(tags: string[] = [], title = 'A paper'): SourceItem {
  return source(paperKey, {
    itemType: 'journalArticle',
    title,
    creators: [],
    tags: tags.map((tag) => ({ tag })),
    collections: [],
  });
}
function snapshot(items: SourceItem[] = [paper()]): Snapshot {
  return {
    id: 'lib',
    name: 'My Library',
    prefix: '/users/0',
    serverId: null,
    items,
    collections: [],
  };
}
function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'atlas-tags-'));
}

test('v1 migration retains Zotero tags, paper state, and never promotes source tags to Atlas tags', () => {
  const dir = temporaryDirectory();
  const path = join(dir, 'atlas.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES(1);
      CREATE TABLE libraries(id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, server_id TEXT);
      CREATE TABLE source_items(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id), zotero_key TEXT NOT NULL, payload TEXT NOT NULL, missing INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(library_id,zotero_key));
      CREATE TABLE paper_state(id TEXT PRIMARY KEY REFERENCES source_items(id), status TEXT NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','reading','read')), starred INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL);
      CREATE TABLE collections(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id), name TEXT NOT NULL, parent_id TEXT);
      CREATE TABLE attachments(id TEXT PRIMARY KEY REFERENCES source_items(id), paper_id TEXT NOT NULL REFERENCES paper_state(id), title TEXT NOT NULL, content_type TEXT NOT NULL, filename TEXT NOT NULL);
      CREATE TABLE annotations(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES paper_state(id), attachment_id TEXT NOT NULL REFERENCES source_items(id), page INTEGER NOT NULL CHECK(page > 0), text TEXT NOT NULL, quote TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO libraries VALUES('lib','My Library','/users/0',NULL);
    `);
    old.prepare('INSERT INTO source_items VALUES(?,?,?,?,?,?)').run(
      paperId,
      'lib',
      paperKey,
      JSON.stringify({
        itemType: 'journalArticle',
        title: 'Migrated',
        creators: [],
        tags: [{ tag: 'method/foo' }, { tag: 'notes/read' }],
        collections: [],
      }),
      0,
      '2025-01-01T00:00:00.000Z',
    );
    old
      .prepare('INSERT INTO paper_state VALUES(?,?,?,?,?,?,?)')
      .run(paperId, 'reading', 1, 0, 'kept summary', 'kept notes', '2025-01-01T00:00:00.000Z');
    old.close();

    const db = new AtlasDatabase(path);
    try {
      const lib = db.library();
      assert.deepEqual(
        lib.tags.map(({ name, origin }) => ({ name, origin })),
        [
          { name: 'method/foo', origin: 'zotero' },
          { name: 'notes/read', origin: 'zotero' },
        ],
      );
      assert.deepEqual(lib.papers[0].zoteroTags, ['method/foo', 'notes/read']);
      assert.deepEqual(lib.papers[0].tags, []);
      assert.equal(lib.papers[0].status, 'reading');
      assert.equal(lib.papers[0].notes, 'kept notes');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Atlas and Zotero tags with the same name have separate origins and metadata', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    db.applySnapshots([snapshot([paper(['method/foo'])])]);
    db.createTag({ name: 'method/foo', description: 'Atlas method' });
    db.patchPaper(paperId, { tags: ['method/foo'] });
    const lib = db.library();
    assert.deepEqual(lib.papers[0].zoteroTags, ['method/foo']);
    assert.deepEqual(lib.papers[0].tags, ['method/foo']);
    assert.deepEqual(
      lib.tags.map(({ name, origin, description }) => ({ name, origin, description })),
      [
        { name: 'method/foo', origin: 'atlas', description: 'Atlas method' },
        { name: 'method/foo', origin: 'zotero', description: '' },
      ],
    );
  } finally {
    db.close();
  }
});

test('Atlas tag creation is idempotent and preserves its existing description', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    const first = db.createTag({ name: ' method/foo ', description: 'Meaning' });
    const second = db.createTag({ name: 'method/foo', description: 'Replacement' });
    assert.equal(second.id, first.id);
    assert.equal(second.description, 'Meaning');
    assert.equal(second.name, 'method/foo');
  } finally {
    db.close();
  }
});

test('paper assignments trim and deduplicate names, create definitions, and derive category from Atlas prefix', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    db.applySnapshots([snapshot()]);
    const updated = db.patchPaper(paperId, {
      tags: [' method/foo ', 'method/foo', 'freeform', 'task/evaluation'],
    })!;
    assert.deepEqual([...updated.tags].sort(), ['freeform', 'method/foo', 'task/evaluation']);
    assert.deepEqual(
      db.library().tags.map(({ name, category }) => ({ name, category })),
      [
        { name: 'freeform', category: null },
        { name: 'method/foo', category: 'method' },
        { name: 'task/evaluation', category: 'task' },
      ],
    );
  } finally {
    db.close();
  }
});

test('source resync preserves Atlas assignments and descriptions when Zotero tags change or disappear', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    db.applySnapshots([snapshot([paper(['method/foo', 'old/source'])])]);
    db.patchPaper(paperId, { tags: ['method/foo'] });
    const autoCreated = db.library().tags.find((tag) => tag.name === 'method/foo')!;
    const atlasTag = db.patchTag(autoCreated.id, { description: 'Curated definition' })!;
    db.applySnapshots([snapshot([paper(['new/source'])])]);
    assert.deepEqual(db.paper(paperId)!.zoteroTags, ['new/source']);
    assert.deepEqual(db.paper(paperId)!.tags, ['method/foo']);
    assert.equal(
      db.library().tags.find((tag) => tag.id === atlasTag.id)?.description,
      'Curated definition',
    );
  } finally {
    db.close();
  }
});

test('tag counts include only unarchived assigned papers and definitions survive when unused', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    db.applySnapshots([
      snapshot([
        paper(),
        source('PAPER002', {
          itemType: 'book',
          title: 'Second',
          creators: [],
          tags: [],
          collections: [],
        }),
      ]),
    ]);
    db.patchPaper(paperId, { tags: ['domain/climate'] });
    db.patchPaper('lib:PAPER002', { tags: ['domain/climate'] });
    db.patchPaper('lib:PAPER002', { archived: true });
    db.createTag({ name: 'unused', description: 'Keep me' });
    assert.equal(db.library().tags.find((tag) => tag.name === 'domain/climate')?.paperCount, 1);
    assert.equal(db.library().tags.find((tag) => tag.name === 'unused')?.paperCount, 0);
    db.patchPaper(paperId, { tags: [] });
    assert.equal(db.library().tags.find((tag) => tag.name === 'domain/climate')?.paperCount, 0);
  } finally {
    db.close();
  }
});

test('tag descriptions persist after reopening the database', () => {
  const dir = temporaryDirectory();
  const path = join(dir, 'atlas.sqlite');
  try {
    let db = new AtlasDatabase(path);
    const tag = db.createTag({ name: 'data/survey', description: 'Collected responses' });
    db.close();
    db = new AtlasDatabase(path);
    assert.equal(
      db.library().tags.find((item) => item.id === tag.id)?.description,
      'Collected responses',
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tag names, descriptions, and assignment lists enforce limits and updates are atomic', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    db.applySnapshots([snapshot()]);
    db.patchPaper(paperId, { status: 'reading', tags: ['method/valid'] });
    assert.throws(() => db.createTag({ name: `x${'a'.repeat(120)}` }));
    assert.throws(() => db.createTag({ name: 'ok', description: 'x'.repeat(281) }));
    assert.throws(() =>
      db.patchPaper(paperId, { status: 'read', tags: ['valid', 'x'.repeat(121)] }),
    );
    assert.deepEqual(db.paper(paperId)!.tags, ['method/valid']);
    assert.equal(db.paper(paperId)!.status, 'reading');
    assert.throws(() =>
      db.patchPaper(paperId, { tags: Array.from({ length: 101 }, (_, i) => `tag-${i}`) }),
    );
    assert.deepEqual(db.paper(paperId)!.tags, ['method/valid']);
    assert.throws(() => db.createTag({ name: '   ' }));
  } finally {
    db.close();
  }
});

test('tag description patch changes only Atlas metadata and missing identifiers return null', () => {
  const db = new AtlasDatabase(':memory:');
  try {
    const tag = db.createTag({ name: 'model/bert' });
    const changed = db.patchTag(tag.id, { description: 'Language model' });
    assert.equal(changed?.description, 'Language model');
    assert.equal(changed?.category, 'model');
    assert.equal(db.patchTag('missing', { description: 'x' }), null);
  } finally {
    db.close();
  }
});
