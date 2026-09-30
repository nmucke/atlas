import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AssistantService } from './assistant-service.ts';
import { createAtlasMcp } from './mcp.ts';
import { assistantRequests, assistantTimeout } from './mcp-protocol.ts';
import { authorizedAssistant } from './assistant-access.ts';
import { json, readJson } from './http.ts';

// Dispatch through the same SDK registration and validation used by MCP tests.
// This client never exposes the application's general HTTP routes.
export async function createAssistantRpc(service: AssistantService, token: string) {
  const mcp = createAtlasMcp(service);
  const client = new Client({ name: 'atlas-local-bridge', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      if (!authorizedAssistant(req.headers.authorization, token))
        return json(res, 401, { error: 'A valid Atlas assistant credential is required.' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
      try {
        const body = await readJson(req, 2 * 1024 * 1024);
        const schema = assistantRequests.find(
          (schema) => schema.shape.method.value === body.method,
        );
        if (!schema) return json(res, 400, { error: 'Unknown assistant operation.' });
        const request = schema.parse(body);
        // MCP permits omitted prompt arguments; the SDK expects an object.
        if (request.method === 'prompts/get') request.params.arguments ??= {};
        const result = await client.request(request, ResultSchema, { timeout: assistantTimeout });
        return json(res, 200, result);
      } catch {
        return json(res, 400, { error: 'Invalid assistant request or unavailable operation.' });
      }
    },
    async close() {
      await client.close();
      await mcp.close();
    },
  };
}
