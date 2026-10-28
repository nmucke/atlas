import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIRecord } from '../shared/assistant.ts';
import type { Project } from '../shared/types.ts';
import {
  projectFitsByPaper,
  readingRecommendations,
  readingTier,
} from '../shared/recommendations.ts';

function review(
  id: string,
  paperId: string,
  score: number,
  extra: Partial<AIRecord> = {},
): AIRecord {
  return {
    id,
    paperId,
    kind: 'review',
    projectId: null,
    title: 'Review',
    body: 'Summary',
    tags: [],
    level: null,
    candidate: null,
    agent: { name: 'Reviewer', model: 'Test' },
    citations: [],
    status: 'pending',
    createdAt: '2026-09-30T12:00:00Z',
    decidedAt: null,
    readingRecommendation: { score, reason: 'Reading rationale' },
    ...extra,
  };
}

test('recommendations show latest non-rejected assessment per paper, ordered by score including low scores', () => {
  const records = [
    review('old', 'a', 5, { createdAt: '2026-09-29T12:00:00Z' }),
    review('latest', 'a', 1),
    review('best', 'b', 4),
    review('rejected', 'c', 5, { status: 'rejected' }),
    review('legacy', 'd', 3, { readingRecommendation: null }),
    review('project', 'b', 4, { kind: 'recommendation', projectId: 'p' }),
  ];
  assert.deepEqual(
    readingRecommendations(records).map((record) => record.id),
    ['best', 'latest'],
  );
  assert.equal(records[0].id, 'old');
});

test('a rejected newest review dismisses the paper instead of resurrecting an older one', () => {
  const records = [
    review('old', 'a', 5, { createdAt: '2026-09-29T12:00:00Z' }),
    review('dismissed', 'a', 4, { status: 'rejected' }),
    review('kept-old', 'b', 3, { createdAt: '2026-09-29T12:00:00Z', status: 'rejected' }),
    review('kept', 'b', 2),
  ];
  assert.deepEqual(
    readingRecommendations(records).map((record) => record.id),
    ['kept'],
  );
});

test('reading tiers group 4–5, 3 and 1–2', () => {
  assert.deepEqual([5, 4, 3, 2, 1].map(readingTier), ['top', 'top', 'consider', 'low', 'low']);
});

function project(id: string, paperIds: string[] = []): Project {
  return {
    id,
    name: `Project ${id}`,
    summary: '',
    tags: [],
    githubUrl: '',
    overleafUrl: '',
    status: 'active',
    paperIds,
    noteCount: 0,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };
}

function fit(id: string, projectId: string, extra: Partial<AIRecord> = {}): AIRecord {
  return review(id, 'a', 0, {
    kind: 'recommendation',
    projectId,
    readingRecommendation: null,
    ...extra,
  });
}

test('project fits keep the latest suggestion per project, strongest first, and flag links', () => {
  const fits = projectFitsByPaper(
    [
      fit('p-old', 'p', { level: 'essential', createdAt: '2026-09-29T12:00:00Z' }),
      fit('p-new', 'p', { level: 'optional' }),
      fit('q', 'q', { level: 'essential', createdAt: '2026-09-28T12:00:00Z' }),
      fit('r-old', 'r', { level: 'essential', createdAt: '2026-09-29T12:00:00Z' }),
      fit('r-rejected', 'r', { status: 'rejected' }),
      fit('gone', 'missing', { level: 'recommended' }),
      fit('other-paper', 'p', { paperId: 'b' }),
      review('review', 'a', 5),
    ],
    [project('p'), project('q', ['a']), project('r')],
  );
  const forA = fits.get('a')!;
  assert.deepEqual(
    forA.map((item) => item.record.id),
    ['q', 'gone', 'p-new'],
  );
  assert.deepEqual(
    forA.map((item) => [item.project?.id ?? null, item.linked]),
    [
      ['q', true],
      [null, false],
      ['p', false],
    ],
  );
  assert.deepEqual(
    fits.get('b')!.map((item) => item.record.id),
    ['other-paper'],
  );
});
