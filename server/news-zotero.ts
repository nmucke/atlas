// Adds a News item to Zotero through the Zotero 10 local write API. The user's click is the
// approval; the write still needs the in-memory grant from Assistant → Zotero actions.
import { createHash } from 'node:crypto';
import type { AtlasDatabase } from './database.ts';
import type { ProjectStore } from './projects.ts';
import type { ZoteroWorkflow } from './zotero-workflow.ts';
import type { NewsAddToZoteroInput, NewsItem } from '../shared/news.ts';

export type NewsZoteroResult = {
  paperId: string;
  pdf: 'attached' | 'skipped' | 'failed';
  pdfError?: string;
};
type Target = { libraryId: string; prefix: string; serverId: string; collectionKey: string | null };

export const NEWS_ZOTERO_TAG = 'atlas:news';
export const ZOTERO_UNREACHABLE =
  'Cannot reach Zotero. Open Zotero 10 or newer and enable “Allow other applications on this computer to communicate with Zotero” in Settings → Advanced, then try again.';
export const ZOTERO_NOT_AUTHORIZED =
  'Allow Atlas to write to Zotero first: open Assistant → Zotero actions, choose “Enable Zotero writes” and allow Atlas in Zotero, then try again.';
export const PDF_NOT_REMEMBERED =
  'PDF not attached: Atlas can add PDFs only with a remembered Zotero permission. In Assistant → Zotero actions choose “Enable Zotero writes” and pick “Always Allow” in Zotero, then use Add to Zotero again to attach the PDF.';

const keyPattern = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const arxivPattern = /^(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})$/i;

function normDoi(value: unknown) {
  const doi = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, '');
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : '';
}
function normArxiv(value: unknown) {
  const id = String(value ?? '')
    .trim()
    .replace(/^arxiv:\s*/i, '')
    .replace(/v\d+$/i, '');
  return arxivPattern.test(id) ? id.toLowerCase() : '';
}
function canonical(value: unknown) {
  try {
    const url = new URL(String(value ?? ''));
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return '';
  }
}
/** DOI and arXiv identifiers a Zotero item carries, in the forms Zotero stores them. */
function identifiers(data: Record<string, any>) {
  const doi = normDoi(data.DOI);
  const arxiv = new Set<string>();
  const fromDoi = doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1];
  for (const candidate of [
    fromDoi,
    data.archiveID,
    String(data.url ?? '').match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i)?.[1],
    ...String(data.extra ?? '').matchAll(/^\s*arxiv:\s*(\S+)/gim),
  ].map((value) => (Array.isArray(value) ? value[1] : value)))
    if (normArxiv(candidate)) arxiv.add(normArxiv(candidate));
  return { doi, arxiv };
}
function matches(item: NewsItem, data: Record<string, any>) {
  if (data.deleted || ['attachment', 'note', 'annotation'].includes(data.itemType)) return false;
  const own = identifiers(data);
  const doi = normDoi(item.doi),
    arxiv = normArxiv(item.arxivId);
  if (doi && own.doi === doi) return true;
  if (arxiv && own.arxiv.has(arxiv)) return true;
  // Items without identifiers (posts, repositories) are recognised by their URL.
  return !doi && !arxiv && !!canonical(item.url) && canonical(data.url) === canonical(item.url);
}

function creators(authors: string[], creatorType: string) {
  return authors
    .map((name) => name.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((name) => {
      const split = name.lastIndexOf(' ');
      return split < 0
        ? { creatorType, name }
        : { creatorType, firstName: name.slice(0, split), lastName: name.slice(split + 1) };
    });
}

/** Zotero item JSON for a News item, built only from the item's own verified metadata. */
export function newsZoteroItem(item: NewsItem, collectionKey: string | null) {
  const title = item.title.trim().slice(0, 1000);
  if (!title) throw new Error('This item has no title to add to Zotero');
  const arxiv = normArxiv(item.arxivId),
    doi = normDoi(item.doi);
  let url = '';
  try {
    const parsed = new URL(item.url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
  } catch {
    /* Leave the URL empty rather than store an unsafe value. */
  }
  const common = {
    title,
    abstractNote: item.abstract.slice(0, 20000),
    date: item.publishedAt?.slice(0, 10) ?? '',
    url,
    tags: [{ tag: NEWS_ZOTERO_TAG }],
    collections: collectionKey ? [collectionKey] : [],
  };
  if (item.kind === 'paper' && arxiv)
    return {
      itemType: 'preprint',
      ...common,
      creators: creators(item.authors, 'author'),
      repository: 'arXiv',
      archiveID: `arXiv:${arxiv}`,
      DOI: doi || `10.48550/arXiv.${arxiv}`,
      url: url || `https://arxiv.org/abs/${arxiv}`,
    };
  if (item.kind === 'paper')
    return {
      itemType: 'journalArticle',
      ...common,
      creators: creators(item.authors, 'author'),
      publicationTitle: item.venue ?? '',
      DOI: doi,
      url: url || (doi ? `https://doi.org/${doi}` : ''),
    };
  if (item.kind === 'repo' || item.kind === 'release')
    return {
      itemType: 'computerProgram',
      ...common,
      creators: creators(item.authors, 'programmer'),
    };
  if (item.kind === 'dataset')
    return {
      itemType: 'dataset',
      ...common,
      creators: creators(item.authors, 'author'),
      repository: item.venue ?? '',
      DOI: doi,
    };
  return {
    itemType: 'webpage',
    ...common,
    creators: creators(item.authors, 'author'),
    websiteTitle: item.venue ?? '',
  };
}

export class NewsZotero {
  private library: AtlasDatabase;
  private projects: ProjectStore;
  private workflow: ZoteroWorkflow;
  private busy = new Set<string>();
  constructor(library: AtlasDatabase, projects: ProjectStore, workflow: ZoteroWorkflow) {
    this.library = library;
    this.projects = projects;
    this.workflow = workflow;
  }

  async add(item: NewsItem, input: NewsAddToZoteroInput): Promise<NewsZoteroResult> {
    if (this.busy.has(item.id)) throw new Error('This item is already being added to Zotero');
    this.busy.add(item.id);
    try {
      return await this.addOnce(item, input);
    } finally {
      this.busy.delete(item.id);
    }
  }

  private async addOnce(item: NewsItem, input: NewsAddToZoteroInput): Promise<NewsZoteroResult> {
    if (input.projectId && !this.projects.detail(input.projectId))
      throw new Error('Project not found');
    const existing = this.libraryPaper(item);
    if (existing) {
      this.link(existing, input.projectId);
      return { paperId: existing, ...(await this.pdf(item, existing, input.attachPdf)) };
    }
    const status = await this.probe();
    if (!status.authorized) throw new Error(ZOTERO_NOT_AUTHORIZED);
    const target = this.target(input.collectionId, status.serverId);
    const found = await this.findInZotero(item, target);
    if (found) {
      const paperId = await this.synced(target, found, false);
      this.link(paperId, input.projectId);
      return { paperId, ...(await this.pdf(item, paperId, input.attachPdf)) };
    }
    const key = await this.create(item, target);
    const paperId = await this.synced(target, key, true);
    this.link(paperId, input.projectId);
    return { paperId, ...(await this.pdf(item, paperId, input.attachPdf)) };
  }

  /** Atlas paper ID already holding this item (by stored paperId, DOI or arXiv ID). */
  private libraryPaper(item: NewsItem): string | null {
    const exists = (id: string) =>
      !!this.library.db
        .prepare(
          'SELECT 1 FROM source_items s JOIN paper_state p ON p.id=s.id WHERE s.id=? AND s.missing=0',
        )
        .get(id);
    if (item.paperId && exists(item.paperId)) return item.paperId;
    if (!normDoi(item.doi) && !normArxiv(item.arxivId)) return null;
    const rows = this.library.db
      .prepare(
        'SELECT s.id,s.payload FROM source_items s JOIN paper_state p ON p.id=s.id WHERE s.missing=0 ORDER BY s.id',
      )
      .all() as { id: string; payload: string }[];
    return rows.find((row) => matches(item, JSON.parse(row.payload)))?.id ?? null;
  }

  private async probe() {
    try {
      return await this.workflow.writer.probe();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/Zotero 10 or newer/.test(message))
        throw new Error(
          'Zotero 10 or newer is required to add items from Atlas. Update Zotero and try again.',
        );
      if (/HTTP 403/.test(message))
        throw new Error(
          'Zotero access is disabled. Enable “Allow other applications on this computer to communicate with Zotero” in Zotero Settings → Advanced, then try again.',
        );
      throw new Error(ZOTERO_UNREACHABLE);
    }
  }

  private target(collectionId: string | null, serverId: string): Target {
    const libraries = this.library.db
      .prepare('SELECT id,prefix,server_id AS serverId FROM libraries')
      .all() as { id: string; prefix: string; serverId: string | null }[];
    let library: (typeof libraries)[number] | undefined;
    let collectionKey: string | null = null;
    if (collectionId) {
      const row = this.library.db
        .prepare('SELECT library_id AS libraryId FROM collections WHERE id=?')
        .get(collectionId) as { libraryId: string } | undefined;
      if (!row) throw new Error('Collection not found. Sync Zotero in Atlas and choose it again.');
      library = libraries.find((entry) => entry.id === row.libraryId);
      collectionKey = collectionId.slice(row.libraryId.length + 1);
      if (!keyPattern.test(collectionKey)) throw new Error('Invalid Zotero collection');
    } else
      library =
        libraries.find((entry) => entry.prefix === '/users/0' && entry.serverId === serverId) ??
        libraries.find((entry) => entry.prefix === '/users/0');
    if (!library || !library.serverId || !/^\/(users\/0|groups\/\d+)$/.test(library.prefix))
      throw new Error('Sync Atlas with Zotero before adding items.');
    if (library.serverId !== serverId)
      throw new Error('The open Zotero profile has changed. Sync Zotero in Atlas and try again.');
    return { libraryId: library.id, prefix: library.prefix, serverId, collectionKey };
  }

  /** Re-checks the live Zotero library right before writing, so retries never duplicate. */
  private async findInZotero(item: NewsItem, target: Target): Promise<string | null> {
    const terms = [
      ...new Set(
        [normDoi(item.doi), normArxiv(item.arxivId)].filter(Boolean).concat(
          // Without identifiers, fall back to the item's URL.
          normDoi(item.doi) || normArxiv(item.arxivId) ? [] : [item.url].filter(Boolean),
        ),
      ),
    ];
    for (const term of terms) {
      const response = await this.workflow.writer.read(
        `${target.prefix}/items?q=${encodeURIComponent(term)}&qmode=everything&format=json&limit=50`,
        target.serverId,
      );
      const results = (await response.json()) as unknown;
      if (!Array.isArray(results)) throw new Error('Zotero returned an invalid search result');
      const hit = results.find(
        (entry: any) =>
          keyPattern.test(String(entry?.key ?? '')) &&
          entry.data &&
          typeof entry.data === 'object' &&
          matches(item, entry.data),
      );
      if (hit) return hit.key as string;
    }
    return null;
  }

  private async create(item: NewsItem, target: Target): Promise<string> {
    const body = JSON.stringify([newsZoteroItem(item, target.collectionKey)]);
    const attemptKey = `newsZoteroAttempt:${item.id}`;
    const attempt = Number(this.library.getSetting(attemptKey) ?? 0);
    // Deterministic per item: a retry after a lost response cannot create a second item.
    const token = createHash('sha256')
      .update(`atlas-news:${item.id}:create:${attempt}`)
      .digest('hex')
      .slice(0, 32);
    const consumed = () => this.library.setSetting(attemptKey, String(attempt + 1));
    let saved: any;
    try {
      const response = await this.workflow.writer.write(
        `${target.prefix}/items`,
        'POST',
        body,
        { 'Content-Type': 'application/json', 'Zotero-Write-Token': token },
        false,
        target.serverId,
      );
      saved = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Zotero write failed';
      if (/request token was already consumed/.test(message)) {
        consumed();
        throw new Error(
          'Zotero already handled an earlier attempt to add this item, but Atlas could not find it. Sync Zotero in Atlas and check your library before trying again.',
        );
      }
      if (/Enable remembered Zotero writes|permission expired/.test(message))
        throw new Error(ZOTERO_NOT_AUTHORIZED);
      throw new Error(`Could not add the item to Zotero: ${message}`);
    }
    const key = saved?.successful?.['0']?.key ?? saved?.success?.['0'];
    if (typeof key === 'string' && keyPattern.test(key)) return key;
    if (saved?.failed?.['0']) consumed();
    throw new Error(
      `Zotero could not create the item: ${saved?.failed?.['0']?.message ?? 'no item key was returned'}`,
    );
  }

  private async synced(target: Target, key: string, created: boolean): Promise<string> {
    const paperId = `${target.libraryId}:${key}`;
    try {
      await this.workflow.syncLibrary();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sync failed';
      throw new Error(
        `${created ? 'Added to Zotero, but' : 'This item is already in Zotero, but'} Atlas could not sync it (${message}). Sync Zotero in Atlas, then try again; no duplicate will be created.`,
      );
    }
    if (!this.library.db.prepare('SELECT 1 FROM paper_state WHERE id=?').get(paperId))
      throw new Error(
        'The Zotero item did not appear in Atlas after syncing. Sync Zotero in Atlas, then try again.',
      );
    return paperId;
  }

  private link(paperId: string, projectId: string | null) {
    if (!projectId) return;
    this.library.db
      .prepare('INSERT OR IGNORE INTO project_papers(project_id,paper_id) VALUES(?,?)')
      .run(projectId, paperId);
    this.library.db
      .prepare('UPDATE projects SET updated_at=? WHERE id=?')
      .run(new Date().toISOString(), projectId);
  }

  private async pdf(
    item: NewsItem,
    paperId: string,
    attachPdf: boolean,
  ): Promise<Omit<NewsZoteroResult, 'paperId'>> {
    const arxiv = normArxiv(item.arxivId);
    if (!attachPdf) return { pdf: 'skipped' };
    // Never add a second PDF; an existing library paper may already have one.
    if (
      this.library.db
        .prepare(
          "SELECT 1 FROM attachments a JOIN source_items s ON s.id=a.id WHERE a.paper_id=? AND s.missing=0 AND (a.content_type='application/pdf' OR a.filename LIKE '%.pdf')",
        )
        .get(paperId)
    )
      return { pdf: 'skipped' };
    if (!arxiv) return { pdf: 'skipped', pdfError: 'No open PDF source is known for this item.' };
    try {
      if (!(await this.workflow.writer.probe()).automaticPdfWrites)
        return { pdf: 'failed', pdfError: PDF_NOT_REMEMBERED };
      const action = await this.workflow.attachPdfFromUrl(
        paperId,
        `https://arxiv.org/pdf/${arxiv}`,
        'Atlas News',
        `arXiv PDF for arXiv:${arxiv}, added from News`,
      );
      if (action.status === 'completed') return { pdf: 'attached' };
      if (action.status === 'write_done')
        return {
          pdf: 'attached',
          pdfError: `PDF added in Zotero; Atlas sync is pending (${action.error ?? 'retry from Assistant → Zotero actions'}).`,
        };
      return {
        pdf: 'failed',
        pdfError: `PDF not attached: ${action.error ?? 'the PDF action did not finish'} Retry it from Assistant → Zotero actions.`,
      };
    } catch (error) {
      return {
        pdf: 'failed',
        pdfError: `PDF not attached: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }
}
