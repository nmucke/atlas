import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../server/assistant-store.ts';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { Retrieval } from '../server/retrieval.ts';
import { ZoteroWorkflow } from '../server/zotero-workflow.ts';
import {
  NewsZotero,
  PDF_NOT_REMEMBERED,
  ZOTERO_NOT_AUTHORIZED,
  ZOTERO_UNREACHABLE,
} from '../server/news-zotero.ts';
import type { NewsItem } from '../shared/news.ts';

const serverId = 'news-server';
const personal = `${serverId}/users/0`;
const group = `${serverId}/groups/42`;
const personalCollection = 'CLLCTN22';
const groupCollection = 'GRPCLL22';
const existingKey = 'BCDE2345';
const arxivTitle = 'Neural operators for turbulent flow closure models';

function newsItem(patch: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'news-1',
    kind: 'paper',
    title: arxivTitle,
    authors: ['Ada Lovelace', 'Plato'],
    abstract: 'We learn closures.',
    url: 'https://arxiv.org/abs/2409.01234v2',
    venue: null,
    publishedAt: '2024-09-02T10:00:00.000Z',
    firstSeenAt: '2024-09-03T00:00:00.000Z',
    doi: null,
    arxivId: '2409.01234',
    sources: [],
    preScore: 0.5,
    features: {},
    triage: null,
    score: 0.5,
    state: 'new',
    dismissReason: null,
    feedback: null,
    paperId: null,
    ...patch,
  };
}

function fixture(options: { remember?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-news-zotero-'));
  const db = new AtlasDatabase(join(dir, 'atlas.sqlite'));
  const libraries = new Map<string, Map<string, any>>([
    [
      '/users/0',
      new Map([
        [
          existingKey,
          {
            key: existingKey,
            version: 1,
            data: {
              itemType: 'journalArticle',
              title: 'Known paper',
              DOI: 'https://doi.org/10.1000/KNOWN',
              extra: 'arXiv: 2301.00001v3',
              creators: [],
              tags: [],
              collections: [],
            },
          },
        ],
      ]),
    ],
    ['/groups/42', new Map()],
  ]);
  const collections: Record<string, any[]> = {
    '/users/0': [{ key: personalCollection, data: { name: 'Reading' } }],
    '/groups/42': [{ key: groupCollection, data: { name: 'Lab' } }],
  };
  const snapshots = (): Snapshot[] =>
    [...libraries].map(([prefix, items]) => ({
      id: `${serverId}${prefix}`,
      name: prefix === '/users/0' ? 'My Library' : 'Lab',
      prefix,
      serverId,
      collections: collections[prefix],
      items: [...items.values()].map((item) => ({ ...item, data: { ...item.data } })),
    }));
  db.applySnapshots(snapshots());
  const calls: { path: string; method: string; headers: Headers; body?: string }[] = [];
  const consumed = new Set<string>();
  let created = 0;
  const state = {
    unreachable: false,
    loseCreateResponse: false,
    pages: [`${arxivTitle}\nAda Lovelace, Plato`],
    syncs: 0,
  };
  const fetcher: typeof fetch = async (input, init) => {
    if (state.unreachable) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname + url.search,
      method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.pathname === '/api/')
      return new Response('', {
        headers: { 'X-Zotero-Version': '10.0.1', 'Zotero-Server-ID': serverId },
      });
    if (url.pathname === '/api/local/authorize')
      return Response.json({ key: 'K'.repeat(32), remember: options.remember ?? true });
    if (url.pathname.startsWith('/api/local/uploads/')) return new Response('', { status: 201 });
    const match = url.pathname.match(
      /^\/api(\/users\/0|\/groups\/42)\/items(?:\/([A-Z0-9]{8})(?:\/(children|file))?)?$/,
    );
    if (!match) throw new Error(`Unexpected request ${method} ${url.pathname}`);
    const [, prefix, itemKey, suffix] = match;
    const items = libraries.get(prefix)!;
    if (!itemKey && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return Response.json(
        [...items.values()].filter((item) => JSON.stringify(item.data).toLowerCase().includes(q)),
      );
    }
    if (!itemKey && method === 'POST') {
      const token = headers.get('Zotero-Write-Token')!;
      if (consumed.has(token)) return new Response('Write token already used', { status: 412 });
      consumed.add(token);
      const data = JSON.parse(String(init?.body))[0];
      const key = `NEWSITM${'ABCDEFGH'[created++]}`;
      const item = { key, version: 5, data: { ...data, key, version: 5 } };
      items.set(key, item);
      if (state.loseCreateResponse) throw new Error('connection reset');
      return Response.json({ successful: { '0': item }, unchanged: {}, failed: {} });
    }
    if (suffix === 'children')
      return Response.json([...items.values()].filter((item) => item.data.parentItem === itemKey));
    if (suffix === 'file') {
      if (String(init?.body).startsWith('upload=')) {
        items.get(itemKey).data.md5 = 'md5';
        return new Response(null, { status: 204 });
      }
      return Response.json({
        url: 'http://localhost:23119/api/local/uploads/UP1',
        uploadKey: 'UP1',
      });
    }
    return items.has(itemKey)
      ? Response.json(items.get(itemKey))
      : new Response('Not found', { status: 404 });
  };
  const projects = new ProjectStore(db.db);
  const retrieval = new Retrieval(db, projects, new AssistantStore(db.db));
  const workflow = new ZoteroWorkflow(db, projects, retrieval, {
    fetcher,
    downloader: async () => Buffer.from('%PDF-1.7\nmock'),
    extractCandidate: async () => state.pages,
  });
  workflow.setSync(async () => {
    state.syncs++;
    db.applySnapshots(snapshots());
  });
  const project = projects.create({ name: 'Turbulence' });
  return {
    db,
    workflow,
    news: new NewsZotero(db, projects, workflow),
    libraries,
    calls,
    state,
    project,
    creates: () => calls.filter((c) => c.method === 'POST' && /\/items$/.test(c.path)),
    linked: (paperId: string) =>
      !!db.db
        .prepare('SELECT 1 FROM project_papers WHERE project_id=? AND paper_id=?')
        .get(project.id, paperId),
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('adds an arXiv preprint to a personal collection with a deterministic token, PDF and project link', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    const result = await f.news.add(newsItem(), {
      collectionId: `${personal}:${personalCollection}`,
      projectId: f.project.id,
      attachPdf: true,
    });
    assert.deepEqual(result, { paperId: `${personal}:NEWSITMA`, pdf: 'attached' });
    const [create] = f.creates();
    assert.equal(create.path, '/api/users/0/items');
    assert.equal(
      create.headers.get('Zotero-Write-Token'),
      createHash('sha256').update('atlas-news:news-1:create:0').digest('hex').slice(0, 32),
    );
    assert.deepEqual(JSON.parse(create.body!), [
      {
        itemType: 'preprint',
        title: arxivTitle,
        abstractNote: 'We learn closures.',
        date: '2024-09-02',
        url: 'https://arxiv.org/abs/2409.01234v2',
        tags: [{ tag: 'atlas:news' }],
        collections: [personalCollection],
        creators: [
          { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
          { creatorType: 'author', name: 'Plato' },
        ],
        repository: 'arXiv',
        archiveID: 'arXiv:2409.01234',
        DOI: '10.48550/arXiv.2409.01234',
      },
    ]);
    const paper = f.db.paper(result.paperId)!;
    assert.deepEqual(paper.collections, [`${personal}:${personalCollection}`]);
    assert.equal(paper.attachments.length, 1);
    assert.equal(
      f.libraries.get('/users/0')!.get('NEWSITMB').data.url,
      'https://arxiv.org/pdf/2409.01234',
    );
    assert.ok(f.linked(result.paperId));
    assert.equal(f.workflow.list()[0].agent.name, 'Atlas News');
  } finally {
    f.cleanup();
  }
});

test('adds a DOI journal article to a group library collection', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    const result = await f.news.add(
      newsItem({
        id: 'news-2',
        title: 'Closure models in practice',
        url: 'https://doi.org/10.1017/JFM.2024.1',
        doi: '10.1017/jfm.2024.1',
        arxivId: null,
        venue: 'Journal of Fluid Mechanics',
        publishedAt: null,
      }),
      { collectionId: `${group}:${groupCollection}`, projectId: null, attachPdf: true },
    );
    assert.equal(result.paperId, `${group}:NEWSITMA`);
    assert.equal(result.pdf, 'skipped');
    const [create] = f.creates();
    assert.equal(create.path, '/api/groups/42/items');
    assert.deepEqual(JSON.parse(create.body!)[0], {
      itemType: 'journalArticle',
      title: 'Closure models in practice',
      abstractNote: 'We learn closures.',
      date: '',
      url: 'https://doi.org/10.1017/JFM.2024.1',
      tags: [{ tag: 'atlas:news' }],
      collections: [groupCollection],
      creators: [
        { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
        { creatorType: 'author', name: 'Plato' },
      ],
      publicationTitle: 'Journal of Fluid Mechanics',
      DOI: '10.1017/jfm.2024.1',
    });
    assert.ok(f.db.paper(result.paperId));
  } finally {
    f.cleanup();
  }
});

test('library root goes to the personal library without collections', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    const result = await f.news.add(newsItem(), {
      collectionId: null,
      projectId: null,
      attachPdf: false,
    });
    assert.deepEqual(result, { paperId: `${personal}:NEWSITMA`, pdf: 'skipped' });
    assert.deepEqual(JSON.parse(f.creates()[0].body!)[0].collections, []);
  } finally {
    f.cleanup();
  }
});

test('items already in the library are linked without contacting Zotero', async () => {
  const f = fixture();
  try {
    const byDoi = await f.news.add(newsItem({ doi: '10.1000/known', arxivId: null }), {
      collectionId: null,
      projectId: f.project.id,
      attachPdf: false,
    });
    assert.deepEqual(byDoi, { paperId: `${personal}:${existingKey}`, pdf: 'skipped' });
    const byArxiv = await f.news.add(newsItem({ arxivId: '2301.00001' }), {
      collectionId: null,
      projectId: null,
      attachPdf: false,
    });
    assert.equal(byArxiv.paperId, `${personal}:${existingKey}`);
    assert.ok(f.linked(byDoi.paperId));
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('re-checks Zotero right before writing so a lost create response never duplicates', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    f.state.loseCreateResponse = true;
    await assert.rejects(
      f.news.add(newsItem(), { collectionId: null, projectId: null, attachPdf: false }),
      /Could not add the item to Zotero/,
    );
    f.state.loseCreateResponse = false;
    await f.workflow.authorize();
    const result = await f.news.add(newsItem(), {
      collectionId: null,
      projectId: f.project.id,
      attachPdf: false,
    });
    assert.equal(result.paperId, `${personal}:NEWSITMA`);
    assert.equal(f.creates().length, 1);
    assert.equal(f.libraries.get('/users/0')!.size, 2);
    assert.ok(f.linked(result.paperId));
  } finally {
    f.cleanup();
  }
});

test('requires the Zotero write grant and reports an unreachable Zotero', async () => {
  const f = fixture();
  try {
    const input = { collectionId: null, projectId: null, attachPdf: false };
    await assert.rejects(f.news.add(newsItem(), input), { message: ZOTERO_NOT_AUTHORIZED });
    f.state.unreachable = true;
    await assert.rejects(f.news.add(newsItem(), input), { message: ZOTERO_UNREACHABLE });
    assert.equal(f.creates().length, 0);
    await assert.rejects(
      f.news.add(newsItem(), { ...input, projectId: 'missing' }),
      /Project not found/,
    );
  } finally {
    f.cleanup();
  }
});

test('a failed PDF still returns the created paper', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    f.state.pages = ['A different paper entirely'];
    const result = await f.news.add(newsItem(), {
      collectionId: null,
      projectId: f.project.id,
      attachPdf: true,
    });
    assert.equal(result.paperId, `${personal}:NEWSITMA`);
    assert.equal(result.pdf, 'failed');
    assert.match(result.pdfError!, /PDF title could not be verified/);
    assert.ok(f.db.paper(result.paperId));
    assert.ok(f.linked(result.paperId));
  } finally {
    f.cleanup();
  }
});

test('a one-time Zotero grant adds the item but not the PDF', async () => {
  const f = fixture({ remember: false });
  try {
    await f.workflow.authorize();
    const result = await f.news.add(newsItem(), {
      collectionId: null,
      projectId: null,
      attachPdf: true,
    });
    assert.equal(result.paperId, `${personal}:NEWSITMA`);
    assert.deepEqual(result, {
      paperId: `${personal}:NEWSITMA`,
      pdf: 'failed',
      pdfError: PDF_NOT_REMEMBERED,
    });
  } finally {
    f.cleanup();
  }
});
