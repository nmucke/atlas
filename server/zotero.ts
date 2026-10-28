import { fileURLToPath } from 'node:url';
import type { Snapshot, SourceItem } from './database.ts';
export const ZOTERO_BASE = 'http://127.0.0.1:23119/api';
export const ZOTERO_TIMEOUT_MESSAGE =
  'Zotero did not respond within 60 seconds. If it is still starting or syncing a large library, wait and try again.';
export const ZOTERO_TOO_OLD_MESSAGE =
  'Atlas needs Zotero 7 or newer with “Allow other applications on this computer to communicate with Zotero” enabled (Settings → Advanced).';
// AbortSignal.timeout rejects with TimeoutError; an aborted body stream can surface AbortError.
function timedOut(error: unknown) {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
export class ZoteroClient {
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }
  async request(path: string, serverId?: string | null) {
    let response: Response;
    try {
      response = await this.fetcher(`${ZOTERO_BASE}${path}`, {
        headers: {
          'Zotero-API-Version': '3',
          'Zotero-Allowed-Request': 'true',
          ...(serverId ? { 'Zotero-Server-ID': serverId } : {}),
        },
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      });
    } catch (error) {
      if (timedOut(error)) throw new Error(ZOTERO_TIMEOUT_MESSAGE);
      throw new Error(
        'Cannot reach Zotero. Open Zotero and enable “Allow other applications on this computer to communicate with Zotero” in Settings → Advanced, then try again.',
      );
    }
    if (!response.ok) {
      if (response.status === 403)
        throw new Error(
          'Zotero access is disabled. Enable “Allow other applications on this computer to communicate with Zotero” in Settings → Advanced.',
        );
      if (response.status === 404)
        throw Object.assign(
          new Error(
            'Zotero could not find this resource. For PDFs, download the attachment in Zotero first.',
          ),
          { status: 404 },
        );
      if (response.status === 412)
        throw new Error(
          'The Zotero library has changed. Sync again before opening this attachment.',
        );
      throw new Error(`Zotero returned HTTP ${response.status}. No local data was changed.`);
    }
    return response;
  }
  async text(response: Response) {
    // Avoid unbounded buffering if a local service returns an unexpected response.
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The request timeout also covers the body; report it like a slow response.
        if (timedOut(error)) throw new Error(ZOTERO_TIMEOUT_MESSAGE);
        throw error;
      }
      const { done, value } = chunk;
      if (done) break;
      size += value.length;
      if (size > 128 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Zotero response exceeds the 128 MB safety limit.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async list(path: string, serverId: string | null): Promise<any[]> {
    const result: any[] = [];
    const visited = new Set<string>();
    let expectedTotal: number | null = null;
    let next: string | null = path;
    while (next) {
      if (visited.has(next)) throw new Error('Zotero returned a repeating pagination link.');
      visited.add(next);
      const response = await this.request(next, serverId);
      const total = response.headers.get('Total-Results');
      if (total !== null) {
        if (!/^\d+$/.test(total)) throw new Error('Invalid Zotero result count');
        const count = Number(total);
        if (expectedTotal !== null && expectedTotal !== count)
          throw new Error('Zotero changed during sync. Please try again.');
        expectedTotal = count;
      }
      const data = JSON.parse(await this.text(response));
      if (!Array.isArray(data))
        throw new Error('Unexpected Zotero response. Existing library was preserved.');
      result.push(...data);
      const link = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/i)?.[1];
      next = null;
      if (link) {
        const url = new URL(link, `${ZOTERO_BASE}${path}`);
        if (
          !['127.0.0.1', 'localhost'].includes(url.hostname) ||
          url.port !== '23119' ||
          url.protocol !== 'http:' ||
          !url.pathname.startsWith('/api/')
        )
          throw new Error('Zotero returned an invalid pagination URL.');
        next = url.pathname.slice(4) + url.search;
      }
    }
    if (expectedTotal !== null && result.length !== expectedTotal)
      throw new Error('Zotero returned an incomplete snapshot. Please try again.');
    return result;
  }
  validate(items: any[], kind: string): SourceItem[] {
    const keys = new Set<string>();
    for (const item of items) {
      if (
        !item ||
        typeof item.key !== 'string' ||
        !/^[A-Z0-9]{8}$/.test(item.key) ||
        !item.data ||
        typeof item.data !== 'object' ||
        Array.isArray(item.data) ||
        keys.has(item.key)
      )
        throw new Error(
          `Zotero returned invalid or duplicate ${kind}. Existing library was preserved.`,
        );
      if (kind === 'items' && typeof item.data.itemType !== 'string')
        throw new Error('Zotero item is missing its type.');
      for (const field of ['creators', 'tags', 'collections'])
        if (item.data[field] !== undefined && !Array.isArray(item.data[field]))
          throw new Error(`Invalid Zotero ${field} field.`);
      const d = item.data;
      for (const field of [
        'title',
        'itemType',
        'abstractNote',
        'DOI',
        'url',
        'publicationTitle',
        'proceedingsTitle',
        'university',
        'publisher',
        'date',
        'contentType',
        'filename',
        'name',
      ])
        if (d[field] !== undefined && typeof d[field] !== 'string')
          throw new Error(`Invalid Zotero ${field}`);
      for (const field of ['parentItem', 'parentCollection'])
        if (d[field] && (typeof d[field] !== 'string' || !/^[A-Z0-9]{8}$/.test(d[field])))
          throw new Error(`Invalid Zotero ${field}`);
      if (d.deleted !== undefined && ![0, 1, false, true].includes(d.deleted))
        throw new Error('Invalid Zotero deleted flag');
      for (const c of d.creators ?? []) {
        if (!c || typeof c !== 'object' || Array.isArray(c))
          throw new Error('Invalid Zotero creator');
        for (const field of ['firstName', 'lastName', 'name', 'creatorType'])
          if (c[field] !== undefined && typeof c[field] !== 'string')
            throw new Error('Invalid Zotero creator name');
      }
      for (const t of d.tags ?? [])
        if (!t || typeof t !== 'object' || typeof t.tag !== 'string')
          throw new Error('Invalid Zotero tag');
      for (const c of d.collections ?? [])
        if (typeof c !== 'string' || !/^[A-Z0-9]{8}$/.test(c))
          throw new Error('Invalid Zotero collection key');
      keys.add(item.key);
    }
    return items;
  }
  async snapshots(): Promise<Snapshot[]> {
    let info: Response;
    try {
      info = await this.request('/');
    } catch (error) {
      // Zotero 6 answers on the connector port but has no /api, so the root itself is missing.
      if ((error as { status?: number }).status === 404) throw new Error(ZOTERO_TOO_OLD_MESSAGE);
      throw error;
    }
    const serverId = info.headers.get('Zotero-Server-ID');
    await info.body?.cancel();
    const groups = await this.list('/users/0/groups', serverId);
    const libraries = [
      { prefix: '/users/0', name: 'My Library' },
      ...groups.map((g) => {
        const id = g.id ?? g.data?.id;
        if (!/^\d+$/.test(String(id))) throw new Error('Zotero returned an invalid group ID.');
        return { prefix: `/groups/${id}`, name: String(g.data?.name ?? g.name ?? `Group ${id}`) };
      }),
    ];
    const snapshots: Snapshot[] = [];
    for (const library of libraries) {
      const items = this.validate(
        await this.list(`${library.prefix}/items?format=json&includeTrashed=1`, serverId),
        'items',
      );
      const collections = this.validate(
        await this.list(`${library.prefix}/collections?format=json`, serverId),
        'collections',
      );
      snapshots.push({
        ...library,
        id: `${serverId ?? 'local-default'}${library.prefix}`,
        serverId,
        items,
        collections,
      });
    }
    return snapshots;
  }
  async attachmentPath(attachment: {
    prefix: string;
    zotero_key: string;
    server_id: string | null;
  }) {
    const response = await this.request(
      `${attachment.prefix}/items/${encodeURIComponent(attachment.zotero_key)}/file/view/url`,
      attachment.server_id,
    );
    const url = new URL((await this.text(response)).trim());
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost'))
      throw new Error('Zotero did not return a local attachment.');
    return fileURLToPath(url);
  }
}
