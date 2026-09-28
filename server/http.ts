import type { IncomingMessage, ServerResponse } from 'node:http';
export function secureRequest(req: IncomingMessage, port: number) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!req.headers.host || !hosts.has(req.headers.host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin))
    return false;
  return true;
}
export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}
export async function readJson(
  req: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Expected a JSON object');
  return body;
}
