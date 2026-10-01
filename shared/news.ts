// Shared News contract between the Atlas server, MCP tools, and the interface.
// News items stay separate from Zotero-backed library papers until the user adds them.

export type NewsSourceKind =
  | 'arxiv' // value: one or more arXiv categories joined by '+', e.g. "stat.ML+physics.flu-dyn"
  | 'rss' // value: an RSS/Atom feed URL (blogs, journal tables of contents, GitHub releases.atom)
  | 'openalex_author' // value: OpenAlex author ID, e.g. "A5023888391"
  | 'openalex_query' // value: free-text keyword query
  | 'openalex_cites'; // value: OpenAlex work ID whose new citing works are followed, e.g. "W2741809807"

export type NewsItemKind = 'paper' | 'post' | 'repo' | 'release' | 'dataset';
export type NewsState = 'new' | 'saved' | 'added' | 'dismissed';
export type NewsListFilter = NewsState | 'untriaged' | 'all';
export type NewsDismissReason =
  'not_relevant' | 'already_known' | 'low_quality' | 'less_from_source';
export type NewsFeedbackAction = 'open' | 'more' | 'less';

export interface NewsSource {
  id: string;
  kind: NewsSourceKind;
  label: string;
  value: string;
  enabled: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
  lastError: string | null;
  /** Items this source has found in total. */
  itemCount: number;
  /** Items from this source the user saved or added. */
  keptCount: number;
}

export interface NewsSourceInput {
  kind: NewsSourceKind;
  value: string;
  label?: string;
}

export interface NewsSourcePatch {
  enabled?: boolean;
  label?: string;
}

/** A source proposed by detection (from user text) or by an assistant run. */
export interface NewsSourceSuggestion {
  id: string | null; // null for transient detection results that are not stored
  kind: NewsSourceKind;
  value: string;
  label: string;
  reason: string;
  origin: 'detected' | 'assistant';
  createdAt: string | null;
}

export interface NewsTriage {
  score: number; // 1–5
  why: string;
  projectIds: string[];
  runId: string;
  agent: { name: string; model: string };
  citations: { chunkId: string; sourceId: string; title: string; quote: string }[];
  createdAt: string;
}

export interface NewsItem {
  id: string;
  kind: NewsItemKind;
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  venue: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  doi: string | null;
  arxivId: string | null; // version stripped, e.g. "2409.01234"
  sources: { id: string; label: string }[];
  preScore: number; // 0–1
  features: Record<string, number>;
  triage: NewsTriage | null;
  score: number; // 0–1 final ranking score (triage-weighted when triaged)
  state: NewsState;
  dismissReason: NewsDismissReason | null;
  feedback: NewsFeedbackAction | null; // latest more/less signal
  /** Atlas paper ID when the item already is, or has been added to, the library. */
  paperId: string | null;
}

export interface NewsCollectStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  fetched: number;
  added: number;
  errors: { sourceId: string; label: string; message: string }[];
}

export interface NewsResponse {
  items: NewsItem[];
  counts: Record<NewsState | 'untriaged', number>;
  collect: NewsCollectStatus;
  lastTriageAt: string | null;
}

export interface NewsSettings {
  contactEmail: string; // sent as mailto for polite API pools; empty when unset
  hasOpenAlexKey: boolean; // the key itself is never returned to the interface
}

export interface NewsSettingsInput {
  contactEmail?: string;
  openAlexKey?: string; // empty string clears the key
}

export interface NewsAddToZoteroInput {
  /** Atlas collection ID from LibraryResponse.collections; null for the library root. */
  collectionId: string | null;
  projectId: string | null;
  attachPdf: boolean;
}

export interface NewsAddToZoteroResult {
  item: NewsItem;
  paperId: string;
  pdf: 'attached' | 'skipped' | 'failed';
  pdfError?: string;
}

/** Normalized output of a source fetcher before identity resolution and storage. */
export interface RawNewsItem {
  kind: NewsItemKind;
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  venue: string | null;
  publishedAt: string | null; // ISO 8601
  doi: string | null; // lower-case, no https://doi.org/ prefix
  arxivId: string | null; // version stripped
  openAlexId: string | null; // "W…"
  referencedWorks: string[]; // OpenAlex work IDs the item cites, when known
}
