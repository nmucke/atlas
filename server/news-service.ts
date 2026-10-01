import { randomUUID } from 'node:crypto';
import type { AtlasDatabase } from './database.ts';
import type { ProjectStore } from './projects.ts';
import type { Retrieval } from './retrieval.ts';
import {
  canonicalUrl,
  detectSources as detectSourceInput,
  fetchSource as fetchNewsSource,
  normalizeArxivId,
  normalizeDoi,
  validateSourceInput,
} from './news-fetchers.ts';
import type { FetchContext } from './news-fetchers.ts';
import { NewsStore } from './news-store.ts';
import type { IdentifierKind, ItemRow, StoredItemInput } from './news-store.ts';
import type {
  NewsCollectStatus,
  NewsDismissReason,
  NewsFeedbackAction,
  NewsItem,
  NewsListFilter,
  NewsResponse,
  NewsSettings,
  NewsSettingsInput,
  NewsSource,
  NewsSourceInput,
  NewsSourceKind,
  NewsSourcePatch,
  NewsSourceSuggestion,
  NewsState,
  NewsTriage,
  RawNewsItem,
} from '../shared/news.ts';

const sourceKinds = new Set<NewsSourceKind>([
  'arxiv',
  'rss',
  'openalex_author',
  'openalex_query',
  'openalex_cites',
]);
const listFilters = new Set<NewsListFilter>([
  'new',
  'saved',
  'added',
  'dismissed',
  'untriaged',
  'all',
]);
const dismissReasons = new Set<NewsDismissReason>([
  'not_relevant',
  'already_known',
  'low_quality',
  'less_from_source',
]);
const feedbackActions = new Set<NewsFeedbackAction>(['open', 'more', 'less']);
const followKinds = new Set<NewsSourceKind>(['openalex_author', 'openalex_cites']);
const dayMs = 86400000;
const stopwords = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours using use used based via new paper study approach method methods results show propose proposed work data model models also one two however within without towards toward can may our we`.split(
    /\s+/,
  ),
);
const unmatched = 'i.paper_id IS NULL';
const untriaged = 'NOT EXISTS (SELECT 1 FROM news_triage t WHERE t.item_id=i.id)';

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ''))
    .filter((t) => t.length > 2 && t.length < 40 && !stopwords.has(t) && !/^\d+$/.test(t));
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`${label} must be text under ${max} characters`);
  if (required && !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function fields(data: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`${label} must be an object`);
  for (const key of Object.keys(data))
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  return data as Record<string, unknown>;
}
function page(limit: unknown, offset: unknown, max: number, fallback: number) {
  const l = limit ?? fallback,
    o = offset ?? 0;
  if (!Number.isInteger(l) || (l as number) < 1 || (l as number) > max)
    throw new Error(`limit must be an integer from 1 to ${max}`);
  if (!Number.isInteger(o) || (o as number) < 0)
    throw new Error('offset must be a non-negative integer');
  return { limit: l as number, offset: o as number };
}
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 1000) / 1000;
function finalScore(preScore: number, triage: number | null) {
  return round(triage === null ? preScore : 0.6 * ((triage - 1) / 4) + 0.4 * preScore);
}
/** arXiv ID of a Zotero item from its URL, Extra "arXiv:" line, archive ID or arXiv DOI. */
function libraryArxivId(data: Record<string, any>): string | null {
  const candidates = [
    data.archiveID,
    String(data.extra ?? '').match(/arXiv:\s*([^\s]+)/i)?.[1],
    /arxiv\.org/i.test(String(data.url ?? '')) ? data.url : null,
    String(data.DOI ?? '').match(/10\.48550\/arxiv\.(.+)$/i)?.[1],
  ];
  for (const value of candidates)
    if (typeof value === 'string' && value) {
      const id = normalizeArxivId(value);
      if (id) return id;
    }
  return null;
}

export interface NewsServiceOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
  /** Test seams; default to the implementations in news-fetchers.ts. */
  fetchSource?: typeof fetchNewsSource;
  detectSources?: typeof detectSourceInput;
}
type QueueItem = Pick<
  NewsItem,
  | 'id'
  | 'kind'
  | 'title'
  | 'authors'
  | 'abstract'
  | 'url'
  | 'venue'
  | 'publishedAt'
  | 'preScore'
  | 'features'
  | 'sources'
  | 'doi'
  | 'arxivId'
>;
export interface NewsTriageInput {
  itemId: string;
  score: number;
  why: string;
  projectIds?: string[];
  citationIds?: string[];
}
export interface NewsSourceProposal {
  kind: NewsSourceKind;
  value: string;
  label?: string;
  reason: string;
}

export class NewsService {
  library: AtlasDatabase;
  projects: ProjectStore;
  retrieval: Retrieval;
  store: NewsStore;
  private fetcher: typeof fetch;
  private now: () => Date;
  private fetchSourceImpl: typeof fetchNewsSource;
  private detectSourcesImpl: typeof detectSourceInput;
  private running: Promise<NewsCollectStatus> | null = null;
  private status: NewsCollectStatus | null = null;
  private libraryIndex: {
    key: string;
    doi: Map<string, string>;
    arxiv: Map<string, string>;
  } | null = null;
  constructor(
    library: AtlasDatabase,
    projects: ProjectStore,
    retrieval: Retrieval,
    options: NewsServiceOptions = {},
  ) {
    this.library = library;
    this.projects = projects;
    this.retrieval = retrieval;
    this.store = new NewsStore(library.db);
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => new Date());
    this.fetchSourceImpl = options.fetchSource ?? fetchNewsSource;
    this.detectSourcesImpl = options.detectSources ?? detectSourceInput;
  }
  private iso() {
    return this.now().toISOString();
  }

  // Sources
  sources(): NewsSource[] {
    return this.store.sources();
  }
  addSource(input: NewsSourceInput): NewsSource {
    const row = fields(input, ['kind', 'value', 'label'], 'source');
    if (!sourceKinds.has(row.kind as NewsSourceKind)) throw new Error('Invalid source kind');
    const valid = validateSourceInput({
      kind: row.kind as NewsSourceKind,
      value: text(row.value, 'Source value', 2048, true),
      ...(row.label === undefined ? {} : { label: text(row.label, 'Source label', 200) }),
    });
    const existing = this.store.sourceByValue(valid.kind, valid.value);
    if (existing) return existing;
    const label = (valid.label ?? '').trim().slice(0, 200) || valid.value;
    return this.store.insertSource(valid.kind, valid.value, label, this.iso());
  }
  patchSource(id: string, patch: NewsSourcePatch): NewsSource | null {
    const row = fields(patch, ['enabled', 'label'], 'source');
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean')
      throw new Error('enabled must be a boolean');
    const label = row.label === undefined ? undefined : text(row.label, 'label', 200, true);
    if (!this.store.sourceById(id)) return null;
    this.store.updateSource(id, { enabled: row.enabled as boolean | undefined, label });
    return this.store.sourceById(id);
  }
  removeSource(id: string): boolean {
    return this.store.deleteSource(id, this.iso());
  }
  detectSources(input: string): Promise<NewsSourceSuggestion[]> {
    const value = text(input, 'input', 2000, true);
    const { contactEmail } = this.settings();
    return this.detectSourcesImpl(value, {
      fetcher: this.fetcher,
      contactEmail,
      openAlexKey: this.store.setting('newsOpenAlexKey'),
    });
  }
  suggestions(): NewsSourceSuggestion[] {
    return this.store.suggestions();
  }
  proposeSources(runId: string, input: NewsSourceProposal[]): NewsSourceSuggestion[] {
    this.retrieval.run(runId);
    if (!Array.isArray(input) || !input.length || input.length > 20)
      throw new Error('Propose 1–20 sources');
    const proposals = input.map((item) => {
      const row = fields(item, ['kind', 'value', 'label', 'reason'], 'source proposal');
      if (!sourceKinds.has(row.kind as NewsSourceKind)) throw new Error('Invalid source kind');
      const valid = validateSourceInput({
        kind: row.kind as NewsSourceKind,
        value: text(row.value, 'Source value', 2048, true),
        ...(row.label === undefined ? {} : { label: text(row.label, 'Source label', 200) }),
      });
      return {
        kind: valid.kind,
        value: valid.value,
        label: (valid.label ?? '').trim().slice(0, 200) || valid.value,
        reason: text(row.reason, 'reason', 500, true),
      };
    });
    return this.store.transaction(() => {
      const result: NewsSourceSuggestion[] = [];
      for (const proposal of proposals) {
        if (this.store.sourceByValue(proposal.kind, proposal.value)) continue;
        const previous = this.store.suggestionByValue(proposal.kind, proposal.value);
        // Pending duplicates are returned as-is; ones the user declined are not proposed again.
        if (previous?.status === 'pending') {
          if (!result.some((s) => s.id === previous.id))
            result.push(this.store.suggestionRow(previous.id)!.suggestion);
          continue;
        }
        if (previous?.status === 'declined') continue;
        result.push(this.store.insertSuggestion(proposal, runId, this.iso()));
      }
      return result;
    });
  }
  decideSuggestion(id: string, accept: boolean): NewsSource | null {
    if (typeof accept !== 'boolean') throw new Error('accept must be a boolean');
    return this.store.transaction(() => {
      const row = this.store.suggestionRow(id);
      if (!row) throw new Error('Suggestion not found');
      if (row.status !== 'pending') {
        if ((row.status === 'accepted') !== accept)
          throw new Error('Suggestion is already decided');
        return row.source_id ? this.store.sourceById(row.source_id) : null;
      }
      const source = accept
        ? this.addSource({ kind: row.kind, value: row.value, label: row.label })
        : null;
      this.store.decideSuggestion(
        id,
        accept ? 'accepted' : 'declined',
        source?.id ?? null,
        this.iso(),
      );
      return source;
    });
  }
  settings(): NewsSettings {
    return {
      contactEmail: this.store.setting('newsContactEmail') ?? '',
      hasOpenAlexKey: !!this.store.setting('newsOpenAlexKey'),
    };
  }
  setSettings(input: NewsSettingsInput): NewsSettings {
    const row = fields(input, ['contactEmail', 'openAlexKey'], 'settings');
    const email =
      row.contactEmail === undefined ? undefined : text(row.contactEmail, 'contactEmail', 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('Enter a valid contact email or leave it empty');
    const key =
      row.openAlexKey === undefined ? undefined : text(row.openAlexKey, 'openAlexKey', 200);
    if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid OpenAlex API key');
    this.store.transaction(() => {
      if (email !== undefined) this.store.setSetting('newsContactEmail', email || null);
      if (key !== undefined) this.store.setSetting('newsOpenAlexKey', key || null);
    });
    return this.settings();
  }

  // Collection: manual only. A second call while running joins the running collection.
  collect(): Promise<NewsCollectStatus> {
    if (this.running) return this.running;
    const id = randomUUID();
    const status: NewsCollectStatus = {
      running: true,
      startedAt: this.iso(),
      finishedAt: null,
      fetched: 0,
      added: 0,
      errors: [],
    };
    this.status = status;
    this.store.startRun(id, status.startedAt!);
    this.running = this.runCollect(status)
      .catch((error) => {
        status.errors.push({
          sourceId: '',
          label: 'News',
          message: error instanceof Error ? error.message : 'Collection failed',
        });
      })
      .then(() => {
        status.running = false;
        status.finishedAt = this.iso();
        this.store.finishRun(id, status.finishedAt, {
          fetched: status.fetched,
          added: status.added,
          errors: status.errors,
        });
        return { ...status, errors: [...status.errors] };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  collectStatus(): NewsCollectStatus {
    const status = this.status ?? this.store.lastRun();
    return status
      ? { ...status, errors: [...status.errors] }
      : { running: false, startedAt: null, finishedAt: null, fetched: 0, added: 0, errors: [] };
  }
  private async runCollect(status: NewsCollectStatus) {
    const { contactEmail } = this.settings();
    const openAlexKey = this.store.setting('newsOpenAlexKey');
    const defaultSince = new Date(this.now().getTime() - 7 * dayMs).toISOString();
    for (const source of this.store.sources().filter((s) => s.enabled)) {
      let raw: RawNewsItem[];
      try {
        raw = await this.fetchSourceImpl(source, {
          fetcher: this.fetcher,
          contactEmail,
          openAlexKey,
          since: source.lastFetchedAt ?? defaultSince,
        } satisfies FetchContext);
      } catch (error) {
        const message = (error instanceof Error ? error.message : 'Fetch failed').slice(0, 500);
        // The source may have been removed while its request was in flight.
        if (this.store.sourceById(source.id))
          this.store.recordFetch(source.id, this.iso(), message);
        status.errors.push({ sourceId: source.id, label: source.label, message });
        continue;
      }
      status.fetched += raw.length;
      this.store.transaction(() => {
        if (!this.store.sourceById(source.id)) return;
        for (const item of raw) if (this.upsert(item, source.id)) status.added++;
        this.store.recordFetch(source.id, this.iso(), null);
      });
    }
    this.store.transaction(() => {
      this.matchLibrary();
      this.rescore();
    });
  }
  private normalized(raw: RawNewsItem): StoredItemInput | null {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    if (!title) return null;
    const doi = raw.doi ? normalizeDoi(raw.doi) : null;
    const arxivId =
      (raw.arxivId ? normalizeArxivId(raw.arxivId) : null) ??
      (doi?.startsWith('10.48550/arxiv.') ? normalizeArxivId(doi.slice(15)) : null);
    const url =
      (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : '') ||
      (arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : '');
    if (!url) return null;
    const date = raw.publishedAt ? new Date(raw.publishedAt) : null;
    return {
      kind: ['paper', 'post', 'repo', 'release', 'dataset'].includes(raw.kind) ? raw.kind : 'post',
      title,
      authors: (Array.isArray(raw.authors) ? raw.authors : [])
        .filter((a) => typeof a === 'string' && a.trim())
        .slice(0, 100)
        .map((a) => a.trim().slice(0, 300)),
      abstract: String(raw.abstract ?? '')
        .trim()
        .slice(0, 20000),
      url: url.slice(0, 2048),
      venue: raw.venue ? String(raw.venue).slice(0, 500) : null,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      doi,
      arxivId,
      openAlexId: raw.openAlexId
        ? (String(raw.openAlexId).match(/W\d+/i)?.[0].toUpperCase() ?? null)
        : null,
      referencedWorks: (Array.isArray(raw.referencedWorks) ? raw.referencedWorks : [])
        .map((w) => String(w).match(/W\d+/i)?.[0].toUpperCase())
        .filter((w): w is string => !!w)
        .slice(0, 2000),
    };
  }
  /** Stores or merges one fetched item by identity (DOI > arXiv > OpenAlex > URL). Returns true when new. */
  private upsert(raw: RawNewsItem, sourceId: string): boolean {
    const item = this.normalized(raw);
    if (!item) return false;
    const identifiers: [IdentifierKind, string][] = [];
    if (item.doi) identifiers.push(['doi', item.doi]);
    if (item.arxivId) identifiers.push(['arxiv', item.arxivId]);
    if (item.openAlexId) identifiers.push(['openalex', item.openAlexId]);
    identifiers.push(['url', canonicalUrl(item.url)]);
    const now = this.iso();
    let id: string | null = null;
    for (const [kind, value] of identifiers) if ((id = this.store.itemIdFor(kind, value))) break;
    const created = !id;
    if (id) this.store.mergeItem(id, item);
    else id = this.store.insertItem(item, now);
    this.store.addIdentifiers(id, identifiers);
    this.store.linkSource(id, sourceId, now);
    if (created) this.matchLibrary([id]);
    return created;
  }

  // Library matching (by DOI or arXiv ID; News rows are never written to source_items)
  private libraryIds() {
    const db = this.library.db;
    const stamp = db
      .prepare(
        'SELECT COUNT(*) AS n,MAX(s.updated_at) AS at FROM source_items s JOIN paper_state p ON p.id=s.id WHERE s.missing=0',
      )
      .get() as { n: number; at: string | null };
    const key = `${stamp.n}:${stamp.at}:${this.library.getSetting('lastSync')}`;
    if (this.libraryIndex?.key === key) return this.libraryIndex;
    const doi = new Map<string, string>(),
      arxiv = new Map<string, string>();
    for (const row of db
      .prepare(
        'SELECT s.id,s.payload FROM source_items s JOIN paper_state p ON p.id=s.id WHERE s.missing=0 ORDER BY p.added_at,s.id',
      )
      .all() as { id: string; payload: string }[]) {
      let data: Record<string, any>;
      try {
        data = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const d = data.DOI ? normalizeDoi(String(data.DOI)) : null;
      if (d && !doi.has(d)) doi.set(d, row.id);
      const a = libraryArxivId(data);
      if (a && !arxiv.has(a)) arxiv.set(a, row.id);
    }
    return (this.libraryIndex = { key, doi, arxiv });
  }
  private matchLibrary(ids?: string[]) {
    const index = this.libraryIds();
    if (!index.doi.size && !index.arxiv.size) return;
    const rows = ids
      ? ids.map((id) => this.store.itemRow(id)!).filter(Boolean)
      : this.store.rows(`${unmatched} AND (i.doi IS NOT NULL OR i.arxiv_id IS NOT NULL)`, []);
    for (const row of rows) {
      if (row.paper_id) continue;
      const paperId =
        (row.doi && index.doi.get(row.doi)) ||
        (row.arxiv_id && index.arxiv.get(row.arxiv_id)) ||
        (row.arxiv_id && index.doi.get(`10.48550/arxiv.${row.arxiv_id}`)) ||
        null;
      if (paperId) this.store.setPaperId(row.id, paperId);
    }
  }

  // Pre-score
  private profileQuery(): string | null {
    const db = this.library.db;
    const parts: string[] = [this.retrieval.assistant.getProfile().text];
    for (const tag of db
      .prepare("SELECT name,description FROM tag_definitions WHERE origin='atlas'")
      .all() as { name: string; description: string }[])
      parts.push(tag.name.replace(/[/_-]/g, ' '), tag.description);
    for (const project of this.projects.list())
      parts.push(project.name, project.summary.slice(0, 20000));
    for (const row of db
      .prepare(
        "SELECT s.payload FROM source_items s JOIN paper_state p ON p.id=s.id WHERE s.missing=0 AND p.archived=0 AND (p.starred=1 OR p.status='read') ORDER BY p.added_at DESC LIMIT 500",
      )
      .all() as { payload: string }[]) {
      try {
        parts.push(String(JSON.parse(row.payload).title ?? ''));
      } catch {
        /* Ignore malformed payloads. */
      }
    }
    const counts = new Map<string, number>();
    for (const term of terms(parts.join('\n'))) counts.set(term, (counts.get(term) ?? 0) + 1);
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 60)
      .map(([term]) => `"${term.replace(/"/g, '')}"`);
    return top.length ? top.join(' OR ') : null;
  }
  /** Recomputes pre-scores and features for every item that is not dismissed. */
  private rescore() {
    const items = this.store.rows("i.state<>'dismissed'", []);
    if (!items.length) return;
    const query = this.profileQuery();
    const ranks = query ? this.store.bm25(query) : new Map<string, number>();
    const best = Math.min(0, ...items.map((i) => ranks.get(i.id) ?? 0));
    const priors = this.store.sourcePriors();
    const negatives = this.store
      .rows(
        "(i.feedback='less' OR (i.state='dismissed' AND i.dismiss_reason='not_relevant'))",
        [],
        ' ORDER BY i.state_changed_at DESC',
        200,
      )
      .map((row) => new Set(terms(`${row.title} ${row.abstract}`)));
    const now = this.now().getTime();
    for (const item of items) {
      const sources = this.store.itemSources(item.id);
      const rank = ranks.get(item.id);
      const lex = rank !== undefined && best < 0 ? clamp(rank / best) : 0;
      const follow = sources.some((s) => followKinds.has(s.kind)) ? 1 : 0;
      const age = Math.max(
        0,
        (now - new Date(item.published_at ?? item.first_seen_at).getTime()) / dayMs,
      );
      const fresh = Math.exp(-age / 7);
      const sourcePrior = sources.length
        ? Math.max(...sources.map((s) => priors.get(s.id) ?? 0.5))
        : 0.5;
      const own = new Set(terms(`${item.title} ${item.abstract}`));
      let neg = 0;
      if (own.size)
        for (const other of negatives) {
          if (!other.size) continue;
          let shared = 0;
          for (const term of own) if (other.has(term)) shared++;
          neg = Math.max(neg, shared / (own.size + other.size - shared));
        }
      const features = {
        lex: round(lex),
        follow,
        fresh: round(fresh),
        sourcePrior: round(sourcePrior),
        neg: round(neg),
      };
      const pre = round(
        clamp(0.45 * lex + 0.2 * follow + 0.2 * fresh + 0.15 * sourcePrior - 0.3 * neg),
      );
      this.store.setScores(
        item.id,
        pre,
        features,
        finalScore(pre, this.store.latestTriage(item.id)?.score ?? null),
      );
    }
  }

  // Items
  private toItem(row: ItemRow, triage = this.store.latestTriage(row.id)): NewsItem {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      authors: JSON.parse(row.authors_json),
      abstract: row.abstract,
      url: row.url,
      venue: row.venue,
      publishedAt: row.published_at,
      firstSeenAt: row.first_seen_at,
      doi: row.doi,
      arxivId: row.arxiv_id,
      sources: this.store.itemSources(row.id).map(({ id, label }) => ({ id, label })),
      preScore: row.pre_score,
      features: JSON.parse(row.features_json),
      triage,
      score: row.score,
      state: row.state,
      dismissReason: row.dismiss_reason,
      feedback: row.feedback,
      paperId: row.paper_id,
    };
  }
  list(filter: { state?: NewsListFilter; limit?: number; offset?: number } = {}): NewsResponse {
    const row = fields(filter, ['state', 'limit', 'offset'], 'filter');
    if (row.state !== undefined && !listFilters.has(row.state as NewsListFilter))
      throw new Error('Invalid News filter');
    const { limit, offset } = page(row.limit, row.offset, 200, 50);
    this.store.transaction(() => this.matchLibrary());
    const state = row.state as NewsListFilter | undefined;
    const where =
      state === undefined
        ? "i.state<>'dismissed'"
        : state === 'all'
          ? ''
          : state === 'untriaged'
            ? `i.state='new' AND ${unmatched} AND ${untriaged}`
            : 'i.state=?';
    const args = state && !['all', 'untriaged'].includes(state) ? [state] : [];
    const items = this.store
      .rows(where, args, ' ORDER BY i.score DESC,i.first_seen_at DESC,i.id', limit, offset)
      .map((r) => this.toItem(r));
    const counts = {} as NewsResponse['counts'];
    for (const s of ['new', 'saved', 'added', 'dismissed'] as NewsState[])
      counts[s] = this.store.count('i.state=?', [s]);
    counts.untriaged = this.store.count(`i.state='new' AND ${unmatched} AND ${untriaged}`);
    return {
      items,
      counts,
      collect: this.collectStatus(),
      lastTriageAt: this.store.lastTriageAt(),
    };
  }
  item(id: string): NewsItem | null {
    const row = this.store.itemRow(id);
    return row ? this.toItem(row) : null;
  }
  setState(
    id: string,
    state: 'new' | 'saved' | 'dismissed',
    reason: NewsDismissReason | null = null,
  ): NewsItem | null {
    if (!['new', 'saved', 'dismissed'].includes(state)) throw new Error('Invalid News state');
    if (reason != null && (state !== 'dismissed' || !dismissReasons.has(reason)))
      throw new Error('Invalid dismiss reason');
    const row = this.store.itemRow(id);
    if (!row) return null;
    if (row.state === 'added') throw new Error('This item was already added to your library');
    const now = this.iso();
    this.store.transaction(() => {
      this.store.setState(id, state, state === 'dismissed' ? (reason ?? null) : null, now);
      this.store.logFeedback(id, state, reason ?? null, now);
    });
    return this.item(id);
  }
  feedback(id: string, action: NewsFeedbackAction): NewsItem | null {
    if (!feedbackActions.has(action)) throw new Error('Invalid feedback action');
    if (!this.store.itemRow(id)) return null;
    this.store.transaction(() => {
      if (action !== 'open') this.store.setFeedback(id, action);
      this.store.logFeedback(id, action, null, this.iso());
    });
    return this.item(id);
  }
  markAdded(id: string, paperId: string): NewsItem | null {
    text(paperId, 'paperId', 500, true);
    if (!this.store.itemRow(id)) return null;
    if (!this.library.db.prepare('SELECT 1 FROM paper_state WHERE id=?').get(paperId))
      throw new Error('Paper not found in the Atlas library');
    const now = this.iso();
    this.store.transaction(() => {
      this.store.setPaperId(id, paperId);
      this.store.setState(id, 'added', null, now);
      this.store.logFeedback(id, 'added', null, now);
    });
    return this.item(id);
  }
  /** Links the library paper behind an item to a project (same SQL as an approved recommendation). */
  linkProject(id: string, projectId: string): NewsItem | null {
    const row = this.store.itemRow(id);
    if (!row) return null;
    if (!row.paper_id) throw new Error('Add this item to your library before linking a project');
    text(projectId, 'projectId', 500, true);
    this.store.transaction(() => {
      if (!this.library.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))
        throw new Error('Project not found');
      this.library.db
        .prepare('INSERT OR IGNORE INTO project_papers(project_id,paper_id) VALUES(?,?)')
        .run(projectId, row.paper_id);
      this.library.db
        .prepare('UPDATE projects SET updated_at=? WHERE id=?')
        .run(this.iso(), projectId);
    });
    return this.item(id);
  }

  // Assistant
  queue(
    runId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: QueueItem[]; nextOffset: number | null; total: number } {
    this.retrieval.run(runId);
    const { limit, offset } = page(options.limit, options.offset, 30, 20);
    this.store.transaction(() => this.matchLibrary());
    const where = `i.state='new' AND ${unmatched} AND ${untriaged}`;
    const total = this.store.count(where);
    const rows = this.store.rows(
      where,
      [],
      ' ORDER BY i.pre_score DESC,i.first_seen_at DESC,i.id',
      limit,
      offset,
    );
    return {
      items: rows.map((row) => {
        const item = this.toItem(row, null);
        return {
          id: item.id,
          kind: item.kind,
          title: item.title,
          authors: item.authors,
          abstract: item.abstract,
          url: item.url,
          venue: item.venue,
          publishedAt: item.publishedAt,
          preScore: item.preScore,
          features: item.features,
          sources: item.sources,
          doi: item.doi,
          arxivId: item.arxivId,
        };
      }),
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
      total,
    };
  }
  submitTriage(runId: string, items: NewsTriageInput[]): { saved: number; items: NewsItem[] } {
    const run = this.retrieval.run(runId);
    if (!Array.isArray(items) || !items.length || items.length > 50)
      throw new Error('Submit 1–50 triaged items');
    const seen = new Set<string>();
    const now = this.iso();
    const triages = items.map((input) => {
      const row = fields(input, ['itemId', 'score', 'why', 'projectIds', 'citationIds'], 'triage');
      const itemId = text(row.itemId, 'itemId', 500, true);
      if (seen.has(itemId)) throw new Error(`Duplicate itemId: ${itemId}`);
      seen.add(itemId);
      if (!this.store.itemRow(itemId)) throw new Error(`Unknown News item: ${itemId}`);
      const score = row.score;
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5)
        throw new Error('score must be an integer from 1 to 5');
      const why = text(row.why, 'why', 1000, true);
      const projectIds = row.projectIds ?? [];
      if (!Array.isArray(projectIds) || projectIds.length > 10)
        throw new Error('projectIds must be an array of at most 10 IDs');
      for (const projectId of projectIds)
        if (typeof projectId !== 'string' || !this.projects.detail(projectId))
          throw new Error(`Unknown projectId: ${String(projectId)}`);
      const citationIds = row.citationIds ?? [];
      if (!Array.isArray(citationIds) || citationIds.length > 20)
        throw new Error('citationIds must be an array of at most 20 IDs');
      const citations = citationIds.length
        ? this.retrieval.citations(runId, citationIds as string[]).map((c) => ({
            chunkId: c.chunkId,
            sourceId: c.sourceId,
            title: c.title,
            quote: c.quote.slice(0, 600),
          }))
        : [];
      const triage: NewsTriage = {
        score,
        why,
        projectIds: [...new Set(projectIds as string[])],
        runId: run.id,
        agent: { name: run.agent_name, model: run.model },
        citations,
        createdAt: now,
      };
      return { itemId, triage };
    });
    this.store.transaction(() => {
      for (const { itemId, triage } of triages) {
        this.store.insertTriage(itemId, triage);
        this.store.setScore(
          itemId,
          finalScore(this.store.itemRow(itemId)!.pre_score, triage.score),
        );
      }
    });
    return { saved: triages.length, items: triages.map(({ itemId }) => this.item(itemId)!) };
  }
  feedbackSummary(runId: string, since?: string | null) {
    this.retrieval.run(runId);
    let from: string;
    if (since == null) from = new Date(this.now().getTime() - 30 * dayMs).toISOString();
    else {
      const date = new Date(text(since, 'since', 64, true));
      if (Number.isNaN(date.getTime())) throw new Error('since must be an ISO date');
      from = date.toISOString();
    }
    const events = this.store.feedbackSince(from);
    // Latest event per item and action group wins (e.g. an undone dismissal is not counted).
    const latestState = new Map<string, (typeof events)[number]>();
    const latestSignal = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (['new', 'saved', 'dismissed', 'added'].includes(event.action))
        latestState.set(event.itemId, event);
      if (['more', 'less'].includes(event.action)) latestSignal.set(event.itemId, event);
    }
    const brief = (e: (typeof events)[number]) => ({ id: e.itemId, title: e.title, kind: e.kind });
    const kept = [...latestState.values()].filter(
      (e) => ['saved', 'added'].includes(e.action) && e.state === e.action,
    );
    const dismissed = [...latestState.values()].filter(
      (e) => e.action === 'dismissed' && e.state === 'dismissed',
    );
    const reasons: Record<string, number> = {};
    for (const e of dismissed)
      reasons[e.reason ?? 'unspecified'] = (reasons[e.reason ?? 'unspecified'] ?? 0) + 1;
    const signals = [...latestSignal.values()];
    return {
      since: from,
      kept: { total: kept.length, items: kept.slice(-50).map(brief) },
      dismissed: {
        total: dismissed.length,
        reasons,
        items: dismissed.slice(-50).map((e) => ({ ...brief(e), reason: e.reason })),
      },
      more: signals
        .filter((e) => e.action === 'more')
        .slice(-50)
        .map(brief),
      less: signals
        .filter((e) => e.action === 'less')
        .slice(-50)
        .map(brief),
      perSource: this.store.sources().map((s) => {
        const dismissedCount = this.store.count(
          "i.state='dismissed' AND i.id IN (SELECT item_id FROM news_item_sources WHERE source_id=?)",
          [s.id],
        );
        return {
          sourceId: s.id,
          label: s.label,
          kind: s.kind,
          items: s.itemCount,
          kept: s.keptCount,
          dismissed: dismissedCount,
          precision: round((s.keptCount + 1) / (s.keptCount + dismissedCount + 2)),
        };
      }),
    };
  }
}
