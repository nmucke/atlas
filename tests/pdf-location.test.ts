import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfLocation } from '../server/pdf-location.ts';
const repository = {
  is_oa: true,
  pdf_url: 'https://repository.example.edu/paper.pdf',
  license: 'cc-by',
};
test('PDF discovery tries repositories when preferred metadata lacks a usable PDF', () => {
  for (const best of [
    null,
    { is_oa: true, pdf_url: null },
    { is_oa: true, pdf_url: 'invalid' },
    { is_oa: true, pdf_url: 'https://localhost/private.pdf' },
  ]) {
    assert.equal(
      pdfLocation({ best_oa_location: best, locations: [repository] })?.pdfUrl,
      repository.pdf_url,
    );
  }
});
test('PDF discovery preserves valid preferred sources, requires OA and upgrades HTTP to HTTPS', () => {
  assert.equal(
    pdfLocation({
      best_oa_location: repository,
      locations: [{ ...repository, pdf_url: 'https://other.example.edu/paper.pdf' }],
    })?.pdfUrl,
    repository.pdf_url,
  );
  assert.equal(pdfLocation({ locations: [{ ...repository, is_oa: false }] }), null);
  assert.equal(
    pdfLocation({
      locations: [{ ...repository, pdf_url: 'http://repository.example.edu/paper.pdf' }],
    })?.pdfUrl,
    repository.pdf_url,
  );
  assert.equal(
    pdfLocation({ locations: [{ ...repository, pdf_url: 'file:///private.pdf' }] }),
    null,
  );
});
