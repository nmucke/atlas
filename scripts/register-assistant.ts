import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser';

export type AssistantConnection = {
  command: string;
  args: string[];
  env: { ATLAS_DATA_DIR: string; ATLAS_PORT: string };
};
// The original generated instructions were copied into existing workspaces.
// Recognize that exact version so migration does not activate it as a local override.
export const generatedAssistantInstructionsHash =
  'cd162d4a8e1879805bd0adec2a737e9fa3095f45412927f461d52a24f16428d2';
export const generatedClaudeInstructionsHash =
  'adaa7350429cbab1138447f3e2c323b4ca54ed1dc160255afb584e8848ecc6ab';
export const hashInstructions = (body: string) => createHash('sha256').update(body).digest('hex');
export function sharedCodexConfig() {
  return join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'config.toml');
}
function parse(text: string) {
  try {
    return parseTOML(text, { tomlVersion: '1.0' });
  } catch {
    // Parser diagnostics can include private config values.
    throw new Error(
      'The existing Codex configuration is not valid TOML. No settings were changed.',
    );
  }
}
type Container = AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;
type Path = (string | number)[];
const prefix = (parent: Path, child: Path) => parent.every((key, i) => child[i] === key);

// Work on parser ranges, not regex section matching: comments, quoted keys,
// multiline strings, inline tables and unrelated settings must survive verbatim.
function setValue(text: string, path: string[], value: unknown): string {
  const ast = parse(text);
  const containers: { path: Path; node: Container }[] = [];
  const entries: { path: Path; node: AST.TOMLKeyValue }[] = [];
  function visit(node: Container, base: Path) {
    containers.push({ path: base, node });
    for (const child of node.body) {
      if (child.type === 'TOMLTable') visit(child, child.resolvedKey);
      else {
        const key = [...base, ...getStaticTOMLValue(child.key)];
        entries.push({ path: key, node: child });
        if (child.value.type === 'TOMLInlineTable') visit(child.value, key);
      }
    }
  }
  visit(ast.body[0], []);
  const existing = entries.find((entry) => isDeepStrictEqual(entry.path, path));
  const encoded = JSON.stringify(value);
  if (existing) {
    if (isDeepStrictEqual(getStaticTOMLValue(existing.node.value), value)) return text;
    const [start, end] = existing.node.value.range;
    return text.slice(0, start) + encoded + text.slice(end);
  }
  if (
    entries.some((entry) => prefix(entry.path, path) && entry.node.value.type !== 'TOMLInlineTable')
  )
    throw new Error(
      'Atlas MCP configuration has an incompatible table value. No settings were changed.',
    );
  const container = containers
    .filter((entry) => prefix(entry.path, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const assignment = `${path
    .slice(container.path.length)
    .map((key) => JSON.stringify(key))
    .join('.')} = ${encoded}`;
  const node = container.node;
  if (node.type === 'TOMLInlineTable') {
    const at = node.range[1] - 1;
    return text.slice(0, at) + (node.body.length ? ', ' : '') + assignment + text.slice(at);
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (node.type === 'TOMLTopLevelTable') return assignment + newline + text;
  const lineEnd = text.indexOf('\n', node.range[1]);
  const at = lineEnd < 0 ? text.length : lineEnd + 1;
  return text.slice(0, at) + (lineEnd < 0 ? newline : '') + assignment + newline + text.slice(at);
}
export function updateAtlasConfig(
  text: string,
  connection: AssistantConnection,
  workspace: string,
) {
  const before = getStaticTOMLValue(parse(text));
  const servers = before.mcp_servers;
  if (
    servers !== undefined &&
    (!servers || typeof servers !== 'object' || Array.isArray(servers) || servers instanceof Date)
  )
    throw new Error('mcp_servers must be a TOML table. No settings were changed.');
  const atlas =
    servers && typeof servers === 'object' && !Array.isArray(servers) && !(servers instanceof Date)
      ? servers.atlas
      : undefined;
  if (atlas && typeof atlas === 'object' && !Array.isArray(atlas) && 'url' in atlas)
    throw new Error(
      'An HTTP MCP server already uses the name atlas. Rename that entry before registering the local bridge. No settings were changed.',
    );
  let updated = text;
  for (const [key, value] of Object.entries({
    command: connection.command,
    args: connection.args,
    cwd: workspace,
    tool_timeout_sec: 600,
  }))
    updated = setValue(updated, ['mcp_servers', 'atlas', key], value);
  for (const [key, value] of Object.entries(connection.env))
    updated = setValue(updated, ['mcp_servers', 'atlas', 'env', key], value);
  parse(updated);
  return updated;
}

export async function registerAssistant(
  filename: string,
  connection: AssistantConnection,
  workspace: string,
) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  // Respect a user's symlinked configuration instead of replacing the symlink.
  try {
    if ((await lstat(filename)).isSymbolicLink()) filename = await realpath(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lockname = `${filename}.atlas-setup.lock`;
  const lock = await open(lockname, 'wx', 0o600).catch(() => {
    throw new Error(
      `Cannot lock ${filename}. Check permissions or whether another Atlas setup is running.`,
    );
  });
  const temporary = `${filename}.atlas-${randomUUID()}.tmp`;
  try {
    let original: string | undefined;
    try {
      original = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const updated = updateAtlasConfig(original ?? '', connection, workspace);
    if (updated === original) return { filename, changed: false, backup: undefined };
    const backup = original === undefined ? undefined : `${filename}.atlas-backup-${randomUUID()}`;
    if (backup) await writeFile(backup, original!, { flag: 'wx', mode: 0o600 });
    await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    const current = await readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current !== original)
      throw new Error('Codex configuration changed during setup. Please run setup again.');
    await rename(temporary, filename);
    return { filename, changed: true, backup };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockname, { force: true });
  }
}

// The checked-in templates are canonical. Private workspace and host entries
// all resolve to them, so a checkout update cannot leave installed copies stale.
export async function installAssistantSkillLinks(workspace: string, templates: string) {
  const privateSkills = join(workspace, 'skills');
  let privateRootIsCanonical = false;
  try {
    if ((await lstat(privateSkills)).isSymbolicLink()) {
      if ((await realpath(privateSkills)) !== (await realpath(templates)))
        throw new Error(`Refusing to replace an unrelated skills link at ${privateSkills}`);
      privateRootIsCanonical = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!privateRootIsCanonical) await mkdir(privateSkills, { recursive: true, mode: 0o700 });
  const backupDir = join(workspace, '.atlas-backups');
  const names = (await readdir(templates, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const backups: string[] = [];
  for (const name of privateRootIsCanonical ? [] : names) {
    const link = join(privateSkills, name);
    const target = join(templates, name);
    let existing: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      existing = await lstat(link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      existing?.isSymbolicLink() &&
      (await realpath(link).catch(() => undefined)) === (await realpath(target))
    )
      continue;
    if (existing) {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const backup = join(backupDir, `skill-${name}-${randomUUID()}`);
      await rename(link, backup);
      backups.push(backup);
    }
    await symlink(target, link, 'dir');
  }
  for (const host of ['.agents', '.claude']) {
    const hostSkills = join(workspace, host, 'skills');
    try {
      if ((await lstat(hostSkills)).isSymbolicLink()) {
        if ((await realpath(hostSkills)) !== (await realpath(privateSkills)))
          throw new Error(`Refusing to replace an unrelated skills link at ${hostSkills}`);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(hostSkills, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const link = join(hostSkills, name);
      const target = join(privateSkills, name);
      let existing: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        existing = await lstat(link);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        existing?.isSymbolicLink() &&
        (await realpath(link).catch(() => undefined)) === (await realpath(target))
      )
        continue;
      if (existing) {
        await mkdir(backupDir, { recursive: true, mode: 0o700 });
        const backup = join(backupDir, `skill-${host.slice(1)}-${name}-${randomUUID()}`);
        await rename(link, backup);
        backups.push(backup);
      }
      // A relative target survives moving the private workspace as a unit.
      await symlink(join('..', '..', 'skills', name), link, 'dir');
    }
  }
  return backups;
}

export async function installAssistantInstructions(workspace: string, template: string) {
  const link = join(workspace, 'AGENTS.md');
  const target = await realpath(template);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink() && (await realpath(link).catch(() => undefined)) === target)
    return undefined;
  let backup: string | undefined;
  if (existing) {
    const old = existing.isFile() ? await readFile(link, 'utf8') : undefined;
    const backupDir = join(workspace, '.atlas-backups');
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    backup = join(backupDir, `AGENTS-${randomUUID()}.md`);
    await rename(link, backup);
    if (
      old !== undefined &&
      old !== (await readFile(template, 'utf8')) &&
      hashInstructions(old) !== generatedAssistantInstructionsHash
    ) {
      const local = join(workspace, 'AGENTS.local.md');
      try {
        await writeFile(local, old, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  await symlink(target, link, 'file');
  return backup;
}
