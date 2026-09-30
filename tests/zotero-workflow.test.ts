import { pathToFileURL } from 'node:url';
import { PdfDownloadCache } from '../server/pdf-download-cache.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { AssistantService } from '../server/assistant-service.ts';
import { ZoteroWorkflow } from '../server/zotero-workflow.ts';

const firstKey = 'BCDE2345',
  secondKey = 'FGHI6789';
const serverId = 'test-server';
const libraryId = `${serverId}/users/0`;
const firstId = `${libraryId}:${firstKey}`,
  secondId = `${libraryId}:${secondKey}`;
const pdfUrl = 'https://repository.example.edu/article.pdf';
const sourceUrl = 'https://repository.example.edu/article';
const key = 'A'.repeat(32);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-zotero-workflow-'));
  const db = new AtlasDatabase(join(dir, 'atlas.sqlite'));
  const items = new Map<string, any>([
    [
      firstKey,
      {
        key: firstKey,
        version: 2,
        data: {
          key: firstKey,
          version: 2,
          itemType: 'journalArticle',
          title: 'Methods of Observation',
          DOI: '10.1000/1',
          date: '2024',
          creators: [],
          tags: [],
          collections: [],
        },
      },
    ],
    [
      secondKey,
      {
        key: secondKey,
        version: 3,
        data: {
          key: secondKey,
          version: 3,
          itemType: 'journalArticle',
          title: 'Methods of Observation',
          DOI: '10.1000/1',
          date: '2024',
          creators: [],
          tags: [],
          collections: [],
        },
      },
    ],
  ]);
  const children = new Map<string, any[]>([
    [firstKey, []],
    [secondKey, []],
  ]);
  const calls: { path: string; method: string; headers: Headers }[] = [];
  const localFiles = new Map<string, string | number>();
  let downloadBytes: Buffer = Buffer.from('%PDF-1.7\nmock document');
  let candidatePages = ['Methods of Observation DOI: 10.1000/1'];
  let failCreate = false;
  let loseCreateResponse = false;
  let createdCount = 0;
  const consumedTokens = new Set<string>();
  let failSync = false;
  let failUpload = false;
  const snapshot = (): Snapshot => ({
    id: libraryId,
    name: 'My Library',
    prefix: '/users/0',
    serverId,
    collections: [],
    items: [...items.values()].map((item) => ({
      key: item.key,
      version: item.version,
      data: item.data,
    })),
  });
  db.applySnapshots([snapshot()]);
  const projects = new ProjectStore(db.db);
  const assistant = new AssistantService(db, projects);
  assistant.retrieval.refresh();
  const run = assistant.retrieval.begin(
    'Maintain Zotero library',
    'fixture agent',
    'fixture-model',
  );
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, method, headers });
    if (url.hostname === 'api.openalex.org')
      return Response.json({
        doi: 'https://doi.org/10.1000/1',
        title: 'Methods of Observation',
        best_oa_location: {
          is_oa: true,
          pdf_url: pdfUrl,
          landing_page_url: sourceUrl,
          license: 'cc-by',
          version: 'acceptedVersion',
        },
      });
    const commonHeaders = {
      'X-Zotero-Version': '10.0.4',
      'Zotero-Server-ID': serverId,
      'Zotero-API-Version': '3',
    };
    if (url.pathname === '/api/') return new Response('', { headers: commonHeaders });
    if (url.pathname === '/api/local/authorize') return Response.json({ key, remember: true });
    if (url.pathname.startsWith('/api/local/uploads/')) {
      if (failUpload) return new Response('', { status: 500 });
      return new Response('', { status: 201 });
    }
    const filePath = url.pathname.match(/^\/api\/users\/0\/items\/([A-Z0-9]{8})\/file\/view\/url$/);
    if (filePath) {
      const value = localFiles.get(filePath[1]) ?? 404;
      return typeof value === 'number' ? new Response('', { status: value }) : new Response(value);
    }
    const match = url.pathname.match(
      /^\/api\/users\/0\/items\/([A-Z0-9]{8})(?:\/(children|file))?$/,
    );
    if (match) {
      const [, itemKey, suffix] = match;
      if (suffix === 'children') return Response.json(children.get(itemKey) ?? []);
      if (suffix === 'file' && method === 'POST') {
        const body = String(init?.body);
        if (body.startsWith('upload=')) {
          const child = items.get(itemKey);
          child.data.md5 = 'fake-md5';
          return new Response(null, { status: 204 });
        }
        return Response.json({
          url: 'http://localhost:23119/api/local/uploads/UPLOAD1',
          uploadKey: 'UPLOAD1',
          contentType: 'application/octet-stream',
        });
      }
      if (method === 'PATCH') {
        const item = items.get(itemKey);
        if (headers.get('If-Unmodified-Since-Version') !== String(item.version))
          return new Response('', { status: 412 });
        item.data.deleted = 1;
        item.version++;
        item.data.version = item.version;
        return new Response(null, { status: 204 });
      }
      return items.has(itemKey)
        ? Response.json(items.get(itemKey))
        : new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/api/users/0/items' && method === 'POST') {
      const data = JSON.parse(String(init?.body))[0];
      const token = headers.get('Zotero-Write-Token')!;
      if (consumedTokens.has(token))
        return new Response('Write token already used', { status: 412 });
      consumedTokens.add(token);
      if ('key' in data || 'version' in data || failCreate)
        return Response.json({
          successful: {},
          failed: { '0': { code: 500, message: 'primaryData not loaded for keyed creation' } },
        });

      const generatedKey = 'NEWPDFA' + String.fromCharCode(65 + createdCount++);
      const item = {
        key: generatedKey,
        version: 4,
        data: { ...data, key: generatedKey, version: 4 },
      };
      items.set(generatedKey, item);
      children.get(data.parentItem)!.push(item);
      if (loseCreateResponse) throw new Error('Response lost after create');
      return Response.json({ successful: { '0': item }, unchanged: {}, failed: {} });
    }
    throw new Error(`Unexpected mocked Zotero request: ${method} ${url.pathname}`);
  };
  const downloadCache = new PdfDownloadCache();
  let downloadCount = 0;
  const workflow = new ZoteroWorkflow(db, projects, assistant.retrieval, {
    fetcher,
    downloadCache,
    downloader: async () => {
      downloadCount++;
      return downloadBytes;
    },
    extractCandidate: async () => candidatePages,
  });
  workflow.setSync(async () => {
    if (failSync) throw new Error('mock sync failure');
    db.applySnapshots([snapshot()]);
  });
  return {
    db,
    workflow,
    assistant,
    run,
    items,
    children,
    calls,
    localFiles,
    downloadCache,
    downloadCount: () => downloadCount,
    setCandidatePages(value: string[]) {
      candidatePages = value;
    },
    setDownloadBytes(value: Buffer) {
      downloadBytes = value;
    },
    addOldPdf(itemKey: string) {
      const child = {
        key: itemKey,
        version: 1,
        data: {
          key: itemKey,
          version: 1,
          itemType: 'attachment',
          parentItem: firstKey,
          contentType: 'application/pdf',
          filename: 'old.pdf',
          title: 'Existing PDF',
        },
      };
      items.set(itemKey, child);
      children.get(firstKey)!.push(child);
      return child;
    },
    localPdf() {
      const path = join(dir, 'existing.pdf');
      writeFileSync(path, '%PDF-1.7\nExisting data');
      return pathToFileURL(path).href;
    },
    setLoseCreateResponse(value: boolean) {
      loseCreateResponse = value;
    },
    setFailCreate(value: boolean) {
      failCreate = value;
    },
    setFailSync(value: boolean) {
      failSync = value;
    },
    setFailUpload(value: boolean) {
      failUpload = value;
    },
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('PDF add requires remembered authorization, reuses its attachment key after partial upload, and syncs Atlas', async () => {
  const f = fixture();
  try {
    const candidate = await f.workflow.findPdf(f.run.runId, firstId);
    assert.ok(candidate);
    const blocked = await f.workflow.addPdf(f.run.runId, candidate.id);
    assert.equal(blocked.status, 'failed');
    assert.match(blocked.error!, /remembered Zotero writes/);
    assert.equal(f.children.get(firstKey)!.length, 0);
    await f.workflow.authorize();
    f.setFailUpload(true);
    const partial = await f.workflow.retryPdf(f.run.runId, blocked.id);
    assert.equal(partial.status, 'failed');
    assert.equal(f.children.get(firstKey)!.length, 1);
    f.setFailUpload(false);
    const finished = await f.workflow.retryPdf(f.run.runId, blocked.id);
    assert.equal(finished.status, 'completed');
    assert.equal(f.children.get(firstKey)!.length, 1);
    assert.equal(
      f.db.library().papers.find((paper) => paper.id === firstId)?.attachments.length,
      1,
    );
    const repeated = await f.workflow.addPdf(f.run.runId, candidate.id);
    assert.equal(repeated.id, finished.id);
    assert.equal(f.children.get(firstKey)!.length, 1);
  } finally {
    f.cleanup();
  }
});

test('successful Zotero write with failed Atlas sync is retried as sync only', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    const candidate = await f.workflow.findPdf(f.run.runId, firstId);
    assert.ok(candidate);
    f.setFailSync(true);
    const action = await f.workflow.addPdf(f.run.runId, candidate.id);
    assert.equal(action.status, 'write_done');
    const writeCount = f.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/users/0/items',
    ).length;
    f.setFailSync(false);
    assert.equal((await f.workflow.retrySync(action.id)).status, 'completed');
    assert.equal(
      f.calls.filter((call) => call.method === 'POST' && call.path === '/api/users/0/items').length,
      writeCount,
    );
  } finally {
    f.cleanup();
  }
});

test('duplicate proposal requires both citations, detects stale preview, and moves only accepted item to Trash', async () => {
  const f = fixture();
  try {
    const first = f.assistant.retrieval.retrieve(f.run.runId, { sourceId: `paper:${firstId}` })
      .evidence[0];
    const second = f.assistant.retrieval.retrieve(f.run.runId, { sourceId: `paper:${secondId}` })
      .evidence[0];
    await assert.rejects(
      f.workflow.proposeDelete(f.run.runId, firstId, secondId, 'Same DOI and title', [
        first.chunkId,
      ]),
      /both duplicate items/,
    );
    const proposal = await f.workflow.proposeDelete(
      f.run.runId,
      firstId,
      secondId,
      'Same DOI and title',
      [first.chunkId, second.chunkId],
      'one',
    );
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.preview?.trash.key, firstKey);
    assert.equal(proposal.preview?.keep.key, secondKey);
    const repeat = await f.workflow.proposeDelete(
      f.run.runId,
      firstId,
      secondId,
      'Same DOI and title',
      [first.chunkId, second.chunkId],
      'one',
    );
    assert.equal(repeat.id, proposal.id);
    f.children.get(firstKey)!.push({
      key: 'JKLM2345',
      version: 8,
      data: {
        itemType: 'note',
        title: 'New note',
      },
    });
    const stale = await f.workflow.decide(proposal.id, true);
    assert.equal(stale.status, 'failed');
    assert.match(stale.error!, /changed since proposal/);
    assert.equal(f.items.get(firstKey).data.deleted, undefined);
    f.children.get(firstKey)!.pop();
    await f.workflow.authorize();
    const done = await f.workflow.retry(proposal.id);
    assert.equal(done.status, 'completed');
    assert.equal(f.items.get(firstKey).data.deleted, 1);
    assert.equal(f.items.get(secondKey).data.deleted, undefined);
    assert.equal(f.db.paper(firstId)?.archived, true);
    assert.equal(f.db.paper(secondId)?.archived, false);
  } finally {
    f.cleanup();
  }
});

test('missing PDF records do not block adding a usable copy or require deleting originals', async () => {
  const f = fixture();
  try {
    const oldA = f.addOldPdf('PDFABCDE');
    const oldB = f.addOldPdf('PDFABCDF');
    await f.workflow.authorize();
    const candidate = await f.workflow.findPdf(f.run.runId, firstId);
    const added = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(added.status, 'completed');
    assert.equal(f.children.get(firstKey)!.length, 3);
    assert.equal(f.items.get('PDFABCDE'), oldA);
    assert.equal(f.items.get('PDFABCDF'), oldB);
    assert.equal(
      f.calls.some((call) => call.method === 'PATCH' || call.method === 'DELETE'),
      false,
    );
    assert.equal((await f.workflow.addPdf(f.run.runId, candidate!.id)).id, added.id);
  } finally {
    f.cleanup();
  }
});

test('available PDFs and unknown availability block duplicate additions', async () => {
  for (const mode of ['available', 'unknown']) {
    const f = fixture();
    try {
      f.addOldPdf('PDFABCDE');
      f.localFiles.set('PDFABCDE', mode === 'available' ? f.localPdf() : 403);
      await f.workflow.authorize();
      const candidate = await f.workflow.findPdf(f.run.runId, firstId);
      await assert.rejects(
        f.workflow.addPdf(f.run.runId, candidate!.id),
        mode === 'available' ? /usable local PDF/ : /Cannot verify/,
      );
      assert.equal(f.children.get(firstKey)!.length, 1);
    } finally {
      f.cleanup();
    }
  }
});

test('retry rechecks an old attachment that became available before upload', async () => {
  const f = fixture();
  try {
    f.addOldPdf('PDFABCDE');
    const candidate = await f.workflow.findPdf(f.run.runId, firstId);
    const blocked = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(blocked.status, 'failed');
    await f.workflow.authorize();
    f.localFiles.set('PDFABCDE', f.localPdf());
    const retried = await f.workflow.retryPdf(f.run.runId, blocked.id);
    assert.equal(retried.status, 'failed');
    assert.match(retried.error!, /usable local PDF/);
    assert.equal(f.children.get(firstKey)!.length, 1);
  } finally {
    f.cleanup();
  }
});

test('agent-supplied PDF URLs are verified without OpenAlex and attach through the standard workflow', async () => {
  const f = fixture();
  try {
    const url = 'https://university.example.edu/fetch.php?media=paper.pdf';
    const candidate = await f.workflow.findPdf(f.run.runId, firstId, url);
    assert.equal(candidate?.pdfUrl, url);
    assert.equal(candidate?.license, null);
    assert.equal(f.calls.length, 0);
    await f.workflow.authorize();
    const action = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(action.status, 'completed');
    assert.equal(f.children.get(firstKey)!.length, 1);
  } finally {
    f.cleanup();
  }
});

test('unmatched supplied PDFs are rejected before a candidate or Zotero attachment is created', async () => {
  const f = fixture();
  try {
    f.setCandidatePages(['An unrelated paper DOI: 10.1000/1']);
    await assert.rejects(
      f.workflow.findPdf(f.run.runId, firstId, pdfUrl),
      /title could not be verified/,
    );
    assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM zotero_pdf_candidates').get()!.n, 0);
    assert.equal(f.children.get(firstKey)!.length, 0);
  } finally {
    f.cleanup();
  }
});

test('supplied PDF bytes must still match the verified candidate at upload time', async () => {
  const f = fixture();
  try {
    const candidate = await f.workflow.findPdf(f.run.runId, firstId, pdfUrl);
    f.downloadCache.clear();
    f.setDownloadBytes(Buffer.from('%PDF-1.7\nchanged document'));
    await f.workflow.authorize();
    const action = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(action.status, 'failed');
    assert.match(action.error!, /content changed/);
    assert.equal(f.children.get(firstKey)!.length, 0);
    const refreshed = await f.workflow.findPdf(f.run.runId, firstId, pdfUrl);
    assert.equal((await f.workflow.addPdf(f.run.runId, refreshed!.id)).status, 'completed');
  } finally {
    f.cleanup();
  }
});

test('verified PDF attachment reuses the downloaded bytes instead of contacting the source twice', async () => {
  const f = fixture();
  try {
    const candidate = await f.workflow.findPdf(f.run.runId, firstId, pdfUrl);
    assert.equal(f.downloadCount(), 1);
    f.setDownloadBytes(Buffer.from('The source is no longer responding'));
    await f.workflow.authorize();
    const result = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(result.status, 'completed');
    assert.equal(f.downloadCount(), 1);
  } finally {
    f.cleanup();
  }
});

test('retry after a rejected create uses a fresh token and keeps its unique filename with a server-generated key', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    const candidate = await f.workflow.findPdf(f.run.runId, firstId);
    f.setFailCreate(true);
    const failed = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(failed.status, 'failed');
    assert.equal(f.children.get(firstKey)!.length, 0);
    const firstKeyValue = f.db.db
      .prepare('SELECT attachment_key FROM zotero_actions WHERE id=?')
      .get(failed.id)!.attachment_key;
    f.setFailCreate(false);
    const retry = await f.workflow.retryPdf(f.run.runId, failed.id);
    assert.equal(retry.status, 'completed');
    assert.equal(f.children.get(firstKey)!.length, 1);
    assert.notEqual(f.children.get(firstKey)![0].key, firstKeyValue);
    assert.equal(f.children.get(firstKey)![0].data.filename, `${firstKeyValue}.pdf`);
    const creates = f.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/users/0/items',
    );
    assert.equal(creates.length, 2);
    assert.notEqual(
      creates[0].headers.get('Zotero-Write-Token'),
      creates[1].headers.get('Zotero-Write-Token'),
    );
  } finally {
    f.cleanup();
  }
});

test('lost create response is recovered by unique filename without creating a second attachment', async () => {
  const f = fixture();
  try {
    await f.workflow.authorize();
    const candidate = await f.workflow.findPdf(f.run.runId, firstId);
    f.setLoseCreateResponse(true);
    const failed = await f.workflow.addPdf(f.run.runId, candidate!.id);
    assert.equal(failed.status, 'failed');
    assert.equal(f.children.get(firstKey)!.length, 1);
    f.setLoseCreateResponse(false);
    const retry = await f.workflow.retryPdf(f.run.runId, failed.id);
    assert.equal(retry.status, 'completed');
    assert.equal(f.children.get(firstKey)!.length, 1);
    assert.equal(
      f.calls.filter((call) => call.method === 'POST' && call.path === '/api/users/0/items').length,
      1,
    );
  } finally {
    f.cleanup();
  }
});
