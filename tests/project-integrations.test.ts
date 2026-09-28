import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { BetterBibTeX } from '../server/bibtex.ts';
import { decodeFigure, MAX_FIGURE_BYTES } from '../server/project-assets.ts';
import { isProjectFigure, noteUrl } from '../src/note-content.ts';

const personalId = 'server-A/users/0:PAPER001';
const groupId = 'server-A/groups/17:PAPER001';

function temporaryLibrary() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-bibtex-'));
  const db = new AtlasDatabase(join(dir, 'atlas.sqlite'));
  const makeSnapshot = (
    id: string,
    prefix: string,
    key: string,
    serverId: string | null = 'server-A',
  ): Snapshot => ({
    id,
    name: prefix,
    prefix,
    serverId,
    collections: [],
    items: [
      {
        key,
        data: { itemType: 'journalArticle', title: key, creators: [], tags: [], collections: [] },
      },
    ],
  });
  db.applySnapshots([
    makeSnapshot('server-A/users/0', '/users/0', 'PAPER001'),
    makeSnapshot('server-A/groups/17', '/groups/17', 'PAPER001'),
  ]);
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type RpcCall = { method: string; params: Record<string, unknown> };
function mockZotero(
  handler: (call: RpcCall) => unknown,
  serverId = 'server-A',
): { fetcher: typeof fetch; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'http://127.0.0.1:23119/api/')
      return new Response(null, { status: 200, headers: { 'Zotero-Server-ID': serverId } });
    assert.equal(String(url), 'http://127.0.0.1:23119/better-bibtex/json-rpc');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['Zotero-Allowed-Request'], 'true');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.jsonrpc, '2.0');
    const call = { method: request.method, params: request.params };
    calls.push(call);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: handler(call) });
  }) as typeof fetch;
  return { fetcher, calls };
}

function mappedItems(call: RpcCall) {
  if (call.method === 'user.groups') return [{ id: 1 }, { id: 17 }];
  if (call.method === 'item.search') {
    const terms = call.params.terms as unknown[][];
    assert.deepEqual(terms.slice(1), [
      ['itemType', 'isNot', 'attachment'],
      ['itemType', 'isNot', 'note'],
      ['itemType', 'isNot', 'annotation'],
    ]);
    if (terms[0]?.[2] === 1)
      return [{ id: 'http://zotero.org/users/123/items/PAPER001', citekey: 'PersonalKey' }];
    if (terms[0]?.[2] === 17)
      return [{ id: 'http://zotero.org/groups/17/items/PAPER001', citekey: 'GroupKey' }];
  }
  if (call.method === 'item.export') {
    const keys = call.params.citekeys as string[];
    return keys.includes('PersonalKey') ? '@article{PersonalKey}' : '@article{GroupKey}';
  }
  throw new Error(`Unexpected RPC ${call.method}`);
}

test('Better BibTeX maps personal and group item URIs to the right library exports', async () => {
  const { db, cleanup } = temporaryLibrary();
  try {
    const { fetcher, calls } = mockZotero(mappedItems);
    const bib = await new BetterBibTeX(fetcher).export(db.db, [personalId, groupId]);
    assert.equal(bib, '@article{PersonalKey}\n\n@article{GroupKey}\n');
    assert.deepEqual(
      calls.filter((call) => call.method === 'item.export').map((call) => call.params),
      [
        { citekeys: ['PersonalKey'], translator: 'Better BibTeX', libraryID: 1 },
        { citekeys: ['GroupKey'], translator: 'Better BibTeX', libraryID: 17 },
      ],
    );
  } finally {
    cleanup();
  }
});

test('Better BibTeX rejects unavailable papers and a different Zotero database before RPC', async () => {
  const { db, cleanup } = temporaryLibrary();
  try {
    const { fetcher, calls } = mockZotero(mappedItems, 'server-B');
    const bib = new BetterBibTeX(fetcher);
    await assert.rejects(bib.export(db.db, []), /Link papers/);
    await assert.rejects(bib.export(db.db, ['missing']), /unavailable/);
    db.db.prepare('UPDATE source_items SET missing=1 WHERE id=?').run(personalId);
    await assert.rejects(bib.export(db.db, [personalId]), /unavailable/);
    db.db.prepare('UPDATE source_items SET missing=0 WHERE id=?').run(personalId);
    await assert.rejects(bib.export(db.db, [personalId]), /different Zotero database/);
    assert.deepEqual(calls, []);
  } finally {
    cleanup();
  }
});

test('Better BibTeX rejects missing, ambiguous, and duplicate citation keys', async () => {
  const { db, cleanup } = temporaryLibrary();
  try {
    const missing = mockZotero((call) => (call.method === 'user.groups' ? [{ id: 1 }] : []));
    await assert.rejects(
      new BetterBibTeX(missing.fetcher).export(db.db, [personalId]),
      /no Better BibTeX citation key/,
    );
    const ambiguous = mockZotero((call) => {
      if (call.method === 'user.groups') return [{ id: 1 }, { id: 2 }];
      return [{ id: 'http://zotero.org/users/123/items/PAPER001', citekey: 'SameItem' }];
    });
    await assert.rejects(
      new BetterBibTeX(ambiguous.fetcher).export(db.db, [personalId]),
      /ambiguous item identities/,
    );
    const duplicate = mockZotero((call) => {
      if (call.method === 'item.search') {
        const id = (call.params.terms as unknown[][])[0]?.[2];
        return id === 1
          ? [{ id: 'http://zotero.org/users/123/items/PAPER001', citekey: 'Duplicate' }]
          : [{ id: 'http://zotero.org/groups/17/items/PAPER001', citekey: 'Duplicate' }];
      }
      if (call.method === 'user.groups') return [{ id: 1 }, { id: 17 }];
      throw new Error('Export should not be called');
    });
    await assert.rejects(
      new BetterBibTeX(duplicate.fetcher).export(db.db, [personalId, groupId]),
      /Duplicate citation key/,
    );
    assert.equal(
      duplicate.calls.some((call) => call.method === 'item.export'),
      false,
    );
  } finally {
    cleanup();
  }
});

test('Better BibTeX reports RPC errors and empty exports', async () => {
  const { db, cleanup } = temporaryLibrary();
  try {
    const unavailable = new BetterBibTeX((async () => {
      throw new Error('offline');
    }) as typeof fetch);
    await assert.rejects(unavailable.rpc('user.groups'), /Cannot reach Better BibTeX/);
    const rpcError = new BetterBibTeX((async () =>
      Response.json({ error: { message: 'Translator failed' } })) as typeof fetch);
    await assert.rejects(rpcError.rpc('item.export'), /Translator failed/);
    const { fetcher } = mockZotero((call) =>
      call.method === 'item.export' ? '   ' : mappedItems(call),
    );
    await assert.rejects(
      new BetterBibTeX(fetcher).export(db.db, [personalId]),
      /empty bibliography/,
    );
  } finally {
    cleanup();
  }
});

test('figure decoding accepts matching raster signatures and rejects malformed uploads', () => {
  const fixtures = [
    { contentType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    { contentType: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 0]) },
    { contentType: 'image/gif', bytes: Buffer.from('GIF89a', 'ascii') },
    { contentType: 'image/webp', bytes: Buffer.from('RIFFxxxxWEBP', 'ascii') },
  ];
  for (const { contentType, bytes } of fixtures) {
    const decoded = decodeFigure({
      filename: 'figure.png',
      contentType,
      data: bytes.toString('base64'),
    });
    assert.equal(decoded.contentType, contentType);
    assert.deepEqual(decoded.data, bytes);
  }
  assert.equal(
    decodeFigure({
      filename: '../figure\n.png',
      contentType: 'image/png',
      data: fixtures[0].bytes.toString('base64'),
    }).filename,
    '.._figure_.png',
  );
  for (const data of ['!!!', 'a', 'A===', 'YWJj\n', ''])
    assert.throws(() => decodeFigure({ filename: 'bad.png', contentType: 'image/png', data }));
  assert.throws(
    () =>
      decodeFigure({
        filename: 'bad.png',
        contentType: 'image/jpeg',
        data: fixtures[0].bytes.toString('base64'),
      }),
    /must match/,
  );
  assert.throws(() =>
    decodeFigure({
      filename: 'bad.svg',
      contentType: 'image/svg+xml',
      data: fixtures[0].bytes.toString('base64'),
    }),
  );
  assert.throws(() =>
    decodeFigure({
      filename: 'x'.repeat(256),
      contentType: 'image/png',
      data: fixtures[0].bytes.toString('base64'),
    }),
  );
  const largest = Buffer.alloc(MAX_FIGURE_BYTES);
  fixtures[0].bytes.copy(largest);
  assert.equal(
    decodeFigure({
      filename: 'max.png',
      contentType: 'image/png',
      data: largest.toString('base64'),
    }).data.length,
    MAX_FIGURE_BYTES,
  );
  const tooLarge = Buffer.concat([largest, Buffer.from([0])]);
  assert.throws(
    () =>
      decodeFigure({
        filename: 'large.png',
        contentType: 'image/png',
        data: tooLarge.toString('base64'),
      }),
    /8 MB/,
  );
});

test('note URLs permit only same-project figure assets and safe external links', () => {
  const figure = '/api/projects/project-1/assets/asset-2';
  assert.equal(isProjectFigure(figure, 'project-1'), true);
  assert.equal(noteUrl(figure, 'project-1', true), figure);
  for (const url of [
    '/api/projects/project-2/assets/asset-2',
    `${figure}?download=1`,
    `${figure}#fragment`,
    'https://example.org/figure.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '/api/projects/project-1/assets/asset_2',
  ])
    assert.equal(noteUrl(url, 'project-1', true), '');
  assert.equal(
    noteUrl('https://example.org/paper', 'project-1', false),
    'https://example.org/paper',
  );
  assert.equal(noteUrl('#methods', 'project-1', false), '#methods');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative/path', '//example.org'])
    assert.equal(noteUrl(url, 'project-1', false), '');
});
