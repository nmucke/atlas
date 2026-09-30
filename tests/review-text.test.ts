import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyReadingRecommendation, readableReview } from '../shared/review-text.ts';

test('review text omits internal references without removing readable citations or Markdown', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  assert.equal(
    readableReview(
      `## Findings\n\nA finding [${first}]. More [${first}, ${second}].\n\n- Another [${second}]\n- Next`,
    ),
    '## Findings\n\nA finding. More.\n\n- Another\n- Next',
  );
  const readable = 'See [the paper](https://example.org), [1], and [Author, 2024].';
  assert.equal(readableReview(readable), readable);
});

test('legacy reading scores recover only a single explicit assessment with a rationale', () => {
  assert.deepEqual(
    legacyReadingRecommendation(
      'Summary\n\nReading recommendation: 4/5 (recommended). Relevant to data assimilation. Abstract only.\n\nProject fit: None.',
    ),
    {
      score: 4,
      reason: 'Relevant to data assimilation. Abstract only.',
    },
  );
  for (const body of [
    'Quality: 4/5. Good.',
    'Reading recommendation: 6/5. Great.',
    'Reading recommendation: 4/5',
    'Reading recommendation: 4/5. Good.\nReading recommendation: 2/5. Bad.',
  ]) {
    assert.equal(legacyReadingRecommendation(body), null);
  }
});
