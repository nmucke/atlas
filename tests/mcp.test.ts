import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { AssistantService } from '../server/assistant-service.ts';
import { createAtlasMcp } from '../server/mcp.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-'));
  const db = new AtlasDatabase(join(dir, 'atlas.sqlite'));
  const snapshot: Snapshot = {
    id: 'lib',
    name: 'Library',
    prefix: '/users/0',
    serverId: null,
    collections: [],
    items: [
      {
        key: 'PAPER001',
        data: {
          itemType: 'journalArticle',
          title: 'Climate paper',
          abstractNote: 'Climate observations.',
          creators: [],
          tags: [],
          collections: [],
        },
      },
    ],
  };
  db.applySnapshots([snapshot]);
  const projects = new ProjectStore(db.db);
  const service = new AssistantService(db, projects);
  const server = createAtlasMcp(service);
  const client = new Client({ name: 'atlas-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    service,
    async cleanup() {
      await client.close();
      await server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { type: string; text?: string }[];
  const text = content.find((block) => block.type === 'text');
  let data = null;
  try {
    data = text?.type === 'text' ? JSON.parse(text.text ?? 'null') : null;
  } catch {
    // Input schema violations are reported by the MCP SDK as plain text.
    data = { error: text?.text };
  }
  return { isError: !!response.isError, data };
}

test('MCP initialization exposes bounded research, PDF, and proposal tools without approval', async () => {
  const f = await fixture();
  try {
    assert.equal(f.client.getServerVersion()?.name, 'atlas');
    const names = (await f.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'atlas_add_pdf',
      'atlas_begin_run',
      'atlas_check_attachments',
      'atlas_duplicate_candidates',
      'atlas_find_papers',
      'atlas_find_pdf',
      'atlas_get_context',
      'atlas_get_profile',
      'atlas_get_workflow',
      'atlas_index',
      'atlas_list_projects',
      'atlas_list_tags',
      'atlas_news_collect',
      'atlas_news_get_feedback',
      'atlas_news_list_sources',
      'atlas_news_propose_sources',
      'atlas_news_queue',
      'atlas_news_submit',
      'atlas_pdf_inventory',
      'atlas_propose_duplicate_delete',
      'atlas_retry_pdf',
      'atlas_search',
      'atlas_set_attachment_visibility',
      'atlas_submit',
    ]);
    assert.equal(
      names.some((name) => /approv|decide|patch|^atlas_delete|set_profile/.test(name)),
      false,
    );
    assert.equal(
      names.some((name) => /news_(add|remove|delete|zotero|set)/.test(name)),
      false,
    );
    const resources = await f.client.listResources();
    assert.ok(
      resources.resources.some((resource) => resource.uri === 'atlas://assistant/instructions'),
    );
    const prompts = await f.client.listPrompts();
    assert.ok(prompts.prompts.some((prompt) => prompt.name === 'atlas-review-paper'));
    const workflow = await f.client.callTool({
      name: 'atlas_get_workflow',
      arguments: { name: 'atlas-review-paper' },
    });
    assert.equal(workflow.isError, undefined);
    assert.match((workflow.content as { text: string }[])[0].text, /review/i);
    for (const name of ['atlas-news-scan', 'atlas-news-sources']) {
      assert.ok(prompts.prompts.some((prompt) => prompt.name === name));
      const news = await f.client.callTool({ name: 'atlas_get_workflow', arguments: { name } });
      assert.equal(news.isError, undefined);
      assert.match((news.content as { text: string }[])[0].text, new RegExp(`name: ${name}`));
    }
    const unknown = await f.client.callTool({ name: 'atlas_approve', arguments: { id: 'fake' } });
    assert.equal(unknown.isError, true);
  } finally {
    await f.cleanup();
  }
});

test('MCP tool calls create only pending proposals and reject forged citations', async () => {
  const f = await fixture();
  try {
    const begin = await call(f.client, 'atlas_begin_run', {
      purpose: 'Propose global climate tags',
      agentName: 'test assistant',
      model: 'local-model',
    });
    assert.equal(begin.isError, false);
    const runId = begin.data.runId as string;
    const tags = await call(f.client, 'atlas_list_tags', { runId });
    assert.equal(tags.isError, false);
    const citationId = tags.data.evidence[0].chunkId as string;
    const malformed = await call(f.client, 'atlas_submit', {
      runId,
      kind: 'tags',
      title: 'Global vocabulary',
      body: 'Climate methods tag',
      tags: [{ name: 'method/climate', description: 'Climate methodology' }],
      citationIds: ['forged'],
    });
    assert.equal(malformed.isError, true);
    assert.match(malformed.data.error, /not retrieved in this run/);
    const submitted = await call(f.client, 'atlas_submit', {
      runId,
      kind: 'tags',
      title: 'Global vocabulary',
      body: 'Climate methods tag',
      tags: [{ name: 'method/climate', description: 'Climate methodology' }],
      citationIds: [citationId],
    });
    assert.equal(submitted.isError, false);
    assert.equal(submitted.data.status, 'pending');
    assert.equal(f.service.store.list({ status: 'pending' }).length, 1);
    assert.equal(
      f.service.library.library().tags.some((tag) => tag.name === 'method/climate'),
      false,
    );
    const noScope = await call(f.client, 'atlas_get_context', { runId });
    assert.equal(noScope.isError, true);
    assert.match(noScope.data.error, /Choose paperId or projectId/);
  } finally {
    await f.cleanup();
  }
});

test('MCP saves reading scores with readable reviews and separate evidence', async () => {
  const f = await fixture();
  try {
    const begin = await call(f.client, 'atlas_begin_run', {
      purpose: 'Review climate paper',
      agentName: 'reviewer',
      model: 'test',
    });
    const runId = begin.data.runId;
    const paperId = 'lib:PAPER001';
    const context = await call(f.client, 'atlas_get_context', { runId, paperId });
    const chunkId = context.data.evidence[0].chunkId;
    const missingScore = await call(f.client, 'atlas_submit', {
      runId,
      kind: 'review',
      paperId,
      title: 'Incomplete review',
      body: 'Reading recommendation: 4/5. Relevant observational evidence.',
      citationIds: [chunkId],
    });
    assert.equal(missingScore.isError, true);
    assert.match(missingScore.data.error, /require readingRecommendation/);
    assert.equal(f.service.store.list().length, 0);
    const submitted = await call(f.client, 'atlas_submit', {
      runId,
      kind: 'review',
      paperId,
      title: 'Climate review',
      body: `Climate observations [${chunkId}].`,
      readingRecommendation: { score: 4, reason: 'Relevant observational evidence.' },
      citationIds: [chunkId],
    });
    assert.equal(submitted.isError, false);
    assert.equal(submitted.data.body, 'Climate observations.');
    assert.equal(submitted.data.readingRecommendation.score, 4);
    assert.equal(submitted.data.citations[0].chunkId, chunkId);
  } finally {
    await f.cleanup();
  }
});

test('News MCP tools validate runs and inputs and delegate to the News service', async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const hints = (name: string) => tools.find((t) => t.name === name)!.annotations!;
    assert.equal(hints('atlas_news_collect').openWorldHint, true);
    assert.equal(hints('atlas_news_collect').readOnlyHint, false);
    for (const name of ['atlas_news_queue', 'atlas_news_list_sources', 'atlas_news_get_feedback'])
      assert.equal(hints(name).readOnlyHint, true);
    for (const name of ['atlas_news_submit', 'atlas_news_propose_sources'])
      assert.equal(hints(name).openWorldHint, false);
    const calls: Record<string, unknown[][]> = {};
    const stub = (name: string, value: (...args: any[]) => unknown) => {
      calls[name] = [];
      (f.service.news as any)[name] = (...args: unknown[]) => {
        calls[name].push(args);
        return value(...args);
      };
    };
    const status = {
      running: false,
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:00:01.000Z',
      fetched: 3,
      added: 2,
      errors: [],
    };
    const item = { id: 'item-1', title: 'Flow matching', triage: null };
    stub('collect', async () => status);
    stub('queue', () => ({ items: [item], nextOffset: null, total: 1 }));
    stub('sources', () => [{ id: 'source-1', kind: 'arxiv', value: 'stat.ML' }]);
    stub('suggestions', () => []);
    stub('feedbackSummary', () => ({ kept: [], dismissed: [] }));
    stub('submitTriage', (_runId: string, items: { itemId: string }[]) => ({
      saved: items.length,
      items: items.map(() => item),
    }));
    stub('item', (id: string) => (id === item.id ? item : null));
    stub('proposeSources', (_runId: string, sources: { kind: string; value: string }[]) =>
      sources.map((s) => ({ ...s, id: 'suggestion-1', origin: 'assistant' })),
    );
    const fakeRun = '00000000-0000-4000-8000-000000000000';
    const unknownRun = await call(f.client, 'atlas_news_collect', { runId: fakeRun });
    assert.equal(unknownRun.isError, true);
    assert.match(unknownRun.data.error, /Unknown run/);
    assert.equal(calls.collect.length, 0);
    const runId = (
      await call(f.client, 'atlas_begin_run', {
        purpose: 'Scan my News',
        agentName: 'scanner',
        model: 'test',
      })
    ).data.runId as string;
    assert.deepEqual((await call(f.client, 'atlas_news_collect', { runId })).data, status);
    const queue = await call(f.client, 'atlas_news_queue', { runId, limit: 10, offset: 5 });
    assert.equal(queue.data.items[0].id, 'item-1');
    assert.deepEqual(calls.queue[0], [runId, { limit: 10, offset: 5 }]);
    assert.equal((await call(f.client, 'atlas_news_queue', { runId, limit: 31 })).isError, true);
    const sources = await call(f.client, 'atlas_news_list_sources', { runId });
    assert.equal(sources.data.sources[0].value, 'stat.ML');
    assert.deepEqual(sources.data.suggestions, []);
    await call(f.client, 'atlas_news_get_feedback', { runId, since: '2026-09-01T00:00:00Z' });
    assert.deepEqual(calls.feedbackSummary[0], [runId, '2026-09-01T00:00:00Z']);
    const badSince = await call(f.client, 'atlas_news_get_feedback', { runId, since: 'yesterday' });
    assert.equal(badSince.isError, true);
    const triage = {
      runId,
      items: [{ itemId: 'item-1', score: 4, why: 'Relevant to the flow project.' }],
      requestKey: 'batch-1',
    };
    for (const bad of [
      { ...triage, items: [{ ...triage.items[0], score: 6 }] },
      { ...triage, items: [{ ...triage.items[0], why: '' }] },
      { ...triage, items: [] },
    ])
      assert.equal((await call(f.client, 'atlas_news_submit', bad)).isError, true);
    assert.equal(calls.submitTriage.length, 0);
    const first = await call(f.client, 'atlas_news_submit', triage);
    assert.equal(first.isError, false);
    assert.equal(first.data.saved, 1);
    const retry = await call(f.client, 'atlas_news_submit', triage);
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.items[0].id, 'item-1');
    assert.equal(calls.submitTriage.length, 1);
    const badKind = await call(f.client, 'atlas_news_propose_sources', {
      runId,
      sources: [{ kind: 'twitter', value: '@someone', reason: 'Posts papers' }],
    });
    assert.equal(badKind.isError, true);
    const proposed = await call(f.client, 'atlas_news_propose_sources', {
      runId,
      sources: [{ kind: 'arxiv', value: 'physics.flu-dyn', reason: 'Fluid projects' }],
    });
    assert.equal(proposed.data.suggestions[0].origin, 'assistant');
    assert.equal(calls.proposeSources[0][0], runId);
  } finally {
    await f.cleanup();
  }
});

test('News MCP tools use the real News service without adding sources', async () => {
  const f = await fixture();
  try {
    const runId = (
      await call(f.client, 'atlas_begin_run', {
        purpose: 'Suggest News sources',
        agentName: 'scout',
        model: 'test',
      })
    ).data.runId as string;
    const empty = await call(f.client, 'atlas_news_queue', { runId });
    assert.deepEqual(empty.data, { items: [], nextOffset: null, total: 0 });
    const proposed = await call(f.client, 'atlas_news_propose_sources', {
      runId,
      sources: [{ kind: 'arxiv', value: 'stat.ML', reason: 'Profile lists statistical ML' }],
    });
    assert.equal(proposed.isError, false);
    assert.equal(proposed.data.suggestions[0].origin, 'assistant');
    const listed = await call(f.client, 'atlas_news_list_sources', { runId });
    assert.deepEqual(listed.data.sources, []);
    assert.equal(listed.data.suggestions.length, 1);
    assert.equal(f.service.news.sources().length, 0);
    const unknown = await call(f.client, 'atlas_news_submit', {
      runId,
      items: [{ itemId: 'missing', score: 3, why: 'Unrelated.' }],
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.data.error, /Unknown News item/);
    const feedback = await call(f.client, 'atlas_news_get_feedback', { runId });
    assert.equal(feedback.isError, false);
  } finally {
    await f.cleanup();
  }
});
