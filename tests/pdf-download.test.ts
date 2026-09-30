import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadPublicPdf, type PdfDownloadDependencies } from '../server/zotero-write.ts';
import { PdfDownloadCache } from '../server/pdf-download-cache.ts';
const pdf = Buffer.from('%PDF-1.7\nDownloaded paper');
const base: Partial<PdfDownloadDependencies> = {
  resolve: async () => [{ address: '8.8.8.8', family: 4 }],
  pause: async () => {},
};
test('download retries a failed address automatically and prefers IPv4 over IPv6', async () => {
  const addresses: string[] = [];
  const bytes = await downloadPublicPdf('https://repository.example/paper.pdf', {
    ...base,
    resolve: async () => [
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ],
    request: async (_url, address, timeout) => {
      addresses.push(address.address);
      assert.ok(timeout > 60000);
      if (addresses.length === 1) throw new Error('Connection timed out');
      return { status: 200, data: pdf };
    },
  });
  assert.deepEqual(bytes, pdf);
  assert.deepEqual(addresses, ['8.8.8.8', '2001:4860:4860::8888']);
});
test('transient HTTP errors retry but denied access does not', async () => {
  let calls = 0;
  assert.deepEqual(
    await downloadPublicPdf('https://repository.example/paper.pdf', {
      ...base,
      request: async () => (++calls === 1 ? { status: 503 } : { status: 200, data: pdf }),
    }),
    pdf,
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    downloadPublicPdf('https://repository.example/paper.pdf', {
      ...base,
      request: async () => {
        calls++;
        return { status: 403 };
      },
    }),
    /403/,
  );
  assert.equal(calls, 1);
});
test('redirect targets are revalidated and download attempts stop at the overall deadline', async () => {
  let requests = 0;
  await assert.rejects(
    downloadPublicPdf('https://repository.example/paper.pdf', {
      ...base,
      request: async () => {
        requests++;
        return { status: 302, location: 'https://localhost/private.pdf' };
      },
    }),
    /public HTTPS/,
  );
  assert.equal(requests, 1);
  let now = 0;
  requests = 0;
  await assert.rejects(
    downloadPublicPdf('https://repository.example/paper.pdf', {
      ...base,
      now: () => now,
      request: async () => {
        requests++;
        now += 240001;
        throw new Error('timeout');
      },
    }),
    /automatic retries/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    downloadPublicPdf('https://repository.example/paper.pdf', {
      ...base,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      request: async () => {
        throw new Error('must not request');
      },
    }),
    /non-public/,
  );
});
test('verified byte cache is bounded, expires entries and isolates stored buffers', () => {
  const cache = new PdfDownloadCache(5);
  const original = Buffer.from('abc');
  const first = cache.put(original);
  original[0] = 0;
  assert.equal(cache.get(first)?.toString(), 'abc');
  const second = cache.put(Buffer.from('def'));
  assert.equal(cache.get(first), null);
  assert.equal(cache.get(second)?.toString(), 'def');
  const expired = new PdfDownloadCache(5, -1);
  const key = expired.put(Buffer.from('abc'));
  assert.equal(expired.get(key), null);
});
