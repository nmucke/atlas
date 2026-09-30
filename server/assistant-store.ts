import { randomUUID } from 'node:crypto';
import { legacyReadingRecommendation, readableReview } from '../shared/review-text.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AICandidate,
  AIKind,
  AILevel,
  AIRecord,
  AIRecordFilters,
  AIRecordInput,
  AIStatus,
  Citation,
  ResearchProfile,
} from '../shared/assistant.ts';

const kinds = new Set<AIKind>(['review', 'tags', 'recommendation', 'note', 'profile']);
const levels = new Set<AILevel>(['essential', 'recommended', 'optional']);
const statuses = new Set<AIStatus>(['pending', 'approved', 'rejected']);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function fields(data: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(data))
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function string(value: unknown, label: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`${label} must be text under ${limit} characters`);
  if (required && !value.trim()) throw new Error(`${label} is required`);
  return value;
}
function identifier(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return string(value, label, 500, true);
}
function tagName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Tag name must be text');
  const name = value.trim();
  if (!name || name.length > 120 || name.split('/').some((part) => !part.trim()))
    throw new Error('Invalid Atlas tag name');
  return name;
}
function webUrl(value: unknown, label: string): string {
  const raw = string(value, label, 2048, true);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  )
    throw new Error(`Invalid ${label}`);
  return parsed.href;
}
function normalizeCitation(value: unknown): Citation {
  const row = object(value, 'citation');
  fields(row, ['chunkId', 'sourceId', 'title', 'quote', 'page', 'hash'], 'citation');
  const page = row.page === null ? null : row.page;
  if (page !== null && (!Number.isInteger(page) || Number(page) < 1 || Number(page) > 100000))
    throw new Error('Citation page must be a positive integer or null');
  const hash = string(row.hash, 'citation hash', 64, true);
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('Citation hash must be SHA-256 hex');
  return {
    chunkId: string(row.chunkId, 'citation chunkId', 500, true),
    sourceId: string(row.sourceId, 'citation sourceId', 500, true),
    title: string(row.title, 'citation title', 500, true),
    quote: string(row.quote, 'citation quote', 4000, true),
    page: page as number | null,
    hash: hash.toLowerCase(),
  };
}
function normalizeCandidate(value: unknown): AICandidate | null {
  if (value === undefined || value === null) return null;
  const row = object(value, 'candidate');
  fields(row, ['title', 'authors', 'year', 'doi', 'url', 'abstract'], 'candidate');
  if (!Array.isArray(row.authors) || row.authors.length > 100)
    throw new Error('candidate authors must be an array');
  return {
    title: string(row.title, 'candidate title', 300, true),
    authors: row.authors.map((author) => string(author, 'candidate author', 160, true)),
    year: string(row.year, 'candidate year', 20),
    doi: string(row.doi, 'candidate DOI', 250),
    url: webUrl(row.url, 'candidate URL'),
    abstract: string(row.abstract, 'candidate abstract', 20000),
  };
}
function normalizeInput(
  value: AIRecordInput,
): Omit<AIRecord, 'id' | 'status' | 'createdAt' | 'decidedAt'> {
  const row = object(value, 'AI record');
  fields(
    row,
    [
      'kind',
      'paperId',
      'projectId',
      'title',
      'body',
      'readingRecommendation',
      'tags',
      'level',
      'candidate',
      'agent',
      'citations',
    ],
    'AI record',
  );
  if (!kinds.has(row.kind as AIKind)) throw new Error('Invalid AI record kind');
  const kind = row.kind as AIKind;
  const paperId = identifier(row.paperId, 'paperId');
  const projectId = identifier(row.projectId, 'projectId');
  const title = string(row.title, 'title', 200, true);
  const rawBody = string(row.body, 'body', 1000000, true);
  const body = kind === 'review' ? readableReview(rawBody) : rawBody;
  if (!body.trim()) throw new Error('body is required');
  let readingRecommendation = null;
  if (row.readingRecommendation != null) {
    if (kind !== 'review') throw new Error('Reading scores belong in paper reviews');
    const recommendation = object(row.readingRecommendation, 'readingRecommendation');
    fields(recommendation, ['score', 'reason'], 'readingRecommendation');
    const score = recommendation.score;
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5)
      throw new Error('Reading recommendation score must be an integer from 1 to 5');
    readingRecommendation = {
      score,
      reason: string(recommendation.reason, 'reading recommendation reason', 1000, true),
    };
  }
  if (kind === 'profile' && body.length > 100000)
    throw new Error('profile must be text under 100000 characters');
  const agentRow = object(row.agent, 'agent');
  fields(agentRow, ['name', 'model'], 'agent');
  const agent = {
    name: string(agentRow.name, 'agent name', 100, true),
    model: string(agentRow.model, 'agent model', 160, true),
  };
  if (!Array.isArray(row.citations) || row.citations.length > 100)
    throw new Error('citations must be an array of at most 100 entries');
  const citations = row.citations.map(normalizeCitation);
  if (kind !== 'profile' && !citations.length) throw new Error('Evidence citations are required');
  if (!Array.isArray(row.tags ?? []) || ((row.tags ?? []) as unknown[]).length > 100)
    throw new Error('tags must be an array of at most 100 entries');
  const tags = ((row.tags ?? []) as unknown[]).map((value) => {
    const tag = object(value, 'tag');
    fields(tag, ['name', 'description'], 'tag');
    return {
      name: tagName(tag.name),
      description: string(tag.description ?? '', 'tag description', 280),
    };
  });
  if (new Set(tags.map((tag) => tag.name)).size !== tags.length)
    throw new Error('Duplicate proposed tag name');
  if (kind === 'tags' && !tags.length) throw new Error('Tag proposals require at least one tag');
  if (kind !== 'tags' && tags.length) throw new Error('Tags belong in a separate tag proposal');
  const level = row.level === undefined || row.level === null ? null : (row.level as AILevel);
  if (level !== null && !levels.has(level)) throw new Error('Invalid recommendation level');
  const candidate = normalizeCandidate(row.candidate);
  if (kind === 'recommendation') {
    if (!level || Number(!!paperId) + Number(!!candidate) !== 1)
      throw new Error('Recommendations need a level and either a paperId or candidate');
  } else if (level || candidate)
    throw new Error('Only recommendations may include a level or candidate');
  if (kind === 'review' && !paperId) throw new Error('Reviews require a paperId');
  if (kind === 'note' && !projectId) throw new Error('AI notes require a projectId');
  if (kind === 'profile' && (paperId || projectId))
    throw new Error('Profile proposals cannot target a paper or project');
  return {
    kind,
    paperId,
    projectId,
    title,
    body,
    readingRecommendation,
    tags,
    level,
    candidate,
    agent,
    citations,
  };
}

type AIRow = {
  id: string;
  kind: AIKind;
  paper_id: string | null;
  project_id: string | null;
  title: string;
  body: string;
  reading_recommendation_json: string | null;
  tags_json: string;
  level: AILevel | null;
  candidate_json: string | null;
  agent_json: string;
  citations_json: string;
  status: AIStatus;
  created_at: string;
  decided_at: string | null;
};

export class AssistantStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('PRAGMA foreign_keys=ON');
    if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get()) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE ai_records(
            id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('review','tags','recommendation','note','profile')),
            paper_id TEXT REFERENCES paper_state(id), project_id TEXT REFERENCES projects(id),
            title TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL,
            level TEXT CHECK(level IN ('essential','recommended','optional')),
            candidate_json TEXT, agent_json TEXT NOT NULL, citations_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
            created_at TEXT NOT NULL, decided_at TEXT
          );
          CREATE INDEX ai_records_status ON ai_records(status,created_at);
          CREATE INDEX ai_records_paper ON ai_records(paper_id,created_at);
          CREATE INDEX ai_records_project ON ai_records(project_id,created_at);
          ALTER TABLE project_notes ADD COLUMN author_type TEXT NOT NULL DEFAULT 'human' CHECK(author_type IN ('human','ai'));
          ALTER TABLE project_notes ADD COLUMN ai_record_id TEXT REFERENCES ai_records(id);
          CREATE UNIQUE INDEX project_notes_ai_record ON project_notes(ai_record_id) WHERE ai_record_id IS NOT NULL;
        `);
        this.db.prepare('INSERT INTO schema_migrations(version) VALUES(4)').run();
      });
    }
    if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=6').get()) {
      this.transaction(() => {
        this.db.exec('ALTER TABLE ai_records ADD COLUMN reading_recommendation_json TEXT');
        this.db.prepare('INSERT INTO schema_migrations(version) VALUES(6)').run();
      });
    }
  }
  private transaction<T>(action: () => T): T {
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
  private record(row: AIRow): AIRecord {
    return {
      id: row.id,
      kind: row.kind,
      paperId: row.paper_id,
      projectId: row.project_id,
      title: row.title,
      body: row.body,
      readingRecommendation: row.reading_recommendation_json
        ? JSON.parse(row.reading_recommendation_json)
        : row.kind === 'review'
          ? legacyReadingRecommendation(row.body)
          : null,
      tags: JSON.parse(row.tags_json),
      level: row.level,
      candidate: row.candidate_json ? JSON.parse(row.candidate_json) : null,
      agent: JSON.parse(row.agent_json),
      citations: JSON.parse(row.citations_json),
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
  }
  private byId(id: string): AIRecord | null {
    const row = this.db.prepare('SELECT * FROM ai_records WHERE id=?').get(id) as AIRow | undefined;
    return row ? this.record(row) : null;
  }
  list(filters: AIRecordFilters = {}): AIRecord[] {
    const row = object(filters, 'filters');
    fields(row, ['kind', 'status', 'paperId', 'projectId'], 'filter');
    if (filters.kind !== undefined && !kinds.has(filters.kind))
      throw new Error('Invalid AI record kind');
    if (filters.status !== undefined && !statuses.has(filters.status))
      throw new Error('Invalid AI record status');
    const where: string[] = [],
      args: string[] = [];
    for (const [key, column] of Object.entries({
      kind: 'kind',
      status: 'status',
      paperId: 'paper_id',
      projectId: 'project_id',
    })) {
      const value = row[key];
      if (value !== undefined) {
        where.push(`${column}=?`);
        args.push(string(value, key, 500, true));
      }
    }
    const sql = `SELECT * FROM ai_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC,id`;
    return (this.db.prepare(sql).all(...args) as AIRow[]).map((row) => this.record(row));
  }
  submit(input: AIRecordInput): AIRecord {
    const record = normalizeInput(input);
    const id = randomUUID(),
      now = new Date().toISOString();
    this.transaction(() => {
      if (
        record.paperId &&
        !this.db.prepare('SELECT id FROM paper_state WHERE id=?').get(record.paperId)
      )
        throw new Error('Unknown paperId');
      if (
        record.projectId &&
        !this.db.prepare('SELECT id FROM projects WHERE id=?').get(record.projectId)
      )
        throw new Error('Unknown projectId');
      for (const tag of record.tags) {
        const existing = this.db
          .prepare("SELECT description FROM tag_definitions WHERE origin='atlas' AND name=?")
          .get(tag.name) as { description: string } | undefined;
        if (existing) tag.description = existing.description;
        else if (!tag.description.trim())
          throw new Error(`New tag "${tag.name}" requires a brief description`);
      }
      this.db
        .prepare(
          `INSERT INTO ai_records(
        id,kind,paper_id,project_id,title,body,tags_json,level,candidate_json,agent_json,citations_json,status,created_at,reading_recommendation_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          record.kind,
          record.paperId,
          record.projectId,
          record.title,
          record.body,
          JSON.stringify(record.tags),
          record.level,
          record.candidate ? JSON.stringify(record.candidate) : null,
          JSON.stringify(record.agent),
          JSON.stringify(record.citations),
          'pending',
          now,
          record.readingRecommendation ? JSON.stringify(record.readingRecommendation) : null,
        );
    });
    return this.byId(id)!;
  }
  decide(id: string, approve: boolean): AIRecord | null {
    if (typeof approve !== 'boolean') throw new Error('approve must be a boolean');
    return this.transaction(() => {
      const record = this.byId(id);
      if (!record) return null;
      const decision = approve ? 'approved' : 'rejected';
      if (record.status !== 'pending') {
        if (record.status !== decision) throw new Error('AI record is already decided');
        return record;
      }
      if (approve) this.apply(record);
      this.db
        .prepare('UPDATE ai_records SET status=?,decided_at=? WHERE id=? AND status=?')
        .run(decision, new Date().toISOString(), id, 'pending');
      return this.byId(id)!;
    });
  }
  private apply(record: AIRecord) {
    if (record.kind === 'tags') {
      const definition = this.db.prepare(
        "INSERT OR IGNORE INTO tag_definitions(id,origin,name,description) VALUES(?,'atlas',?,?)",
      );
      const select = this.db.prepare(
        "SELECT id FROM tag_definitions WHERE origin='atlas' AND name=?",
      );
      const paperTag = this.db.prepare(
        'INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) VALUES(?,?)',
      );
      const projectTag = this.db.prepare(
        'INSERT OR IGNORE INTO project_tags(project_id,tag_id) VALUES(?,?)',
      );
      for (const tag of record.tags) {
        definition.run(randomUUID(), tag.name, tag.description);
        const id = (select.get(tag.name) as { id: string }).id;
        if (record.paperId) paperTag.run(record.paperId, id);
        if (record.projectId) projectTag.run(record.projectId, id);
      }
      if (record.projectId)
        this.db
          .prepare('UPDATE projects SET updated_at=? WHERE id=?')
          .run(new Date().toISOString(), record.projectId);
    } else if (record.kind === 'recommendation' && record.paperId && record.projectId) {
      this.db
        .prepare('INSERT OR IGNORE INTO project_papers(project_id,paper_id) VALUES(?,?)')
        .run(record.projectId, record.paperId);
      this.db
        .prepare('UPDATE projects SET updated_at=? WHERE id=?')
        .run(new Date().toISOString(), record.projectId);
    } else if (record.kind === 'note') {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO project_notes(
        id,project_id,title,body,folder,pinned,archived,created_at,updated_at,author_type,ai_record_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          record.projectId,
          record.title,
          record.body,
          'AI notes',
          0,
          0,
          now,
          now,
          'ai',
          record.id,
        );
      this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, record.projectId);
    } else if (record.kind === 'profile') {
      this.writeProfile(record.body);
    }
  }
  getProfile(): ResearchProfile {
    const text = this.db.prepare("SELECT value FROM settings WHERE key='researchProfile'").get() as
      { value: string } | undefined;
    const date = this.db
      .prepare("SELECT value FROM settings WHERE key='researchProfileUpdatedAt'")
      .get() as { value: string } | undefined;
    return { text: text?.value ?? '', updatedAt: date?.value ?? null };
  }
  private writeProfile(text: string) {
    const put = this.db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    put.run('researchProfile', text);
    put.run('researchProfileUpdatedAt', new Date().toISOString());
  }
  setProfile(text: string): ResearchProfile {
    const value = string(text, 'profile', 100000);
    this.transaction(() => this.writeProfile(value));
    return this.getProfile();
  }
}
