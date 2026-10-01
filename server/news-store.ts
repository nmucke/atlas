import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  NewsCollectStatus,
  NewsDismissReason,
  NewsFeedbackAction,
  NewsItem,
  NewsItemKind,
  NewsSource,
  NewsSourceKind,
  NewsSourceSuggestion,
  NewsState,
  NewsTriage,
} from '../shared/news.ts';

// News rows live in their own tables; they never enter source_items until the
// user adds an item to Zotero and the next sync imports it.
export const newsSchema = `
  CREATE TABLE IF NOT EXISTS news_sources(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('arxiv','rss','openalex_author','openalex_query','openalex_cites')),
    value TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at TEXT NOT NULL, last_fetched_at TEXT, last_error TEXT, removed_at TEXT, UNIQUE(kind,value)
  );
  CREATE TABLE IF NOT EXISTS news_source_suggestions(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, reason TEXT NOT NULL,
    run_id TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
    source_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS news_source_suggestions_status ON news_source_suggestions(status,created_at);
  CREATE TABLE IF NOT EXISTS news_items(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('paper','post','repo','release','dataset')),
    title TEXT NOT NULL, authors_json TEXT NOT NULL DEFAULT '[]', abstract TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
    venue TEXT, published_at TEXT, first_seen_at TEXT NOT NULL, doi TEXT, arxiv_id TEXT, openalex_id TEXT,
    referenced_works_json TEXT NOT NULL DEFAULT '[]',
    pre_score REAL NOT NULL DEFAULT 0, features_json TEXT NOT NULL DEFAULT '{}', score REAL NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','saved','added','dismissed')),
    dismiss_reason TEXT, feedback TEXT, paper_id TEXT, state_changed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS news_items_rank ON news_items(state,score DESC,first_seen_at DESC);
  CREATE TABLE IF NOT EXISTS news_identifiers(
    kind TEXT NOT NULL CHECK(kind IN ('doi','arxiv','openalex','url')), value TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES news_items(id) ON DELETE CASCADE, PRIMARY KEY(kind,value)
  );
  CREATE INDEX IF NOT EXISTS news_identifiers_item ON news_identifiers(item_id);
  CREATE TABLE IF NOT EXISTS news_item_sources(
    item_id TEXT NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
    first_seen_at TEXT NOT NULL, PRIMARY KEY(item_id,source_id)
  );
  CREATE INDEX IF NOT EXISTS news_item_sources_source ON news_item_sources(source_id);
  CREATE TABLE IF NOT EXISTS news_triage(
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5), why TEXT NOT NULL,
    project_ids_json TEXT NOT NULL, agent_json TEXT NOT NULL, citations_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS news_triage_item ON news_triage(item_id,id);
  CREATE TABLE IF NOT EXISTS news_feedback(
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
    action TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS news_feedback_created ON news_feedback(created_at);
  CREATE TABLE IF NOT EXISTS news_runs(
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, stats_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS news_fts USING fts5(item_id UNINDEXED,title,abstract,tokenize='unicode61');
  INSERT OR IGNORE INTO schema_migrations VALUES(8);
`;

type SourceRow = {
  id: string;
  kind: NewsSourceKind;
  value: string;
  label: string;
  enabled: number;
  created_at: string;
  last_fetched_at: string | null;
  last_error: string | null;
  item_count: number;
  kept_count: number;
};
type SuggestionRow = {
  id: string;
  kind: NewsSourceKind;
  value: string;
  label: string;
  reason: string;
  run_id: string | null;
  status: 'pending' | 'accepted' | 'declined';
  source_id: string | null;
  created_at: string;
};
export type ItemRow = {
  id: string;
  kind: NewsItemKind;
  title: string;
  authors_json: string;
  abstract: string;
  url: string;
  venue: string | null;
  published_at: string | null;
  first_seen_at: string;
  doi: string | null;
  arxiv_id: string | null;
  openalex_id: string | null;
  referenced_works_json: string;
  pre_score: number;
  features_json: string;
  score: number;
  state: NewsState;
  dismiss_reason: NewsDismissReason | null;
  feedback: NewsFeedbackAction | null;
  paper_id: string | null;
};
type TriageRow = {
  item_id: string;
  run_id: string;
  score: number;
  why: string;
  project_ids_json: string;
  agent_json: string;
  citations_json: string;
  created_at: string;
};
export interface StoredItemInput {
  kind: NewsItemKind;
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  venue: string | null;
  publishedAt: string | null;
  doi: string | null;
  arxivId: string | null;
  openAlexId: string | null;
  referencedWorks: string[];
}
export type IdentifierKind = 'doi' | 'arxiv' | 'openalex' | 'url';

const sourceSelect = `SELECT s.*,
  (SELECT COUNT(*) FROM news_item_sources l WHERE l.source_id=s.id) AS item_count,
  (SELECT COUNT(*) FROM news_item_sources l JOIN news_items i ON i.id=l.item_id WHERE l.source_id=s.id AND i.state IN ('saved','added')) AS kept_count
  FROM news_sources s`;
const sourceOrder = ' WHERE s.removed_at IS NULL ORDER BY s.kind,s.label COLLATE NOCASE,s.id';

export class NewsStore {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('PRAGMA foreign_keys=ON');
    this.transaction(() => this.db.exec(newsSchema));
  }
  transaction<T>(action: () => T): T {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setting(key: string): string | null {
    return (
      (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string })
        ?.value ?? null
    );
  }
  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    else
      this.db
        .prepare(
          'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(key, value);
  }

  // Sources
  private source(row: SourceRow): NewsSource {
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      value: row.value,
      enabled: !!row.enabled,
      createdAt: row.created_at,
      lastFetchedAt: row.last_fetched_at,
      lastError: row.last_error,
      itemCount: Number(row.item_count),
      keptCount: Number(row.kept_count),
    };
  }
  sources(): NewsSource[] {
    return (this.db.prepare(sourceSelect + sourceOrder).all() as SourceRow[]).map((row) =>
      this.source(row),
    );
  }
  sourceById(id: string): NewsSource | null {
    const row = this.db.prepare(`${sourceSelect} WHERE s.id=? AND s.removed_at IS NULL`).get(id) as
      SourceRow | undefined;
    return row ? this.source(row) : null;
  }
  sourceByValue(kind: NewsSourceKind, value: string): NewsSource | null {
    const row = this.db
      .prepare(`${sourceSelect} WHERE s.kind=? AND s.value=? AND s.removed_at IS NULL`)
      .get(kind, value) as SourceRow | undefined;
    return row ? this.source(row) : null;
  }
  insertSource(kind: NewsSourceKind, value: string, label: string, now: string): NewsSource {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO news_sources(id,kind,value,label,enabled,created_at) VALUES(?,?,?,?,1,?)',
      )
      .run(randomUUID(), kind, value, label, now);
    // Re-adding a removed source restores it, so its found items keep their provenance.
    this.db
      .prepare(
        'UPDATE news_sources SET removed_at=NULL,enabled=1,label=? WHERE kind=? AND value=? AND removed_at IS NOT NULL',
      )
      .run(label, kind, value);
    return this.sourceByValue(kind, value)!;
  }
  updateSource(id: string, patch: { enabled?: boolean; label?: string }) {
    if (patch.enabled !== undefined)
      this.db
        .prepare('UPDATE news_sources SET enabled=? WHERE id=?')
        .run(Number(patch.enabled), id);
    if (patch.label !== undefined)
      this.db.prepare('UPDATE news_sources SET label=? WHERE id=?').run(patch.label, id);
  }
  /** Soft delete: the source stops being fetched and listed, but items keep their provenance. */
  deleteSource(id: string, now: string): boolean {
    return (
      this.db
        .prepare('UPDATE news_sources SET removed_at=? WHERE id=? AND removed_at IS NULL')
        .run(now, id).changes > 0
    );
  }
  recordFetch(id: string, at: string, error: string | null) {
    if (error === null)
      this.db
        .prepare('UPDATE news_sources SET last_fetched_at=?,last_error=NULL WHERE id=?')
        .run(at, id);
    else this.db.prepare('UPDATE news_sources SET last_error=? WHERE id=?').run(error, id);
  }
  /** (kept+1)/(kept+dismissed+2) per source, from current item states. */
  sourcePriors(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT l.source_id AS id, SUM(i.state IN ('saved','added')) AS kept, SUM(i.state='dismissed') AS dismissed
         FROM news_item_sources l JOIN news_items i ON i.id=l.item_id GROUP BY l.source_id`,
      )
      .all() as { id: string; kept: number; dismissed: number }[];
    return new Map(
      rows.map((r) => [r.id, (Number(r.kept) + 1) / (Number(r.kept) + Number(r.dismissed) + 2)]),
    );
  }

  // Suggestions
  private suggestion(row: SuggestionRow): NewsSourceSuggestion {
    return {
      id: row.id,
      kind: row.kind,
      value: row.value,
      label: row.label,
      reason: row.reason,
      origin: 'assistant',
      createdAt: row.created_at,
    };
  }
  suggestions(): NewsSourceSuggestion[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM news_source_suggestions WHERE status='pending' ORDER BY created_at,id",
        )
        .all() as SuggestionRow[]
    ).map((row) => this.suggestion(row));
  }
  suggestionRow(id: string): (SuggestionRow & { suggestion: NewsSourceSuggestion }) | null {
    const row = this.db.prepare('SELECT * FROM news_source_suggestions WHERE id=?').get(id) as
      SuggestionRow | undefined;
    return row ? { ...row, suggestion: this.suggestion(row) } : null;
  }
  suggestionByValue(kind: NewsSourceKind, value: string): SuggestionRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM news_source_suggestions WHERE kind=? AND value=? ORDER BY status='pending' DESC,created_at DESC LIMIT 1",
        )
        .get(kind, value) as SuggestionRow | undefined) ?? null
    );
  }
  insertSuggestion(
    input: { kind: NewsSourceKind; value: string; label: string; reason: string },
    runId: string,
    now: string,
  ): NewsSourceSuggestion {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO news_source_suggestions(id,kind,value,label,reason,run_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(id, input.kind, input.value, input.label, input.reason, runId, 'pending', now);
    return this.suggestionRow(id)!.suggestion;
  }
  decideSuggestion(
    id: string,
    status: 'accepted' | 'declined',
    sourceId: string | null,
    now: string,
  ) {
    this.db
      .prepare(
        "UPDATE news_source_suggestions SET status=?,source_id=?,decided_at=? WHERE id=? AND status='pending'",
      )
      .run(status, sourceId, now, id);
  }

  // Items
  itemIdFor(kind: IdentifierKind, value: string): string | null {
    return (
      (
        this.db
          .prepare('SELECT item_id FROM news_identifiers WHERE kind=? AND value=?')
          .get(kind, value) as { item_id: string } | undefined
      )?.item_id ?? null
    );
  }
  addIdentifiers(itemId: string, identifiers: [IdentifierKind, string][]) {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO news_identifiers(kind,value,item_id) VALUES(?,?,?)',
    );
    for (const [kind, value] of identifiers) insert.run(kind, value, itemId);
  }
  insertItem(input: StoredItemInput, now: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO news_items(id,kind,title,authors_json,abstract,url,venue,published_at,first_seen_at,doi,arxiv_id,openalex_id,referenced_works_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.kind,
        input.title,
        JSON.stringify(input.authors),
        input.abstract,
        input.url,
        input.venue,
        input.publishedAt,
        now,
        input.doi,
        input.arxivId,
        input.openAlexId,
        JSON.stringify(input.referencedWorks),
      );
    this.db
      .prepare('INSERT INTO news_fts(item_id,title,abstract) VALUES(?,?,?)')
      .run(id, input.title, input.abstract);
    return id;
  }
  /** Fills gaps in an existing item from another source's copy of the same work. */
  mergeItem(id: string, input: StoredItemInput) {
    const row = this.itemRow(id)!;
    const abstract = row.abstract || input.abstract;
    const referenced = [
      ...new Set([...JSON.parse(row.referenced_works_json), ...input.referencedWorks]),
    ];
    this.db
      .prepare(
        `UPDATE news_items SET kind=?,authors_json=?,abstract=?,venue=?,published_at=?,doi=?,arxiv_id=?,openalex_id=?,referenced_works_json=? WHERE id=?`,
      )
      .run(
        row.kind === 'paper' || input.kind === 'paper' ? 'paper' : row.kind,
        JSON.parse(row.authors_json).length ? row.authors_json : JSON.stringify(input.authors),
        abstract,
        row.venue ?? input.venue,
        row.published_at ?? input.publishedAt,
        row.doi ?? input.doi,
        row.arxiv_id ?? input.arxivId,
        row.openalex_id ?? input.openAlexId,
        JSON.stringify(referenced),
        id,
      );
    if (abstract !== row.abstract) {
      this.db.prepare('DELETE FROM news_fts WHERE item_id=?').run(id);
      this.db
        .prepare('INSERT INTO news_fts(item_id,title,abstract) VALUES(?,?,?)')
        .run(id, row.title, abstract);
    }
  }
  linkSource(itemId: string, sourceId: string, now: string) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO news_item_sources(item_id,source_id,first_seen_at) VALUES(?,?,?)',
      )
      .run(itemId, sourceId, now);
  }
  itemRow(id: string): ItemRow | null {
    return (
      (this.db.prepare('SELECT * FROM news_items WHERE id=?').get(id) as ItemRow | undefined) ??
      null
    );
  }
  rows(where: string, args: (string | number)[], order = '', limit?: number, offset = 0) {
    const page = limit === undefined ? '' : ' LIMIT ? OFFSET ?';
    return this.db
      .prepare(`SELECT * FROM news_items i${where ? ' WHERE ' + where : ''}${order}${page}`)
      .all(...args, ...(limit === undefined ? [] : [limit, offset])) as ItemRow[];
  }
  count(where: string, args: (string | number)[] = []): number {
    return Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM news_items i${where ? ' WHERE ' + where : ''}`)
          .get(...args) as { n: number }
      ).n,
    );
  }
  itemSources(itemId: string): { id: string; label: string; kind: NewsSourceKind }[] {
    return this.db
      .prepare(
        'SELECT s.id,s.label,s.kind FROM news_item_sources l JOIN news_sources s ON s.id=l.source_id WHERE l.item_id=? ORDER BY l.first_seen_at,s.label',
      )
      .all(itemId) as { id: string; label: string; kind: NewsSourceKind }[];
  }
  latestTriage(itemId: string): NewsTriage | null {
    const row = this.db
      .prepare('SELECT * FROM news_triage WHERE item_id=? ORDER BY id DESC LIMIT 1')
      .get(itemId) as TriageRow | undefined;
    return row
      ? {
          score: row.score,
          why: row.why,
          projectIds: JSON.parse(row.project_ids_json),
          runId: row.run_id,
          agent: JSON.parse(row.agent_json),
          citations: JSON.parse(row.citations_json),
          createdAt: row.created_at,
        }
      : null;
  }
  insertTriage(itemId: string, triage: NewsTriage) {
    this.db
      .prepare(
        'INSERT INTO news_triage(item_id,run_id,score,why,project_ids_json,agent_json,citations_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        itemId,
        triage.runId,
        triage.score,
        triage.why,
        JSON.stringify(triage.projectIds),
        JSON.stringify(triage.agent),
        JSON.stringify(triage.citations),
        triage.createdAt,
      );
  }
  lastTriageAt(): string | null {
    return (
      (
        this.db.prepare('SELECT MAX(created_at) AS at FROM news_triage').get() as {
          at: string | null;
        }
      ).at ?? null
    );
  }
  setScores(id: string, preScore: number, features: Record<string, number>, score: number) {
    this.db
      .prepare('UPDATE news_items SET pre_score=?,features_json=?,score=? WHERE id=?')
      .run(preScore, JSON.stringify(features), score, id);
  }
  setScore(id: string, score: number) {
    this.db.prepare('UPDATE news_items SET score=? WHERE id=?').run(score, id);
  }
  setState(id: string, state: NewsState, reason: NewsDismissReason | null, now: string) {
    this.db
      .prepare('UPDATE news_items SET state=?,dismiss_reason=?,state_changed_at=? WHERE id=?')
      .run(state, reason, now, id);
  }
  setFeedback(id: string, feedback: NewsFeedbackAction) {
    this.db.prepare('UPDATE news_items SET feedback=? WHERE id=?').run(feedback, id);
  }
  setPaperId(id: string, paperId: string | null) {
    this.db.prepare('UPDATE news_items SET paper_id=? WHERE id=?').run(paperId, id);
  }
  logFeedback(itemId: string, action: string, reason: string | null, now: string) {
    this.db
      .prepare('INSERT INTO news_feedback(item_id,action,reason,created_at) VALUES(?,?,?,?)')
      .run(itemId, action, reason, now);
  }
  feedbackSince(since: string) {
    return this.db
      .prepare(
        `SELECT f.item_id AS itemId,f.action,f.reason,f.created_at AS createdAt,i.title,i.kind,i.state
         FROM news_feedback f JOIN news_items i ON i.id=f.item_id WHERE f.created_at>=? ORDER BY f.id`,
      )
      .all(since) as {
      itemId: string;
      action: string;
      reason: string | null;
      createdAt: string;
      title: string;
      kind: NewsItemKind;
      state: NewsState;
    }[];
  }
  /** BM25 ranks (more negative = better) of the given items against an FTS5 query. */
  bm25(query: string): Map<string, number> {
    const rows = this.db
      .prepare('SELECT item_id AS id,bm25(news_fts) AS rank FROM news_fts WHERE news_fts MATCH ?')
      .all(query) as { id: string; rank: number }[];
    return new Map(rows.map((r) => [r.id, Number(r.rank)]));
  }

  // Collect runs
  startRun(id: string, at: string) {
    this.db.prepare('INSERT INTO news_runs(id,started_at) VALUES(?,?)').run(id, at);
  }
  finishRun(id: string, at: string, stats: unknown) {
    this.db
      .prepare('UPDATE news_runs SET finished_at=?,stats_json=? WHERE id=?')
      .run(at, JSON.stringify(stats), id);
  }
  lastRun(): NewsCollectStatus | null {
    const row = this.db
      .prepare('SELECT * FROM news_runs ORDER BY started_at DESC,rowid DESC LIMIT 1')
      .get() as { started_at: string; finished_at: string | null; stats_json: string } | undefined;
    if (!row) return null;
    const stats = JSON.parse(row.stats_json);
    return {
      running: false,
      startedAt: row.started_at,
      // A run left unfinished by a restart is reported as finished with no results.
      finishedAt: row.finished_at ?? row.started_at,
      fetched: stats.fetched ?? 0,
      added: stats.added ?? 0,
      errors: stats.errors ?? [],
    };
  }
}
