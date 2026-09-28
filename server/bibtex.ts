import type { DatabaseSync } from 'node:sqlite';
import { ZoteroClient } from './zotero.ts';

const endpoint = 'http://127.0.0.1:23119/better-bibtex/json-rpc';
export class BetterBibTeX {
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Zotero-Allowed-Request': 'true' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      });
    } catch {
      throw new Error(
        'Cannot reach Better BibTeX. Open Zotero with the Better BibTeX extension enabled.',
      );
    }
    if (!response.ok)
      throw new Error(
        'Better BibTeX is unavailable. Install or enable Better BibTeX in Zotero, then try again.',
      );
    const payload = JSON.parse(await new ZoteroClient(this.fetcher).text(response));
    if (payload.error)
      throw new Error(`Better BibTeX: ${String(payload.error.message || 'Export failed')}`);
    if (!Object.hasOwn(payload, 'result')) throw new Error('Unexpected Better BibTeX response.');
    return payload.result;
  }
  async export(db: DatabaseSync, paperIds: string[]): Promise<string> {
    if (!paperIds.length)
      throw new Error('Link papers to this project before exporting a bibliography.');
    const rows = paperIds.map(
      (id) =>
        db
          .prepare(
            'SELECT s.zotero_key,s.missing,l.prefix,l.server_id FROM source_items s JOIN libraries l ON l.id=s.library_id WHERE s.id=?',
          )
          .get(id) as
          | { zotero_key: string; missing: number; prefix: string; server_id: string | null }
          | undefined,
    );
    if (rows.some((row) => !row || row.missing))
      throw new Error(
        'Some linked papers are unavailable in Zotero. Sync or unlink them before exporting.',
      );
    const info = await new ZoteroClient(this.fetcher).request('/');
    const serverId = info.headers.get('Zotero-Server-ID');
    await info.body?.cancel();
    if (rows.some((row) => row!.server_id && row!.server_id !== serverId))
      throw new Error(
        'Linked papers belong to a different Zotero database. Sync your current library before exporting.',
      );
    const libraries = await this.rpc('user.groups');
    if (!Array.isArray(libraries))
      throw new Error('Better BibTeX could not list Zotero libraries.');
    const needed = new Set(rows.map((row) => `${row!.prefix}:${row!.zotero_key}`));
    const found = new Map<string, { libraryID: number; citekey: string }>();
    // Resolve identity using Zotero item URIs, never ambiguous library names or citation keys alone.
    for (const library of libraries) {
      if (!Number.isInteger(library.id)) continue;
      const items = await this.rpc('item.search', {
        terms: [
          ['libraryID', 'is', library.id],
          ['itemType', 'isNot', 'attachment'],
          ['itemType', 'isNot', 'note'],
          ['itemType', 'isNot', 'annotation'],
        ],
      });
      if (!Array.isArray(items)) throw new Error('Unexpected Better BibTeX item list.');
      for (const item of items) {
        if (typeof item.id !== 'string' || typeof item.citekey !== 'string' || !item.citekey)
          continue;
        const group = item.id.match(/\/groups\/(\d+)\/items\/([A-Z0-9]{8})$/);
        const personal = item.id.match(/\/users\/(?:\d+|local\/[^/]+)\/items\/([A-Z0-9]{8})$/);
        const identity = group
          ? `/groups/${group[1]}:${group[2]}`
          : personal
            ? `/users/0:${personal[1]}`
            : '';
        if (!needed.has(identity)) continue;
        if (found.has(identity))
          throw new Error('Better BibTeX returned ambiguous item identities.');
        found.set(identity, { libraryID: library.id, citekey: item.citekey });
      }
    }
    if (found.size !== needed.size)
      throw new Error(
        'Some linked papers have no Better BibTeX citation key. Check those items in Zotero (standalone PDFs cannot be cited), then sync again.',
      );
    const grouped = new Map<number, string[]>();
    const keys = new Set<string>();
    for (const identity of needed) {
      const item = found.get(identity)!;
      if (keys.has(item.citekey))
        throw new Error(
          `Duplicate citation key “${item.citekey}” across linked papers. Resolve duplicate keys in Zotero before exporting.`,
        );
      keys.add(item.citekey);
      const list = grouped.get(item.libraryID) ?? [];
      list.push(item.citekey);
      grouped.set(item.libraryID, list);
    }
    const sections: string[] = [];
    for (const [libraryID, citekeys] of grouped) {
      const bib = await this.rpc('item.export', {
        citekeys,
        translator: 'Better BibTeX',
        libraryID,
      });
      if (typeof bib !== 'string' || !bib.trim())
        throw new Error('Better BibTeX returned an empty bibliography.');
      sections.push(bib.trim());
    }
    return sections.join('\n\n') + '\n';
  }
}
