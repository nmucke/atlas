import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  symlink,
  lstat,
  mkdir,
  utimes,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import {
  updateAtlasConfig,
  updateClaudeDesktopConfig,
  registerAssistant,
  installAssistantSkillLinks,
  installAssistantInstructions,
  registerClaudeDesktop,
  windowsCommandLine,
} from '../scripts/register-assistant.ts';

const connection = {
  command: 'C:\\Program Files\\node.exe',
  args: ['--experimental-strip-types', '/checkout with spaces/server/mcp-local.ts'],
  env: { ATLAS_DATA_DIR: '/private data/atlas', ATLAS_PORT: '3210' },
};
const workspace = '/private data/atlas/assistant-workspace';
const parse = (text: string) => getStaticTOMLValue(parseTOML(text)) as Record<string, any>;

for (const fixture of [
  '',
  '# Keep this comment\nmodel = "my-model"\n[mcp_servers.corpus]\ncommand = "keep" # corpus\n',
  '[mcp_servers."atlas"] # my connection\ncommand = "old" # node\nenabled = false\n[mcp_servers.atlas.env]\nCUSTOM = "keep"\n[mcp_servers.corpus]\ncommand="keep"\n',
  'mcp_servers = { atlas = { command = "old", env = { CUSTOM = "keep" } }, corpus = { command = "keep" } }\n',
  '[mcp_servers]\n"atlas".command = "old"\natlas.env.CUSTOM = "keep"\ncorpus.command="keep"\n',
  "message = '''\n[mcp_servers.atlas]\ncommand = 'not a table'\n'''\n[mcp_servers.atlas.env]\nCUSTOM = 'keep'\n",
  '# CRLF\r\n[mcp_servers.atlas]\r\ncommand = "old" # keep\r\n',
]) {
  test(`shared registration preserves TOML settings and is idempotent: fixture ${fixture.length}`, () => {
    const original = parse(fixture);
    const updated = updateAtlasConfig(fixture, connection, workspace);
    const actual = parse(updated);
    assert.equal(actual.mcp_servers.atlas.command, connection.command);
    assert.deepEqual(actual.mcp_servers.atlas.args, connection.args);
    assert.equal(actual.mcp_servers.atlas.cwd, workspace);
    assert.equal(actual.mcp_servers.atlas.env.ATLAS_PORT, '3210');
    assert.equal(actual.mcp_servers.atlas.env.ATLAS_DATA_DIR, connection.env.ATLAS_DATA_DIR);
    if (original.mcp_servers?.atlas?.env?.CUSTOM)
      assert.equal(actual.mcp_servers.atlas.env.CUSTOM, 'keep');
    if (original.mcp_servers?.atlas?.enabled === false)
      assert.equal(actual.mcp_servers.atlas.enabled, false);
    delete actual.mcp_servers.atlas;
    if (original.mcp_servers) delete original.mcp_servers.atlas;
    else original.mcp_servers = {};
    assert.deepEqual(actual, original);
    for (const comment of parseTOML(fixture).comments) assert.ok(updated.includes(comment.value));
    assert.equal(updateAtlasConfig(updated, connection, workspace), updated);
    const moved = {
      ...connection,
      args: ['/new checkout/bridge.ts'],
      env: { ...connection.env, ATLAS_PORT: '45678' },
    };
    const changed = parse(updateAtlasConfig(updated, moved, workspace));
    assert.deepEqual(changed.mcp_servers.atlas.args, moved.args);
    assert.equal(changed.mcp_servers.atlas.env.ATLAS_PORT, '45678');
  });
}

test('malformed or conflicting config fails without exposing content', () => {
  for (const text of [
    'secret = "private invalid',
    'mcp_servers = "wrong type"',
    'mcp_servers.atlas = false',
    '[mcp_servers.atlas]\nurl="https://private.example"',
  ]) {
    assert.throws(
      () => updateAtlasConfig(text, connection, workspace),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /No settings were changed/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
  }
});

test('Claude Desktop registration preserves other settings and is idempotent', () => {
  const original = {
    mcpServers: {
      corpus: { command: 'keep' },
      atlas: { command: 'old', args: ['/old/mcp.ts'], env: { CUSTOM: 'keep' }, extra: true },
    },
    preferences: { theme: 'dark' },
  };
  const updated = updateClaudeDesktopConfig(JSON.stringify(original), connection);
  const actual = JSON.parse(updated);
  assert.equal(actual.mcpServers.atlas.command, connection.command);
  assert.deepEqual(actual.mcpServers.atlas.args, connection.args);
  assert.deepEqual(actual.mcpServers.atlas.env, { CUSTOM: 'keep', ...connection.env });
  assert.equal(actual.mcpServers.atlas.extra, true);
  assert.deepEqual(actual.mcpServers.corpus, original.mcpServers.corpus);
  assert.deepEqual(actual.preferences, original.preferences);
  assert.equal(updateClaudeDesktopConfig(updated, connection), updated);
  assert.equal(
    JSON.parse(updateClaudeDesktopConfig('', connection)).mcpServers.atlas.command,
    connection.command,
  );
  for (const text of [
    '{"secret": "private',
    '[]',
    '{"mcpServers": 1}',
    '{"mcpServers": {"atlas": {"url": "https://private.example"}}}',
  ])
    assert.throws(
      () => updateClaudeDesktopConfig(text, connection),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /No settings were changed/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
});

test('registration backs up exact bytes, writes privately, and does not duplicate backups on rerun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas config '));
  const filename = join(dir, 'config.toml');
  try {
    const original = '# personal settings\n[mcp_servers.corpus]\ncommand="keep"\n';
    await writeFile(filename, original);
    const result = await registerAssistant(filename, connection, workspace);
    assert.equal(result.changed, true);
    assert.ok(result.backup);
    assert.equal(await readFile(result.backup, 'utf8'), original);
    const next = await registerAssistant(filename, connection, workspace);
    assert.equal(next.changed, false);
    assert.equal((await readdir(dir)).length, 2);
    if (process.platform !== 'win32') {
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
    }
    await writeFile(filename, 'invalid secret = ???');
    await assert.rejects(registerAssistant(filename, connection, workspace), /not valid TOML/);
    assert.equal(await readFile(filename, 'utf8'), 'invalid secret = ???');
    assert.equal((await readdir(dir)).length, 2);
    await writeFile(`${filename}.atlas-setup.lock`, '');
    await assert.rejects(registerAssistant(filename, connection, workspace), /Cannot lock/);
    assert.equal(await readFile(filename, 'utf8'), 'invalid secret = ???');
    await writeFile(`${filename}.atlas-setup.lock`, `${process.pid}\n`);
    await assert.rejects(
      registerAssistant(filename, connection, workspace),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`${filename}.atlas-setup.lock`) &&
        /another Atlas setup/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'registration creates missing config and preserves symlinked config',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas symlink '));
    try {
      const filename = join(dir, 'custom-home', 'config.toml');
      assert.equal((await registerAssistant(filename, connection, workspace)).backup, undefined);
      const link = join(dir, 'config.toml');
      await symlink(filename, link);
      await registerAssistant(link, { ...connection, command: '/new/node' }, workspace);
      assert.ok((await lstat(link)).isSymbolicLink());
      assert.equal(parse(await readFile(filename, 'utf8')).mcp_servers.atlas.command, '/new/node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('Codex and Claude skill links share one source and preserve previous copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas skills '));
  try {
    const templates = join(dir, 'templates');
    const workspace = join(dir, 'workspace');
    await mkdir(join(templates, 'atlas-one'), { recursive: true });
    await writeFile(join(templates, 'atlas-one', 'SKILL.md'), 'canonical');
    await mkdir(join(workspace, '.claude', 'skills', 'atlas-one'), { recursive: true });
    await writeFile(join(workspace, '.claude', 'skills', 'atlas-one', 'SKILL.md'), 'previous');
    await mkdir(join(workspace, '.claude', 'skills', 'personal'), { recursive: true });
    await writeFile(join(workspace, '.claude', 'skills', 'personal', 'SKILL.md'), 'personal');
    const backups = await installAssistantSkillLinks(workspace, templates);
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(backups[0], 'SKILL.md'), 'utf8'), 'previous');
    assert.ok(backups.every((path) => path.includes(`${sep}.atlas-backups${sep}`)));
    assert.equal(
      await readFile(join(workspace, '.claude', 'skills', 'personal', 'SKILL.md'), 'utf8'),
      'personal',
    );
    for (const host of ['.agents', '.claude']) {
      const link = join(workspace, host, 'skills', 'atlas-one');
      assert.ok((await lstat(link)).isSymbolicLink());
      assert.equal(await readFile(join(link, 'SKILL.md'), 'utf8'), 'canonical');
    }
    assert.deepEqual(await installAssistantSkillLinks(workspace, templates), []);
    assert.deepEqual(await readdir(join(workspace, '.claude', 'skills')), [
      'atlas-one',
      'personal',
    ]);
    await writeFile(join(templates, 'atlas-one', 'SKILL.md'), 'updated');
    assert.equal(
      await readFile(join(workspace, '.agents', 'skills', 'atlas-one', 'SKILL.md'), 'utf8'),
      'updated',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'canonical AGENTS link preserves prior custom instructions',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas agents '));
    try {
      const template = join(dir, 'canonical.md');
      const workspace = join(dir, 'workspace');
      await mkdir(workspace);
      await writeFile(template, 'current');
      await writeFile(join(workspace, 'AGENTS.md'), 'my preference');
      const backup = await installAssistantInstructions(workspace, template);
      assert.ok(backup);
      assert.equal(await readFile(backup, 'utf8'), 'my preference');
      assert.equal(await readFile(join(workspace, 'AGENTS.local.md'), 'utf8'), 'my preference');
      assert.ok((await lstat(join(workspace, 'AGENTS.md'))).isSymbolicLink());
      assert.equal(await installAssistantInstructions(workspace, template), undefined);
      await writeFile(template, 'updated');
      assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), 'updated');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'existing skills root links are left intact',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas linked roots '));
    try {
      const templates = join(dir, 'templates');
      const workspace = join(dir, 'workspace');
      await mkdir(join(templates, 'atlas-one'), { recursive: true });
      await writeFile(join(templates, 'atlas-one', 'SKILL.md'), 'canonical');
      await mkdir(join(workspace, '.agents'), { recursive: true });
      await symlink(templates, join(workspace, 'skills'), 'dir');
      await symlink(join(workspace, 'skills'), join(workspace, '.agents', 'skills'), 'dir');
      assert.deepEqual(await installAssistantSkillLinks(workspace, templates), []);
      assert.equal(await readFile(join(templates, 'atlas-one', 'SKILL.md'), 'utf8'), 'canonical');
      assert.ok((await lstat(join(workspace, '.agents', 'skills'))).isSymbolicLink());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('a byte-order mark does not make existing configurations invalid', () => {
  const toml = '\uFEFF# personal\n[mcp_servers.corpus]\ncommand = "keep"\n';
  const updated = updateAtlasConfig(toml, connection, workspace);
  assert.equal(parse(updated).mcp_servers.atlas.command, connection.command);
  assert.equal(parse(updated).mcp_servers.corpus.command, 'keep');
  assert.equal(updateAtlasConfig('\uFEFF' + updated, connection, workspace), '\uFEFF' + updated);
  const json = '\uFEFF{"mcpServers": {"corpus": {"command": "keep"}}}';
  const desktop = JSON.parse(updateClaudeDesktopConfig(json, connection));
  assert.equal(desktop.mcpServers.atlas.command, connection.command);
  assert.equal(desktop.mcpServers.corpus.command, 'keep');
  const current = '\uFEFF' + updateClaudeDesktopConfig('', connection);
  assert.equal(updateClaudeDesktopConfig(current, connection), current);
});

test('locks left by an interrupted setup are replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas lock '));
  try {
    const filename = join(dir, 'config.toml');
    const lockname = `${filename}.atlas-setup.lock`;
    const finished = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(lockname, `${finished}\n`);
    assert.equal((await registerAssistant(filename, connection, workspace)).changed, true);
    await assert.rejects(stat(lockname), { code: 'ENOENT' });
    await writeFile(lockname, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(lockname, old, old);
    const moved = { ...connection, env: { ...connection.env, ATLAS_PORT: '45678' } };
    assert.equal((await registerAssistant(filename, moved, workspace)).changed, true);
    assert.equal(parse(await readFile(filename, 'utf8')).mcp_servers.atlas.env.ATLAS_PORT, '45678');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace MCP files are refreshed on re-run and keep other servers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas workspace mcp '));
  try {
    const filename = join(dir, '.mcp.json');
    await writeFile(
      filename,
      JSON.stringify({ mcpServers: { atlas: { command: '/old/node' }, other: { command: 'x' } } }),
    );
    const result = await registerClaudeDesktop(filename, connection, 'Workspace .mcp.json');
    assert.equal(result.changed, true);
    const actual = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(actual.mcpServers.atlas.command, connection.command);
    assert.deepEqual(actual.mcpServers.atlas.env, connection.env);
    assert.equal(actual.mcpServers.other.command, 'x');
    assert.equal(
      (await registerClaudeDesktop(filename, connection, 'Workspace .mcp.json')).changed,
      false,
    );
    await writeFile(filename, '{"broken"');
    await assert.rejects(
      registerClaudeDesktop(filename, connection, 'Workspace .mcp.json'),
      /Workspace \.mcp\.json configuration is not valid JSON/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AGENTS falls back to a tracked copy when file symlinks are not permitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas agents copy '));
  const denied = async () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  try {
    const template = join(dir, 'canonical.md');
    const workspace = join(dir, 'workspace');
    const agents = join(workspace, 'AGENTS.md');
    await mkdir(workspace);
    await writeFile(template, 'v1');
    assert.equal(await installAssistantInstructions(workspace, template, denied), undefined);
    assert.equal(await readFile(agents, 'utf8'), 'v1');
    assert.equal(await installAssistantInstructions(workspace, template, denied), undefined);
    await writeFile(template, 'v2');
    assert.equal(await installAssistantInstructions(workspace, template, denied), undefined);
    assert.equal(await readFile(agents, 'utf8'), 'v2');
    await writeFile(agents, 'my edit');
    await writeFile(template, 'v3');
    const backup = await installAssistantInstructions(workspace, template, denied);
    assert.ok(backup);
    assert.equal(await readFile(backup, 'utf8'), 'my edit');
    assert.equal(await readFile(join(workspace, 'AGENTS.local.md'), 'utf8'), 'my edit');
    assert.equal(await readFile(agents, 'utf8'), 'v3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Microsoft C runtime argument splitting, as used by node.exe and other Windows programs.
function windowsArgv(line: string) {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') {
      let count = 0;
      while (line[i] === '\\') (count++, i++);
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) current += '"';
        else ((quoted = !quoted), (started = true));
      } else ((current += '\\'.repeat(count)), i--);
      started = true;
    } else if (char === '"') ((quoted = !quoted), (started = true));
    else if (/\s/.test(char) && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else ((current += char), (started = true));
  }
  if (started) args.push(current);
  return args;
}

test('Windows command lines keep JSON and paths with spaces as single arguments', () => {
  const entry = JSON.stringify({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\dir\\', 'say "hi"'],
  });
  for (const args of [['mcp', 'add-json', 'atlas', entry], ['C:\\a b\\'], [''], ['plain']])
    assert.deepEqual(windowsArgv(windowsCommandLine('claude', args)!), ['claude', ...args]);
  assert.equal(windowsCommandLine('claude', ['C:\\100%\\x']), null);
  assert.equal(windowsCommandLine('claude', ['a&b']), null);
});
