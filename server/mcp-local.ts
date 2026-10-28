import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { atlasDataDirectory } from './paths.ts';
import { assistantOrigin, readAssistantToken } from './assistant-access.ts';
import { assistantInstructions, assistantRequests, assistantTimeout } from './mcp-protocol.ts';

export async function createLocalBridge() {
  const token = await readAssistantToken(atlasDataDirectory());
  const origin = assistantOrigin();
  const server = new Server(
    { name: 'atlas', version: '0.2.0' },
    {
      instructions: assistantInstructions,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );
  for (const schema of assistantRequests) {
    server.setRequestHandler(schema, async (request, extra) => {
      let response: Response;
      try {
        response = await fetch(`${origin}/api/assistant/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
          redirect: 'error',
          signal: AbortSignal.any([extra.signal, AbortSignal.timeout(assistantTimeout)]),
        });
      } catch {
        throw new Error(
          'Atlas is unavailable. Start npm start and check ATLAS_PORT and ATLAS_DATA_DIR. No automatic retry was made.',
        );
      }
      if (response.status === 401)
        throw new Error(
          'Atlas credential mismatch. Check ATLAS_DATA_DIR and restart the desktop MCP server.',
        );
      if (!response.ok)
        throw new Error(
          `Atlas rejected ${request.method}. Check the server version and restart Atlas.`,
        );
      return ResultSchema.parse(await response.json());
    });
  }
  return server;
}
export async function runLocalBridge() {
  try {
    const server = await createLocalBridge();
    await server.connect(new StdioServerTransport());
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        void server.close().finally(() => process.exit(0));
      });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Atlas MCP bridge could not start.'}\n`,
    );
    process.exitCode = 1;
  }
}
// Compare real paths so a symlinked checkout or drive-letter case still starts the bridge.
const isMain = (path: string) => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path);
  } catch {
    return false;
  }
};
if (process.argv[1] && isMain(process.argv[1])) await runLocalBridge();
