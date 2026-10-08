import { mkdir, writeFile, access, lstat, rename, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  installAssistantInstructions,
  installAssistantSkillLinks,
  registerAssistant,
  registerClaudeDesktop,
  sharedCodexConfig,
  claudeDesktopConfig,
  generatedClaudeInstructionsHash,
  hashInstructions,
} from './register-assistant.ts';
import { assistantOrigin } from '../server/assistant-access.ts';
import { atlasDataDirectory } from '../server/paths.ts';
process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = atlasDataDirectory();
const origin = assistantOrigin();
const port = new URL(origin).port;
const options = process.argv.slice(2);
const registerClaudeCode = options.includes('--claude-code');
const workspaceArgument = options.find((option) => !option.startsWith('--'));
const workspace = resolve(workspaceArgument || join(dataDirectory, 'assistant-workspace'));
if (workspace === root.slice(0, -1) || workspace.startsWith(root))
  throw new Error('Choose an assistant workspace outside the development repository.');
await mkdir(workspace, { recursive: true, mode: 0o700 });
const instructionBackup = await installAssistantInstructions(
  workspace,
  join(root, 'assistant-workspace', 'AGENTS.md'),
);
if (instructionBackup)
  console.log(`Preserved previous research instructions in ${instructionBackup}`);
const legacyClaude = join(workspace, 'CLAUDE.md');
try {
  await lstat(legacyClaude);
  const old = await readFile(legacyClaude, 'utf8');
  const backupDir = join(workspace, '.atlas-backups');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `CLAUDE-${randomUUID()}.md`);
  await rename(legacyClaude, backup);
  if (hashInstructions(old) !== generatedClaudeInstructionsHash) {
    await writeFile(join(workspace, 'AGENTS.local.md'), old, { flag: 'wx', mode: 0o600 }).catch(
      (error) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
  }
  console.log(`Preserved obsolete Claude instructions in ${backup}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const server = {
  command: process.execPath,
  args: ['--experimental-strip-types', join(root, 'server', 'mcp-local.ts')],
  env: { ATLAS_DATA_DIR: dataDirectory, ATLAS_PORT: port },
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
const registration = await registerAssistant(sharedCodexConfig(), server, workspace);
const desktop = await registerClaudeDesktop(claudeDesktopConfig(), server);
// Claude Code owns ~/.claude.json, so register through its CLI rather than editing it.
let claudeCode = '';
if (registerClaudeCode) {
  const claude = (...args: string[]) =>
    spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (claude('--version').error) claudeCode = 'Claude Code: claude CLI not found; skipped.\n';
  else {
    claude('mcp', 'remove', '--scope', 'user', 'atlas');
    const added = claude(
      'mcp',
      'add-json',
      '--scope',
      'user',
      'atlas',
      JSON.stringify({ type: 'stdio', ...server }),
    );
    if (added.status !== 0)
      throw new Error(`Claude Code registration failed: ${added.stderr.trim()}`);
    claudeCode = 'Claude Code: Atlas registered for your user (claude mcp list to check).\n';
  }
}
// Refresh the legacy project-local entry if setup created one in an earlier release.
// New workspaces use only the shared registration, avoiding stale local overrides.
try {
  await access(join(workspace, '.codex', 'config.toml'));
  await registerAssistant(join(workspace, '.codex', 'config.toml'), server, workspace);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const skillBackups = await installAssistantSkillLinks(
  workspace,
  join(root, 'assistant-workspace', 'skills'),
);
for (const backup of skillBackups) console.log(`Preserved previous skill in ${backup}`);
console.log(
  `Atlas research workspace: ${workspace}\nChatGPT Desktop / Codex: Atlas ${registration.changed ? 'registered' : 'already registered'} in ${registration.filename}\n${registration.backup ? `Previous configuration backed up to ${registration.backup}\n` : ''}Claude Desktop: Atlas ${desktop.changed ? 'registered' : 'already registered'} in ${desktop.filename}\n${desktop.backup ? `Previous configuration backed up to ${desktop.backup}\n` : ''}${claudeCode}Restart ChatGPT Desktop and Claude Desktop (or their MCP connections) to load Atlas. No manual server entry is needed.\n\nKeep Atlas running with npm start (or npm run dev) at ${origin}. The bridge reads its credential automatically; setup never prints it.\nCodex and Claude Code skill entries link to ${join(root, 'assistant-workspace', 'skills')}. Run those agents from this workspace for local skill discovery. Desktop chats can retrieve workflows through Atlas MCP. Previous instructions and skills were preserved under ${join(workspace, '.atlas-backups')} when migration was needed. Other shared settings and MCP servers were preserved. Re-run setup after changing Node, checkout location, data directory, or port.`,
);
