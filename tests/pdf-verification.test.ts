import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPdfIdentity } from '../server/pdf-verification.ts';
const paper = {
  title: 'Diagnosis of observation, background and analysis-error statistics in observation space',
  doi: '10.1256/qj.05.108',
  author: 'Desroziers',
};
test('PDF identity requires both the title and DOI in the opening pages', () => {
  verifyPdfIdentity([paper.title, `Desroziers DOI ${paper.doi}`], paper);
  assert.throws(() => verifyPdfIdentity([paper.title, 'A different DOI'], paper), /DOI/);
  assert.throws(() => verifyPdfIdentity(['Unrelated title', paper.doi], paper), /title/);
  assert.throws(
    () => verifyPdfIdentity(['Unrelated title', '', paper.title + paper.doi], paper),
    /title/,
  );
});
test('papers without a DOI require title and author rather than accepting the filename', () => {
  verifyPdfIdentity([paper.title + ' Desroziers'], { ...paper, doi: '' });
  assert.throws(() => verifyPdfIdentity([paper.title], { ...paper, doi: '' }), /author/);
  assert.throws(() => verifyPdfIdentity([], paper), /title/);
});
