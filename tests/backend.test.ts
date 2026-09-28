import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AtlasDatabase, type Snapshot, type SourceItem } from '../server/database.ts';
import { ZoteroClient } from '../server/zotero.ts';
import { secureRequest } from '../server/http.ts';

const paperKey = 'PAPER001';
const attachmentKey = 'ATTACH01';
function source(key: string, data: Record<string, unknown>) {
  return { key, data };
}
function paper(title = 'A paper', version?: number) {
  return {
    ...source(paperKey, {
      itemType: 'journalArticle',
      title,
      creators: [],
      tags: [],
      collections: [],
    }),
    version,
  };
}
function snapshot(id = 'local/users/0', items: SourceItem[] = [paper()]): Snapshot {
  return { id, name: 'My Library', prefix: '/users/0', serverId: null, items, collections: [] };
}
function database() {
  return new AtlasDatabase(':memory:');
}
function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

test('new library snapshot imports papers into inbox', () => {
  const db = database();
  try {
    const result = db.applySnapshots([snapshot()]);
    assert.equal(result.imported, 1);
    const library = db.library();
    assert.equal(library.papers.length, 1);
    assert.equal(library.papers[0].id, `local/users/0:${paperKey}`);
    assert.equal(library.papers[0].status, 'inbox');
    assert.equal(library.papers[0].title, 'A paper');
  } finally {
    db.close();
  }
});

test('resync refreshes changed Zotero payload while preserving Atlas edits', () => {
  const db = database();
  try {
    db.applySnapshots([snapshot('local/users/0', [paper('A paper', 1)])]);
    const id = `local/users/0:${paperKey}`;
    db.patchPaper(id, {
      status: 'reading',
      starred: true,
      archived: true,
      summary: 'My summary',
      notes: 'My notes',
    });
    const result = db.applySnapshots([snapshot('local/users/0', [paper('Changed title', 1)])]);
    assert.deepEqual(result, { imported: 0, updated: 1 });
    const refreshed = db.paper(id)!;
    assert.equal(refreshed.title, 'Changed title');
    assert.equal(refreshed.status, 'reading');
    assert.equal(refreshed.starred, true);
    assert.equal(refreshed.archived, true);
    assert.equal(refreshed.summary, 'My summary');
    assert.equal(refreshed.notes, 'My notes');
  } finally {
    db.close();
  }
});

test('resync keeps papers absent from the returned snapshot', () => {
  const db = database();
  try {
    db.applySnapshots([
      snapshot('lib', [
        paper(),
        { ...source('PAPER002', { itemType: 'book', title: 'Also kept', creators: [] }) },
      ]),
    ]);
    db.applySnapshots([snapshot('lib')]);
    assert.deepEqual(
      db
        .library()
        .papers.map((p) => p.title)
        .sort(),
      ['A paper', 'Also kept'],
    );
    assert.equal(
      (db.library().papers.find((p) => p.zoteroKey === 'PAPER002') as any).sourceMissing,
      true,
    );
  } finally {
    db.close();
  }
});

test('failed snapshot transaction rolls back source and settings changes', () => {
  const db = database();
  try {
    db.applySnapshots([snapshot('lib')]);
    const before = db.paper(`lib:${paperKey}`)!.title;
    const invalid = snapshot('lib', [paper('Should roll back')]);
    invalid.collections = [
      source('COLLECT1', { name: 'One' }),
      source('COLLECT1', { name: 'Duplicate' }),
    ];
    assert.throws(() => db.applySnapshots([invalid]));
    assert.equal(db.paper(`lib:${paperKey}`)!.title, before);
    assert.equal(db.getSetting('lastSync') !== null, true);
  } finally {
    db.close();
  }
});

test('identical Zotero keys in distinct libraries remain distinct papers', () => {
  const db = database();
  try {
    db.applySnapshots([
      snapshot('lib-a', [paper('Library A')]),
      snapshot('lib-b', [paper('Library B')]),
    ]);
    assert.equal(db.library().papers.length, 2);
    assert.equal(db.paper(`lib-a:${paperKey}`)?.title, 'Library A');
    assert.equal(db.paper(`lib-b:${paperKey}`)?.title, 'Library B');
  } finally {
    db.close();
  }
});

test('annotations validate attachment ownership and persist', () => {
  const db = database();
  try {
    const items = [
      paper(),
      source(attachmentKey, {
        itemType: 'attachment',
        parentItem: paperKey,
        contentType: 'application/pdf',
        title: 'Paper PDF',
        filename: 'paper.pdf',
      }),
    ];
    db.applySnapshots([
      snapshot('lib-a', items),
      snapshot('lib-b', [
        paper('Other paper'),
        source(attachmentKey, {
          itemType: 'attachment',
          parentItem: paperKey,
          contentType: 'application/pdf',
        }),
      ]),
    ]);
    assert.throws(
      () =>
        db.addAnnotation(`lib-a:${paperKey}`, {
          attachmentId: `lib-b:${attachmentKey}`,
          page: 3,
          quote: 'text',
        }),
      /does not belong/,
    );
    const annotation = db.addAnnotation(`lib-a:${paperKey}`, {
      attachmentId: `lib-a:${attachmentKey}`,
      page: 3,
      quote: 'A passage',
      text: 'Review this',
      color: '#abcdef',
    });
    assert.equal(annotation.page, 3);
    assert.deepEqual(db.annotations(`lib-a:${paperKey}`), [annotation]);
  } finally {
    db.close();
  }
});

test('malformed paper patches are rejected atomically', () => {
  const db = database();
  try {
    db.applySnapshots([snapshot()]);
    const id = `local/users/0:${paperKey}`;
    assert.throws(
      () => db.patchPaper(id, { status: 'read', starred: 'yes' }),
      /starred must be a boolean/,
    );
    assert.equal(db.paper(id)?.status, 'inbox');
    assert.throws(
      () => db.patchPaper(id, { notes: 'partial', unexpected: true }),
      /Unknown paper field/,
    );
    assert.equal(db.paper(id)?.notes, '');
  } finally {
    db.close();
  }
});

test('Zotero client reports offline and forbidden responses clearly', async () => {
  const offline = new ZoteroClient(
    mockFetch(() => {
      throw new Error('connection refused');
    }),
  );
  await assert.rejects(offline.request('/'), /Cannot reach Zotero/);
  const forbidden = new ZoteroClient(mockFetch(() => new Response('', { status: 403 })));
  await assert.rejects(forbidden.request('/'), /access is disabled/);
});

test('Zotero client rejects malformed JSON list responses', async () => {
  const client = new ZoteroClient(mockFetch(() => new Response('{broken')));
  await assert.rejects(client.list('/users/0/items', null), SyntaxError);
});

test('Zotero client rejects malformed item result shapes', () => {
  const client = new ZoteroClient(mockFetch(() => new Response('[]')));
  assert.throws(
    () => client.validate([{ key: 'short', data: { itemType: 'journalArticle' } }], 'items'),
    /invalid or duplicate items/,
  );
  assert.throws(
    () => client.validate([{ key: 'PAPER001', data: { title: 'Missing type' } }], 'items'),
    /missing its type/,
  );
});

test('Zotero client rejects off-host pagination links', async () => {
  const client = new ZoteroClient(
    mockFetch(
      () =>
        new Response('[]', {
          headers: { link: '<http://example.com/api/users/0/items?page=2>; rel="next"' },
        }),
    ),
  );
  await assert.rejects(client.list('/users/0/items', null), /invalid pagination URL/);
});

test('Zotero client accepts only local file URLs for PDF attachments', async () => {
  const remote = new ZoteroClient(mockFetch(() => new Response('https://example.com/paper.pdf')));
  await assert.rejects(
    remote.attachmentPath({ prefix: '/users/0', zotero_key: attachmentKey, server_id: null }),
    /did not return a local attachment/,
  );
  const filename = join(tmpdir(), 'atlas paper.pdf');
  const local = new ZoteroClient(mockFetch(() => new Response(pathToFileURL(filename).href)));
  assert.equal(
    await local.attachmentPath({ prefix: '/users/0', zotero_key: attachmentKey, server_id: null }),
    filename,
  );
});

test('secureRequest rejects untrusted hosts and origins', () => {
  const request = (headers: Record<string, string>) => secureRequest({ headers } as any, 3210);
  assert.equal(request({ host: '127.0.0.1:3210' }), true);
  assert.equal(request({ host: 'localhost:3210', origin: 'http://localhost:3210' }), true);
  assert.equal(request({ host: 'evil.example' }), false);
  assert.equal(request({ host: '127.0.0.1:3210', origin: 'https://evil.example' }), false);
  assert.equal(request({ host: '127.0.0.1:3210', 'sec-fetch-site': 'cross-site' }), false);
});

test('paper metadata and annotations persist after reopening a disk database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-backend-test-'));
  const path = join(directory, 'atlas.sqlite');
  try {
    let db = new AtlasDatabase(path);
    const items: SourceItem[] = [
      paper(),
      source(attachmentKey, {
        itemType: 'attachment',
        parentItem: paperKey,
        contentType: 'application/pdf',
        title: 'Paper PDF',
        filename: 'paper.pdf',
      }),
    ];
    db.applySnapshots([snapshot('persistent-lib', items)]);
    db.patchPaper(`persistent-lib:${paperKey}`, {
      status: 'read',
      summary: 'Persistent summary',
      notes: 'Persistent notes',
    });
    const annotation = db.addAnnotation(`persistent-lib:${paperKey}`, {
      attachmentId: `persistent-lib:${attachmentKey}`,
      page: 7,
      quote: 'Persistent quote',
      text: 'Persistent annotation',
    });
    db.close();

    db = new AtlasDatabase(path);
    assert.equal(db.paper(`persistent-lib:${paperKey}`)?.status, 'read');
    assert.equal(db.paper(`persistent-lib:${paperKey}`)?.summary, 'Persistent summary');
    assert.equal(db.paper(`persistent-lib:${paperKey}`)?.notes, 'Persistent notes');
    assert.deepEqual(db.annotations(`persistent-lib:${paperKey}`), [annotation]);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Zotero validation rejects malformed nested creators and tags', () => {
  const client = new ZoteroClient(mockFetch(() => new Response('[]')));
  assert.throws(
    () =>
      client.validate(
        [{ key: 'PAPER001', data: { itemType: 'journalArticle', creators: ['not a creator'] } }],
        'items',
      ),
    /Invalid Zotero creator/,
  );
  assert.throws(
    () =>
      client.validate(
        [
          {
            key: 'PAPER001',
            data: { itemType: 'journalArticle', tags: [{ name: 'wrong shape' }] },
          },
        ],
        'items',
      ),
    /Invalid Zotero tag/,
  );
});

test('Zotero list rejects incomplete Total-Results snapshots', async () => {
  const client = new ZoteroClient(
    mockFetch(() => new Response('[{}]', { headers: { 'Total-Results': '2' } })),
  );
  await assert.rejects(client.list('/users/0/items', null), /incomplete snapshot/);
});

test('Zotero list follows valid same-host pagination to completion', async () => {
  const requested: string[] = [];
  const client = new ZoteroClient(
    mockFetch((url) => {
      requested.push(url);
      if (url.includes('page=2'))
        return new Response('[{"key":"PAPER002"}]', { headers: { 'Total-Results': '2' } });
      return new Response('[{"key":"PAPER001"}]', {
        headers: {
          'Total-Results': '2',
          link: '<http://127.0.0.1:23119/api/users/0/items?page=2>; rel="next"',
        },
      });
    }),
  );
  assert.deepEqual(await client.list('/users/0/items?page=1', null), [
    { key: 'PAPER001' },
    { key: 'PAPER002' },
  ]);
  assert.equal(requested.length, 2);
  assert.match(requested[1], /page=2/);
});
