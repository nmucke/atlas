import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { AssistantStore } from '../server/assistant-store.ts';
import { Retrieval, chunkText } from '../server/retrieval.ts';

const firstPaper = 'lib:PAPER001';
const secondPaper = 'lib:PAPER002';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-retrieval-'));
  const db = new AtlasDatabase(join(dir, 'atlas.sqlite'));
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
          title: 'Climate measurement',
          abstractNote: 'Climate calibration uses repeated observations.',
          creators: [],
          tags: [],
          collections: [],
        },
      },
      {
        key: 'PAPER002',
        data: {
          itemType: 'journalArticle',
          title: 'Unrelated optics',
          abstractNote: 'Quantum optics uses lasers.',
          creators: [],
          tags: [],
          collections: [],
        },
      },
    ],
  };
  db.applySnapshots([snapshot]);
  const projects = new ProjectStore(db.db);
  const project = projects.create({
    name: 'Climate project',
    summary: 'Climate research',
    paperIds: [firstPaper],
  });
  projects.createNote(project.id, { title: 'Methods', body: 'Calibration notes' });
  const assistant = new AssistantStore(db.db);
  const retrieval = new Retrieval(db, projects, assistant);
  return {
    db,
    projects,
    project,
    assistant,
    retrieval,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('chunking overlaps adjacent text and handles empty input', () => {
  assert.deepEqual(chunkText('abcdefghij', 6, 2), ['abcdef', 'efghij']);
  assert.deepEqual(chunkText(''), ['']);
  assert.throws(() => chunkText('abc', 2, 2), /Invalid chunk size/);
});

test('retrieval scopes project and paper evidence and paginates deterministically', () => {
  const f = fixture();
  try {
    const { runId } = f.retrieval.begin('Review climate project', 'assistant', 'local-model');
    const project = f.retrieval.retrieve(runId, { projectId: f.project.id, limit: 30 });
    assert.ok(project.evidence.some((item) => item.sourceId === `paper:${firstPaper}`));
    assert.ok(project.evidence.some((item) => item.sourceId === `project:${f.project.id}`));
    assert.ok(project.evidence.some((item) => item.sourceId.startsWith('note:')));
    assert.equal(
      project.evidence.some((item) => item.sourceId === `paper:${secondPaper}`),
      false,
    );
    const paper = f.retrieval.retrieve(runId, { paperId: firstPaper });
    assert.ok(paper.evidence.every((item) => item.paperId === firstPaper));
    assert.equal(
      paper.evidence.some((item) => item.sourceId.startsWith('project:')),
      false,
    );
    const first = f.retrieval.retrieve(runId, { projectId: f.project.id, limit: 1, offset: 0 });
    assert.equal(first.nextOffset, 1);
    const second = f.retrieval.retrieve(runId, { projectId: f.project.id, limit: 1, offset: 1 });
    assert.notEqual(first.evidence[0].chunkId, second.evidence[0].chunkId);
    assert.throws(() => f.retrieval.retrieve(runId, { limit: 31 }), /pagination/);
    assert.throws(() => f.retrieval.retrieve(runId, { offset: -1 }), /pagination/);
  } finally {
    f.cleanup();
  }
});

test('FTS search treats hostile syntax as text and keeps the index intact', () => {
  const f = fixture();
  try {
    const { runId } = f.retrieval.begin('Find climate methods', 'assistant', 'local-model');
    const normal = f.retrieval.retrieve(runId, { query: 'climate', limit: 30 });
    assert.ok(normal.evidence.some((item) => item.sourceId === `paper:${firstPaper}`));
    const hostile = f.retrieval.retrieve(runId, {
      query: '" OR 1=1); DROP TABLE rag_chunks; --',
      limit: 30,
    });
    assert.ok(Array.isArray(hostile.evidence));
    assert.ok(f.retrieval.status().chunks > 0);
    assert.throws(() => f.retrieval.retrieve(runId, { query: '***' }), /search term/);
  } finally {
    f.cleanup();
  }
});

test('citations require evidence from the same run and reject stale documents', () => {
  const f = fixture();
  try {
    const a = f.retrieval.begin('Review climate', 'assistant', 'local-model');
    const b = f.retrieval.begin('Review optics', 'assistant', 'local-model');
    const evidence = f.retrieval.retrieve(a.runId, { sourceId: `paper:${firstPaper}` }).evidence[0];
    assert.equal(f.retrieval.citations(a.runId, [evidence.chunkId])[0].chunkId, evidence.chunkId);
    assert.throws(
      () => f.retrieval.citations(b.runId, [evidence.chunkId]),
      /not retrieved in this run/,
    );
    assert.equal(f.retrieval.citations(b.runId, [b.taskEvidence.chunkId])[0].kind, 'request');
    f.db.patchPaper(firstPaper, { summary: 'New human summary' });
    assert.throws(() => f.retrieval.citations(a.runId, [evidence.chunkId]), /source changed/);
    assert.throws(() => f.retrieval.citations('not-a-run', [evidence.chunkId]), /Unknown run/);
  } finally {
    f.cleanup();
  }
});
