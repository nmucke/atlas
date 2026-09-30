import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { AssistantStore } from '../server/assistant-store.ts';
import type { AIRecordInput, Citation } from '../shared/assistant.ts';

const paperId = 'lib:PAPER001';
const citation: Citation = {
  chunkId: 'chunk-1',
  sourceId: `paper:${paperId}`,
  title: 'Evidence',
  quote: 'Observed result',
  page: 2,
  hash: 'a'.repeat(64),
};
const agent = { name: 'Atlas assistant', model: 'local-model' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-assistant-'));
  const path = join(dir, 'atlas.sqlite');
  const db = new AtlasDatabase(path);
  const snapshot: Snapshot = {
    id: 'lib',
    name: 'Library',
    prefix: '/users/0',
    serverId: null,
    collections: [],
    items: [
      {
        key: 'PAPER001',
        data: {
          itemType: 'journalArticle',
          title: 'Evidence',
          creators: [],
          tags: [{ tag: 'method/source' }],
          collections: [],
        },
      },
    ],
  };
  db.applySnapshots([snapshot]);
  const projects = new ProjectStore(db.db);
  const project = projects.create({ name: 'Human project', summary: 'Human summary' });
  const humanNote = projects.createNote(project.id, { title: 'Human note', body: 'Keep this' })!;
  const assistant = new AssistantStore(db.db);
  return {
    db,
    projects,
    project,
    humanNote,
    assistant,
    path,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function input(kind: AIRecordInput['kind'], overrides: Partial<AIRecordInput> = {}): AIRecordInput {
  return {
    kind,
    title: 'Proposal',
    body: 'A grounded proposal',
    agent,
    citations: [citation],
    ...overrides,
  };
}

test('v4 migration preserves human work and runs once across reopen', () => {
  const f = fixture();
  try {
    const human = f.projects
      .detail(f.project.id)!
      .notes.find((note) => note.id === f.humanNote.id)!;
    assert.equal(human.authorType, 'human');
    assert.equal(human.aiRecordId, null);
    assert.equal(human.body, 'Keep this');
    assert.equal(f.projects.detail(f.project.id)!.project.summary, 'Human summary');
    assert.deepEqual(f.db.paper(paperId)?.zoteroTags, ['method/source']);
    assert.equal(
      (
        f.db.db
          .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=4')
          .get() as { count: number }
      ).count,
      1,
    );
    new AssistantStore(f.db.db);
    assert.equal(
      (
        f.db.db
          .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=4')
          .get() as { count: number }
      ).count,
      1,
    );
    assert.equal(f.assistant.list().length, 0);
  } finally {
    f.cleanup();
  }
});

test('reading score migration preserves existing reviews and human summaries', () => {
  const f = fixture();
  try {
    f.db.patchPaper(paperId, { summary: 'Human summary to preserve' });
    const saved = f.assistant.submit(input('review', { paperId }));
    f.db.db.exec('ALTER TABLE ai_records DROP COLUMN reading_recommendation_json');
    f.db.db.exec('DELETE FROM schema_migrations WHERE version=6');
    const migrated = new AssistantStore(f.db.db);
    assert.deepEqual(
      migrated.list().find((record) => record.id === saved.id),
      saved,
    );
    assert.equal(f.db.paper(paperId)?.summary, 'Human summary to preserve');
  } finally {
    f.cleanup();
  }
});

test('legacy review scores appear without rewriting saved reviews and structured scores take precedence', () => {
  const f = fixture();
  try {
    const body = 'Reading recommendation: 4/5 (recommended). Relevant to the research profile.';
    const legacy = f.assistant.submit(input('review', { paperId, body }));
    assert.deepEqual(
      f.assistant.list().find((record) => record.id === legacy.id)?.readingRecommendation,
      { score: 4, reason: 'Relevant to the research profile.' },
    );
    const raw = f.db.db
      .prepare('SELECT body, reading_recommendation_json FROM ai_records WHERE id=?')
      .get(legacy.id);
    assert.equal(raw?.body, body);
    assert.equal(raw?.reading_recommendation_json, null);
    const modern = f.assistant.submit(
      input('review', {
        paperId,
        body,
        readingRecommendation: { score: 2, reason: 'Updated assessment.' },
      }),
    );
    assert.equal(modern.readingRecommendation?.score, 2);
  } finally {
    f.cleanup();
  }
});

test('reading scores validate their range, explanation, and record kind', () => {
  const f = fixture();
  try {
    for (const score of [0, 6, 2.5, NaN]) {
      assert.throws(
        () =>
          f.assistant.submit(
            input('review', {
              paperId,
              readingRecommendation: { score, reason: 'Rationale' },
            }),
          ),
        /integer from 1 to 5/,
      );
    }
    assert.throws(
      () =>
        f.assistant.submit(
          input('review', {
            paperId,
            readingRecommendation: { score: 3, reason: '   ' },
          }),
        ),
      /reading recommendation reason/,
    );
    assert.throws(
      () =>
        f.assistant.submit(
          input('profile', {
            readingRecommendation: { score: 3, reason: 'Rationale' },
          }),
        ),
      /belong in paper reviews/,
    );
    const legacy = f.assistant.submit(input('review', { paperId }));
    assert.equal(legacy.readingRecommendation, null);
    const saved = f.assistant.submit(
      input('review', {
        paperId,
        readingRecommendation: { score: 1, reason: 'Outside the research scope.' },
      }),
    );
    const reopened = new AssistantStore(f.db.db);
    assert.deepEqual(
      reopened.list().find((record) => record.id === saved.id)?.readingRecommendation,
      {
        score: 1,
        reason: 'Outside the research scope.',
      },
    );
  } finally {
    f.cleanup();
  }
});

test('tag proposals remain pending until approval, then add Atlas assignments without changing source tags', () => {
  const f = fixture();
  try {
    f.db.createTag({ name: 'method/known', description: 'Human definition' });
    f.db.patchPaper(paperId, { tags: ['method/human'] });
    const proposed = f.assistant.submit(
      input('tags', {
        paperId,
        projectId: f.project.id,
        tags: [
          { name: 'method/known', description: 'AI replacement' },
          { name: 'task/new', description: 'AI proposal' },
        ],
      }),
    );
    assert.equal(proposed.status, 'pending');
    assert.deepEqual(f.db.paper(paperId)?.tags, ['method/human']);
    assert.deepEqual(f.projects.detail(f.project.id)?.project.tags, []);
    const approved = f.assistant.decide(proposed.id, true)!;
    assert.equal(approved.status, 'approved');
    assert.ok(approved.decidedAt);
    assert.deepEqual(
      new Set(f.db.paper(paperId)?.tags),
      new Set(['method/human', 'method/known', 'task/new']),
    );
    assert.deepEqual(
      new Set(f.projects.detail(f.project.id)?.project.tags),
      new Set(['method/known', 'task/new']),
    );
    assert.equal(
      f.db.library().tags.find((tag) => tag.name === 'method/known' && tag.origin === 'atlas')
        ?.description,
      'Human definition',
    );
    assert.deepEqual(f.db.paper(paperId)?.zoteroTags, ['method/source']);
    assert.deepEqual(f.assistant.decide(proposed.id, true), approved);
    assert.throws(() => f.assistant.decide(proposed.id, false), /already decided/);
  } finally {
    f.cleanup();
  }
});

test('global tag proposals create vocabulary definitions without paper or project assignments', () => {
  const f = fixture();
  try {
    const proposed = f.assistant.submit(
      input('tags', {
        tags: [{ name: 'domain/new-field', description: 'New research domain' }],
      }),
    );
    assert.equal(
      f.db.library().tags.some((tag) => tag.name === 'domain/new-field'),
      false,
    );
    f.assistant.decide(proposed.id, true);
    assert.equal(
      f.db.library().tags.find((tag) => tag.name === 'domain/new-field' && tag.origin === 'atlas')
        ?.description,
      'New research domain',
    );
    assert.deepEqual(f.db.paper(paperId)?.tags, []);
    assert.deepEqual(f.projects.detail(f.project.id)?.project.tags, []);
  } finally {
    f.cleanup();
  }
});

test('AI reviews stay separate and rejected proposals never touch human fields', () => {
  const f = fixture();
  try {
    f.db.patchPaper(paperId, { summary: 'Human paper summary', notes: 'Human paper notes' });
    const review = f.assistant.submit(input('review', { paperId, title: 'Independent review' }));
    assert.equal(f.assistant.list({ kind: 'review', paperId }).length, 1);
    assert.equal(f.db.paper(paperId)?.summary, 'Human paper summary');
    assert.equal(f.assistant.decide(review.id, true)?.status, 'approved');
    assert.equal(f.db.paper(paperId)?.notes, 'Human paper notes');
    const rejected = f.assistant.submit(
      input('tags', {
        paperId,
        tags: [{ name: 'method/rejected', description: 'A proposed method' }],
      }),
    );
    assert.equal(f.assistant.decide(rejected.id, false)?.status, 'rejected');
    assert.equal(
      f.db.library().tags.some((tag) => tag.name === 'method/rejected'),
      false,
    );
    assert.equal(f.assistant.list({ status: 'rejected' }).length, 1);
  } finally {
    f.cleanup();
  }
});

test('recommendation approval links existing papers without resetting state; external candidates stay separate', () => {
  const f = fixture();
  try {
    f.db.patchPaper(paperId, { status: 'read', archived: true });
    const linked = f.assistant.submit(
      input('recommendation', {
        paperId,
        projectId: f.project.id,
        level: 'essential',
      }),
    );
    assert.deepEqual(f.projects.detail(f.project.id)?.project.paperIds, []);
    f.assistant.decide(linked.id, true);
    assert.deepEqual(f.projects.detail(f.project.id)?.project.paperIds, [paperId]);
    assert.equal(f.db.paper(paperId)?.status, 'read');
    assert.equal(f.db.paper(paperId)?.archived, true);
    const before = f.db.library().papers.length;
    const external = f.assistant.submit(
      input('recommendation', {
        projectId: f.project.id,
        level: 'optional',
        candidate: {
          title: 'External work',
          authors: ['A Author'],
          year: '2026',
          doi: '10.1/example',
          url: 'https://example.org/paper',
          abstract: 'Abstract',
        },
      }),
    );
    f.assistant.decide(external.id, true);
    assert.equal(f.db.library().papers.length, before);
    assert.deepEqual(f.projects.detail(f.project.id)?.project.paperIds, [paperId]);
    assert.equal(f.assistant.list({ kind: 'recommendation', projectId: f.project.id }).length, 2);
  } finally {
    f.cleanup();
  }
});

test('approved AI note records provenance and leaves human notes editable', () => {
  const f = fixture();
  try {
    const proposed = f.assistant.submit(
      input('note', {
        projectId: f.project.id,
        title: 'AI synthesis',
        body: 'Evidence-based note',
      }),
    );
    assert.equal(f.projects.detail(f.project.id)?.notes.length, 1);
    f.assistant.decide(proposed.id, true);
    const detail = f.projects.detail(f.project.id)!;
    assert.equal(detail.notes.length, 2);
    const aiNote = detail.notes.find((note) => note.aiRecordId === proposed.id)!;
    assert.equal(aiNote.authorType, 'ai');
    assert.equal(aiNote.body, 'Evidence-based note');
    assert.equal(aiNote.folder, 'AI notes');
    assert.equal(detail.notes.find((note) => note.id === f.humanNote.id)?.body, 'Keep this');
    assert.equal(
      f.projects.patchNote(f.project.id, f.humanNote.id, { body: 'Human revised' })?.body,
      'Human revised',
    );
    assert.equal(f.assistant.list({ kind: 'note' })[0].citations[0].sourceId, `paper:${paperId}`);
    f.assistant.decide(proposed.id, true);
    assert.equal(f.projects.detail(f.project.id)?.notes.length, 2);
  } finally {
    f.cleanup();
  }
});

test('human profile setting and approved AI proposal update profile explicitly', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.assistant.getProfile(), { text: '', updatedAt: null });
    assert.equal(f.assistant.setProfile('Climate methods').text, 'Climate methods');
    const proposed = f.assistant.submit(
      input('profile', {
        title: 'Refined profile',
        body: 'Climate methods and evaluation',
        citations: [],
      }),
    );
    assert.equal(f.assistant.getProfile().text, 'Climate methods');
    f.assistant.decide(proposed.id, false);
    assert.equal(f.assistant.getProfile().text, 'Climate methods');
    const accepted = f.assistant.submit(
      input('profile', {
        title: 'Refined profile',
        body: 'Climate methods and evaluation',
        citations: [],
      }),
    );
    f.assistant.decide(accepted.id, true);
    assert.equal(f.assistant.getProfile().text, 'Climate methods and evaluation');
    assert.ok(f.assistant.getProfile().updatedAt);
  } finally {
    f.cleanup();
  }
});

test('submission validation rejects malformed evidence, targets, and recommendation shapes atomically', () => {
  const f = fixture();
  try {
    const count = f.assistant.list().length;
    assert.throws(
      () => f.assistant.submit(input('review', { paperId, citations: [] })),
      /Evidence citations/,
    );
    assert.throws(
      () =>
        f.assistant.submit(input('review', { paperId, citations: [{ ...citation, hash: 'bad' }] })),
      /SHA-256/,
    );
    assert.throws(
      () => f.assistant.submit(input('review', { paperId, citations: [{ ...citation, page: 0 }] })),
      /Citation page/,
    );
    assert.throws(() =>
      f.assistant.submit(
        input('tags', { paperId, tags: [{ name: 'bad//name', description: '' }] }),
      ),
    );
    assert.throws(
      () => f.assistant.submit(input('note', { projectId: 'missing' })),
      /Unknown projectId/,
    );
    assert.throws(
      () => f.assistant.submit(input('review', { paperId: 'missing' })),
      /Unknown paperId/,
    );
    assert.throws(
      () => f.assistant.submit(input('recommendation', { level: 'optional' })),
      /either a paperId or candidate/,
    );
    assert.throws(
      () =>
        f.assistant.submit(
          input('recommendation', {
            level: 'optional',
            candidate: {
              title: 'External',
              authors: [],
              year: '2026',
              doi: '',
              url: 'file:///tmp/x',
              abstract: '',
            },
          }),
        ),
      /Invalid candidate URL/,
    );
    assert.throws(
      () =>
        f.assistant.submit(
          input('review', { paperId, tags: [{ name: 'method/no', description: '' }] }),
        ),
      /separate tag proposal/,
    );
    assert.equal(f.assistant.list().length, count);
    assert.equal(f.assistant.decide('missing', true), null);
  } finally {
    f.cleanup();
  }
});
