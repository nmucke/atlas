import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIRecord } from '../shared/assistant.ts';
import { readingRecommendations } from '../shared/recommendations.ts';

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
