import { mkdir, cp, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atlasDataDirectory } from '../server/paths.ts';
process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = atlasDataDirectory();
const workspace = resolve(process.argv[2] || join(dataDirectory, 'assistant-workspace'));
if (workspace === root.slice(0, -1) || workspace.startsWith(root))
  throw new Error('Choose an assistant workspace outside the development repository.');
await mkdir(workspace, { recursive: true, mode: 0o700 });
for (const name of ['AGENTS.md', 'CLAUDE.md', 'skills']) {
  const destination = join(workspace, name);
  try {
    await access(destination);
    console.log(`Keeping existing ${destination}`);
  } catch {
    await cp(join(root, 'assistant-workspace', name), destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}
const server = {
  command: process.execPath,
  args: ['--experimental-strip-types', join(root, 'server', 'mcp.ts')],
  env: { ATLAS_DATA_DIR: dataDirectory },
};
const config = { mcpServers: { atlas: server } };
async function createOnly(path: string, body: string) {
  await writeFile(path, body, { flag: 'wx', mode: 0o600 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Keeping existing ${path}`);
  });
}
await createOnly(
  join(workspace, 'claude-desktop-config.fragment.json'),
  JSON.stringify(config, null, 2) + '\n',
);
await createOnly(join(workspace, '.mcp.json'), JSON.stringify(config, null, 2) + '\n');
await mkdir(join(workspace, '.codex'), { recursive: true });
await createOnly(
  join(workspace, '.codex', 'config.toml'),
  `[mcp_servers.atlas]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n[mcp_servers.atlas.env]\nATLAS_DATA_DIR = ${JSON.stringify(dataDirectory)}\n`,
);
for (const host of ['.agents', '.claude']) {
  await mkdir(join(workspace, host), { recursive: true });
  try {
    await access(join(workspace, host, 'skills'));
  } catch {
    await cp(join(workspace, 'skills'), join(workspace, host, 'skills'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
}
console.log(
  `Atlas research workspace: ${workspace}\nClaude Desktop connection fragment: ${join(workspace, 'claude-desktop-config.fragment.json')}\nMCP uses the existing Atlas database. Existing files were preserved. No app settings or external connections were changed.`,
);
