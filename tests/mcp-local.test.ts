import { AtlasDatabase } from '../server/database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  assistantOrigin,
  loadAssistantToken,
  readAssistantToken,
} from '../server/assistant-access.ts';

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return String(address.port);
}

test(
  'desktop STDIO bridge reaches the running app and preserves review boundaries',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas bridge '));
    const fixtureDb = new AtlasDatabase(join(directory, 'atlas.sqlite'));
    fixtureDb.applySnapshots([
      {
        id: 'reader-test',
        name: 'Reader fixture',
        prefix: '/users/0',
        serverId: null,
        collections: [],
        items: [
          { key: 'PAPERAAA', data: { itemType: 'journalArticle', title: 'Paper A' } },
          { key: 'PAPERBBB', data: { itemType: 'journalArticle', title: 'Paper B' } },
          {
            key: 'PDFAAAAA',
            data: {
              itemType: 'attachment',
              parentItem: 'PAPERAAA',
              contentType: 'application/pdf',
              filename: 'a.pdf',
            },
          },
          {
            key: 'PDFBBBBB',
            data: {
              itemType: 'attachment',
              parentItem: 'PAPERBBB',
              contentType: 'application/pdf',
              filename: 'b.pdf',
            },
          },
        ],
      },
    ]);
    fixtureDb.close();
    const port = await freePort();
    const env = { ...process.env, ATLAS_DATA_DIR: directory, ATLAS_PORT: port };
    const app = spawn(
      process.execPath,
      ['--experimental-strip-types', 'server/index.ts', '--production'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stopped = once(app, 'exit');
    let output = '';
    app.stdout.on('data', (chunk) => {
      output += chunk;
    });
    app.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const client = new Client({ name: 'desktop-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', resolve('server/mcp-local.ts')],
      cwd: directory,
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      stderr: 'pipe',
    });
    let bridgeErrors = '';
    transport.stderr?.on('data', (chunk) => {
      bridgeErrors += chunk;
    });
    const origin = assistantOrigin(port);
    try {
      const deadline = Date.now() + 10_000;
      while (!output.includes('Atlas is running')) {
        if (app.exitCode !== null || Date.now() > deadline)
          throw new Error(`Atlas failed to start: ${output}`);
        await new Promise((done) => setTimeout(done, 25));
      }
      for (const [attachment, wrongPaper] of [
        ['PDFAAAAA', 'PAPERBBB'],
        ['PDFBBBBB', 'PAPERAAA'],
      ]) {
        const response = await fetch(
          `${origin}/api/attachments/${encodeURIComponent('reader-test:' + attachment)}/file?paperId=${encodeURIComponent('reader-test:' + wrongPaper)}`,
        );
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /does not belong/);
      }
      const token = await readAssistantToken(directory);
      assert.equal(await loadAssistantToken(directory), token);
      if (process.platform !== 'win32')
        assert.equal((await stat(join(directory, 'assistant-token'))).mode & 0o777, 0o600);
      const request = (body: unknown, authorization?: string, extra: Record<string, string> = {}) =>
        fetch(`${origin}/api/assistant/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorization ? { authorization } : {}),
            ...extra,
          },
          body: JSON.stringify(body),
        });
      assert.equal((await request({ method: 'tools/list' })).status, 401);
      assert.equal(
        (await request({ method: 'tools/list' }, `Bearer ${'0'.repeat(64)}`)).status,
        401,
      );
      assert.equal(
        (
          await request({ method: 'tools/list' }, `Bearer ${token}`, {
            origin: 'https://foreign.example',
          })
        ).status,
        403,
      );
      assert.equal((await request({ method: 'approve' }, `Bearer ${token}`)).status, 400);
      assert.equal(
        (await fetch(`${origin}/api/assistant`, { headers: { authorization: `Bearer ${token}` } }))
          .status,
        403,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/assistant/records/fake/decision`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{"approve":true}',
          })
        ).status,
        403,
      );

      await client.connect(transport);
      assert.match(client.getInstructions() ?? '', /Only the human/);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 24);
      assert.equal(
        tools.some((tool) => /approve|decide/.test(tool.name)),
        false,
      );
      assert.ok((await client.listResources()).resources.length);
      assert.ok(
        (await client.readResource({ uri: 'atlas://assistant/instructions' })).contents.length,
      );
      assert.equal((await client.listPrompts()).prompts.length, 8);
      assert.ok((await client.getPrompt({ name: 'atlas-review-paper' })).messages.length);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return { result, data: JSON.parse((result.content as { text: string }[])[0].text) };
      };
      const { data: run } = await call('atlas_begin_run', {
        purpose: 'Review vocabulary',
        agentName: 'desktop-test',
        model: 'test',
      });
      const { data: tags } = await call('atlas_list_tags', { runId: run.runId });
      const proposal = {
        runId: run.runId,
        kind: 'tags',
        title: 'Climate methods',
        body: 'A proposed vocabulary entry.',
        tags: [{ name: 'method/climate', description: 'Climate methods' }],
        citationIds: [tags.evidence[0].chunkId],
        requestKey: 'desktop-test',
      };
      assert.equal(
        (await call('atlas_submit', { ...proposal, citationIds: ['forged'] })).result.isError,
        true,
      );
      const { data: record } = await call('atlas_submit', proposal);
      assert.equal(record.status, 'pending');
      assert.equal((await call('atlas_submit', proposal)).data.id, record.id);
      assert.equal(
        (await client.callTool({ name: 'atlas_approve', arguments: { id: record.id } })).isError,
        true,
      );
      const library = await (await fetch(`${origin}/api/library`)).json();
      assert.equal(
        library.tags.some((tag: { name: string }) => tag.name === 'method/climate'),
        false,
      );
      const approval = await fetch(`${origin}/api/assistant/records/${record.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"approve":true}',
      });
      assert.equal(approval.status, 200);
      assert.equal((await approval.json()).status, 'approved');
      assert.equal(output.includes(token), false);
      assert.equal(bridgeErrors.includes(token), false);
      app.kill();
      await stopped;
      await assert.rejects(client.listTools(), /Atlas is unavailable/);
    } finally {
      await client.close();
      await transport.close();
      if (app.exitCode === null && app.signalCode === null) app.kill();
      await stopped;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('setup prints portable desktop values, preserves instructions, and never prints credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas setup '));
  try {
    const token = await loadAssistantToken(directory);
    const env = {
      ...process.env,
      ATLAS_DATA_DIR: directory,
      ATLAS_PORT: '45678',
      CODEX_HOME: join(directory, 'codex-test-home'),
    };
    const run = () =>
      exec(process.execPath, ['--experimental-strip-types', 'scripts/setup-assistant.ts'], { env });
    await mkdir(env.CODEX_HOME, { recursive: true });
    const sharedFilename = join(env.CODEX_HOME, 'config.toml');
    const existing = '# Keep Corpus settings\n[mcp_servers.corpus]\ncommand="corpus-node"\n';
    await writeFile(sharedFilename, existing);
    const { stdout } = await run();
    assert.match(stdout, /ChatGPT Desktop \/ Codex: Atlas registered/);
    assert.match(stdout, /127\.0\.0\.1:45678/);
    assert.equal(stdout.includes(token), false);
    const workspace = join(directory, 'assistant-workspace');
    const configText = await readFile(
      join(workspace, 'claude-desktop-config.fragment.json'),
      'utf8',
    );
    const config = JSON.parse(configText).mcpServers.atlas;
    assert.equal(config.command, process.execPath);
    assert.equal(config.args[1], resolve('server/mcp-local.ts'));
    assert.equal(config.env.ATLAS_DATA_DIR, directory);
    assert.equal(config.env.ATLAS_PORT, '45678');
    assert.equal(configText.includes(token), false);
    const shared = await readFile(sharedFilename, 'utf8');
    assert.ok(shared.includes(existing));
    assert.equal(shared.includes(token), false);
    const parsed = getStaticTOMLValue(parseTOML(shared)) as Record<string, any>;
    assert.equal(parsed.mcp_servers.atlas.command, process.execPath);
    assert.equal(parsed.mcp_servers.atlas.env.ATLAS_PORT, '45678');
    assert.equal(parsed.mcp_servers.corpus.command, 'corpus-node');
    // AGENTS.md links to the checked-in template; personal instructions live beside it.
    // Never write through the link: that would overwrite the repository template.
    const template = resolve('assistant-workspace/AGENTS.md');
    const templateText = await readFile(template, 'utf8');
    assert.ok((await lstat(join(workspace, 'AGENTS.md'))).isSymbolicLink());
    assert.equal(await realpath(join(workspace, 'AGENTS.md')), await realpath(template));
    const custom = 'My private research instructions';
    await writeFile(join(workspace, 'AGENTS.local.md'), custom);
    const repeated = await run();
    assert.match(repeated.stdout, /already registered/);
    assert.equal(await readFile(sharedFilename, 'utf8'), shared);
    assert.equal(await readFile(join(workspace, 'AGENTS.local.md'), 'utf8'), custom);
    assert.equal(await realpath(join(workspace, 'AGENTS.md')), await realpath(template));
    assert.equal(await readFile(template, 'utf8'), templateText);
    assert.equal(
      await readFile(join(workspace, 'claude-desktop-config.fragment.json'), 'utf8'),
      configText,
    );
    await mkdir(join(workspace, '.codex'), { recursive: true });
    const legacy = join(workspace, '.codex', 'config.toml');
    await writeFile(
      legacy,
      '[mcp_servers.atlas]\ncommand="old-node"\n[mcp_servers.atlas.env]\nATLAS_PORT="11111"\n',
    );
    await run();
    const migrated = getStaticTOMLValue(parseTOML(await readFile(legacy, 'utf8'))) as Record<
      string,
      any
    >;
    assert.equal(migrated.mcp_servers.atlas.command, process.execPath);
    assert.equal(migrated.mcp_servers.atlas.env.ATLAS_PORT, '45678');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bridge fails clearly without a credential and rejects invalid ports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas missing '));
  try {
    await assert.rejects(
      exec(process.execPath, ['--experimental-strip-types', 'server/mcp-local.ts'], {
        env: { ...process.env, ATLAS_DATA_DIR: directory },
      }),
      (error: unknown) => {
        const failure = error as { stdout: string; stderr: string };
        assert.equal(failure.stdout, '');
        assert.match(failure.stderr, /Start Atlas with npm start/);
        return true;
      },
    );
    for (const value of ['0', '65536', '3210/path', 'https://example.com', '1.5'])
      assert.throws(() => assistantOrigin(value), /ATLAS_PORT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
