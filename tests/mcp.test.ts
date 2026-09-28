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
  return {
    isError: !!response.isError,
    data: text?.type === 'text' ? JSON.parse(text.text ?? 'null') : null,
  };
}

test('MCP initialization exposes only bounded research and proposal tools', async () => {
  const f = await fixture();
  try {
    assert.equal(f.client.getServerVersion()?.name, 'atlas');
    const names = (await f.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'atlas_begin_run',
      'atlas_find_papers',
      'atlas_get_context',
      'atlas_get_profile',
      'atlas_get_workflow',
      'atlas_index',
      'atlas_list_projects',
      'atlas_list_tags',
      'atlas_search',
      'atlas_submit',
    ]);
    assert.equal(
      names.some((name) => /approv|decide|patch|edit|delete|set_profile/.test(name)),
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
