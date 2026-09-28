import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { AssistantService } from '../server/assistant-service.ts';

const paperId = 'lib:PAPER001';
const otherPaperId = 'lib:PAPER002';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-service-'));
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
          title: 'Climate methods',
          abstractNote: 'Repeated climate observations.',
          creators: [],
          tags: [],
          collections: [],
        },
      },
      {
        key: 'PAPER002',
        data: {
          itemType: 'journalArticle',
          title: 'Optics methods',
          abstractNote: 'Laser optics measurements.',
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
    summary: 'Study climate evidence',
    paperIds: [paperId],
  });
  const otherProject = projects.create({
    name: 'Optics project',
    summary: 'Study optics evidence',
  });
  const service = new AssistantService(db, projects);
  service.retrieval.refresh();
  const run = service.retrieval.begin(
    'Review and recommend climate papers',
    'test assistant',
    'local-model',
  );
  const source = (sourceId: string) =>
    service.retrieval.retrieve(run.runId, { sourceId }).evidence[0];
  return {
    db,
    projects,
    project,
    otherProject,
    service,
    run,
    source,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function proposal(
  runId: string,
  kind: 'review' | 'tags' | 'recommendation' | 'note' | 'profile',
  citationIds: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    runId,
    kind,
    title: 'Assistant proposal',
    body: 'Evidence-based draft',
    citationIds,
    ...extra,
  } as Parameters<AssistantService['submit']>[0];
}

test('service rejects forged, cross-run, and stale citations', () => {
  const f = fixture();
  try {
    const evidence = f.source(`paper:${paperId}`);
    assert.throws(
      () => f.service.submit(proposal(f.run.runId, 'review', ['forged'], { paperId })),
      /not retrieved in this run/,
    );
    const otherRun = f.service.retrieval.begin('Other task', 'test assistant', 'local-model');
    assert.throws(
      () => f.service.submit(proposal(otherRun.runId, 'review', [evidence.chunkId], { paperId })),
      /not retrieved in this run/,
    );
    f.db.patchPaper(paperId, { summary: 'New human summary' });
    assert.throws(
      () => f.service.submit(proposal(f.run.runId, 'review', [evidence.chunkId], { paperId })),
      /source changed/,
    );
    assert.equal(f.service.store.list().length, 0);
  } finally {
    f.cleanup();
  }
});

test('reviews need target primary evidence, while notes and recommendations need their project context', () => {
  const f = fixture();
  try {
    const paper = f.source(`paper:${paperId}`);
    const unrelated = f.source(`paper:${otherPaperId}`);
    const project = f.source(`project:${f.project.id}`);
    const otherProject = f.source(`project:${f.otherProject.id}`);
    assert.throws(
      () =>
        f.service.submit(
          proposal(f.run.runId, 'review', [f.run.taskEvidence.chunkId], { paperId }),
        ),
      /primary evidence/,
    );
    assert.throws(
      () => f.service.submit(proposal(f.run.runId, 'review', [unrelated.chunkId], { paperId })),
      /primary evidence/,
    );
    const review = f.service.submit(proposal(f.run.runId, 'review', [paper.chunkId], { paperId }));
    assert.equal(review.kind, 'review');
    assert.deepEqual(review.agent, { name: 'test assistant', model: 'local-model' });
    assert.throws(
      () =>
        f.service.submit(
          proposal(f.run.runId, 'note', [paper.chunkId], { projectId: f.project.id }),
        ),
      /project context/,
    );
    assert.throws(
      () =>
        f.service.submit(
          proposal(f.run.runId, 'note', [otherProject.chunkId], { projectId: f.project.id }),
        ),
      /project context/,
    );
    assert.equal(
      f.service.submit(
        proposal(f.run.runId, 'note', [project.chunkId], { projectId: f.project.id }),
      ).kind,
      'note',
    );
    assert.throws(
      () =>
        f.service.submit(
          proposal(f.run.runId, 'recommendation', [paper.chunkId], {
            paperId,
            projectId: f.project.id,
            level: 'essential',
          }),
        ),
      /project context/,
    );
    assert.throws(
      () =>
        f.service.submit(
          proposal(f.run.runId, 'recommendation', [project.chunkId], {
            paperId,
            projectId: f.project.id,
            level: 'essential',
          }),
        ),
      /recommended paper/,
    );
    assert.equal(
      f.service.submit(
        proposal(f.run.runId, 'recommendation', [paper.chunkId, project.chunkId], {
          paperId,
          projectId: f.project.id,
          level: 'essential',
        }),
      ).kind,
      'recommendation',
    );
  } finally {
    f.cleanup();
  }
});

test('external recommendations use canonical indexed Crossref metadata', async () => {
  const f = fixture();
  try {
    const candidate = {
      title: 'External climate result',
      authors: ['A Author'],
      year: '2026',
      doi: '10.1234/EXAMPLE',
      url: 'https://doi.org/10.1234%2FEXAMPLE',
      abstract: 'Published abstract',
    };
    const fetcher = (async (url: URL) => {
      assert.equal(url.origin, 'https://api.crossref.org');
      return Response.json({
        message: {
          items: [
            {
              DOI: candidate.doi,
              title: [candidate.title],
              author: [{ given: 'A', family: 'Author' }],
              published: { 'date-parts': [[2026]] },
              abstract: '<p>Published abstract</p>',
            },
          ],
        },
      });
    }) as typeof fetch;
    const found = await f.service.findPapers(f.run.runId, 'climate methods', 1, fetcher);
    assert.equal(found.results.length, 1);
    const external = found.results[0].evidence[0];
    const project = f.source(`project:${f.project.id}`);
    assert.throws(
      () =>
        f.service.submit(
          proposal(f.run.runId, 'recommendation', [project.chunkId], {
            projectId: f.project.id,
            level: 'recommended',
            candidate,
          }),
        ),
      /atlas_find_papers/,
    );
    const forged = { ...candidate, title: 'Invented title', abstract: 'Invented claim' };
    const saved = f.service.submit(
      proposal(f.run.runId, 'recommendation', [external.chunkId, project.chunkId], {
        projectId: f.project.id,
        level: 'recommended',
        candidate: forged,
      }),
    );
    assert.equal(saved.candidate?.title, candidate.title);
    assert.equal(saved.candidate?.abstract.trim(), candidate.abstract);
    assert.equal(saved.paperId, null);
    assert.equal(f.db.library().papers.length, 2);
  } finally {
    f.cleanup();
  }
});

test('same-run requestKey retries return one record without replacing its content', () => {
  const f = fixture();
  try {
    const paper = f.source(`paper:${paperId}`);
    const first = f.service.submit(
      proposal(f.run.runId, 'review', [paper.chunkId], {
        paperId,
        body: 'Original review',
        requestKey: 'review-1',
      }),
    );
    f.db.patchPaper(paperId, { summary: 'A human edit after the first successful submission' });
    const retry = f.service.submit(
      proposal(f.run.runId, 'review', [paper.chunkId], {
        paperId,
        body: 'Changed draft on retry',
        requestKey: 'review-1',
      }),
    );
    assert.deepEqual(retry, first);
    assert.equal(f.service.store.list().length, 1);
    const anotherRun = f.service.retrieval.begin(
      'Separate review',
      'test assistant',
      'local-model',
    );
    const otherEvidence = f.service.retrieval.retrieve(anotherRun.runId, {
      sourceId: `paper:${paperId}`,
    }).evidence[0];
    const second = f.service.submit(
      proposal(anotherRun.runId, 'review', [otherEvidence.chunkId], {
        paperId,
        body: 'Separate run',
        requestKey: 'review-1',
      }),
    );
    assert.notEqual(second.id, first.id);
  } finally {
    f.cleanup();
  }
});
