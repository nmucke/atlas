import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIRecord } from '../shared/assistant.ts';
import { latestPaperReview } from '../shared/paper-review.ts';

function record(
  id: string,
  createdAt: string,
  status: AIRecord['status'] = 'pending',
  kind: AIRecord['kind'] = 'review',
  paperId = 'paper-1',
): AIRecord {
  return { id, createdAt, status, kind, paperId } as AIRecord;
}

test('AI summary selects the latest non-rejected review for this paper', () => {
  const records = [
    record('older', '2026-01-01T00:00:00Z', 'approved'),
    record('unrelated', '2026-04-01T00:00:00Z', 'pending', 'review', 'paper-2'),
    record('tag', '2026-05-01T00:00:00Z', 'pending', 'tags'),
    record('rejected', '2026-03-01T00:00:00Z', 'rejected'),
    record('latest', '2026-02-01T00:00:00Z'),
  ];

  assert.equal(latestPaperReview(records, 'paper-1')?.id, 'latest');
  assert.equal(latestPaperReview(records, 'paper-3'), null);
  assert.deepEqual(
    records.map((item) => item.id),
    ['older', 'unrelated', 'tag', 'rejected', 'latest'],
  );
});
