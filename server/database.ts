import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  Annotation,
  Collection,
  LibraryResponse,
  Paper,
  Tag,
  TagCategory,
} from '../shared/types.ts';

const tagCategories = new Set<TagCategory>(['method', 'data', 'domain', 'model', 'task']);

function atlasTagName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Tag name must be text');
  const name = value.trim();
  if (!name || name.length > 120 || name.split('/').some((part) => !part.trim()))
    throw new Error('Tag name must be 1–120 characters with no empty slash segments');
  return name;
}

function tagDescription(value: unknown): string {
  if (typeof value !== 'string' || value.length > 280)
    throw new Error('Tag description must be text under 280 characters');
  return value.trim();
}

function tagCategory(name: string, origin: string): TagCategory | null {
  if (origin !== 'atlas') return null;
  const slash = name.indexOf('/');
  if (slash < 0 || !name.slice(slash + 1).trim()) return null;
  const prefix = name.slice(0, slash);
  return tagCategories.has(prefix as TagCategory) ? (prefix as TagCategory) : null;
}

function sourceTags(payload: string): string[] {
  const tags = JSON.parse(payload).tags;
  return Array.isArray(tags)
    ? [
        ...new Set(
          tags
            .map((tag: any) => tag?.tag)
            .filter((name: unknown): name is string => typeof name === 'string' && !!name),
        ),
      ]
    : [];
}

export interface SourceItem {
  key: string;
  version?: number;
  data: Record<string, any>;
}
export interface Snapshot {
  id: string;
  name: string;
  prefix: string;
  serverId: string | null;
  items: SourceItem[];
  collections: SourceItem[];
}
export class AtlasDatabase {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, server_id TEXT);
      CREATE TABLE IF NOT EXISTS source_items(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id), zotero_key TEXT NOT NULL, payload TEXT NOT NULL, missing INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(library_id,zotero_key));
      CREATE TABLE IF NOT EXISTS paper_state(id TEXT PRIMARY KEY REFERENCES source_items(id), status TEXT NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','reading','read')), starred INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id), name TEXT NOT NULL, parent_id TEXT);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY REFERENCES source_items(id), paper_id TEXT NOT NULL REFERENCES paper_state(id), title TEXT NOT NULL, content_type TEXT NOT NULL, filename TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_paper ON attachments(paper_id);
      CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES paper_state(id), attachment_id TEXT NOT NULL REFERENCES source_items(id), page INTEGER NOT NULL CHECK(page > 0), text TEXT NOT NULL, quote TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS annotations_paper ON annotations(paper_id);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations VALUES(1);`);
    if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .exec(`CREATE TABLE tag_definitions(id TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK(origin IN ('atlas','zotero')), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', UNIQUE(origin,name));
          CREATE TABLE paper_tags(paper_id TEXT NOT NULL REFERENCES paper_state(id), tag_id TEXT NOT NULL REFERENCES tag_definitions(id), PRIMARY KEY(paper_id,tag_id));
          CREATE INDEX paper_tags_tag ON paper_tags(tag_id);`);
        const rows = this.db
          .prepare('SELECT s.payload FROM source_items s JOIN paper_state p ON p.id=s.id')
          .all() as { payload: string }[];
        for (const row of rows) this.ensureSourceTags(sourceTags(row.payload));
        this.db.prepare('INSERT INTO schema_migrations VALUES(2)').run();
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }
  close() {
    this.db.close();
  }
  getSetting(key: string): string | null {
    return (
      (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any)?.value ?? null
    );
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  private ensureSourceTags(names: string[]) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tag_definitions(id,origin,name) VALUES(?,'zotero',?)",
    );
    for (const name of new Set(names)) insert.run(randomUUID(), name);
  }
  private tag(row: any, paperCount: number): Tag {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      origin: row.origin,
      category: tagCategory(row.name, row.origin),
      paperCount,
    };
  }
  private tagById(id: string): Tag | null {
    return this.library().tags.find((tag) => tag.id === id) ?? null;
  }
  private ensureAtlasTag(name: string, description = ''): string {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO tag_definitions(id,origin,name,description) VALUES(?,'atlas',?,?)",
      )
      .run(randomUUID(), name, description);
    const row = this.db
      .prepare("SELECT id FROM tag_definitions WHERE origin='atlas' AND name=?")
      .get(name) as { id: string };
    return row.id;
  }
  createTag(data: Record<string, unknown>): Tag {
    for (const key of Object.keys(data))
      if (!['name', 'description'].includes(key)) throw new Error(`Unknown tag field: ${key}`);
    const name = atlasTagName(data.name);
    const description = data.description === undefined ? '' : tagDescription(data.description);
    return this.tagById(this.ensureAtlasTag(name, description))!;
  }
  patchTag(id: string, data: Record<string, unknown>): Tag | null {
    for (const key of Object.keys(data))
      if (key !== 'description') throw new Error(`Unknown tag field: ${key}`);
    if (!Object.hasOwn(data, 'description')) throw new Error('Tag description is required');
    const description = tagDescription(data.description);
    const changed = this.db
      .prepare('UPDATE tag_definitions SET description=? WHERE id=?')
      .run(description, id).changes;
    return changed ? this.tagById(id) : null;
  }
  applySnapshots(snapshots: Snapshot[]) {
    let imported = 0,
      updated = 0;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Only called after ALL libraries were fetched and validated successfully.
      this.db.exec('UPDATE source_items SET missing=1; DELETE FROM collections;');
      for (const snap of snapshots) {
        this.db
          .prepare(
            'INSERT INTO libraries VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prefix=excluded.prefix,server_id=excluded.server_id',
          )
          .run(snap.id, snap.name, snap.prefix, snap.serverId);
        this.db.prepare('DELETE FROM collections WHERE library_id=?').run(snap.id);
        const idFor = (key: string) => `${snap.id}:${key}`;
        for (const c of snap.collections)
          this.db
            .prepare('INSERT INTO collections VALUES(?,?,?,?)')
            .run(
              idFor(c.key),
              snap.id,
              String(c.data.name ?? 'Untitled collection'),
              c.data.parentCollection ? idFor(c.data.parentCollection) : null,
            );
        for (const item of snap.items) {
          const id = idFor(item.key),
            payload = JSON.stringify(item.data);
          const old = this.db.prepare('SELECT payload FROM source_items WHERE id=?').get(id) as any;
          this.db
            .prepare(
              'INSERT INTO source_items VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,missing=excluded.missing,updated_at=CASE WHEN payload<>excluded.payload THEN excluded.updated_at ELSE updated_at END',
            )
            .run(id, snap.id, item.key, payload, item.data.deleted ? 1 : 0, now);
          const type = item.data.itemType;
          const isPaper =
            !['note', 'annotation', 'attachment'].includes(type) ||
            (type === 'attachment' &&
              !item.data.parentItem &&
              item.data.contentType === 'application/pdf');
          if (isPaper) {
            const added = this.db
              .prepare('INSERT OR IGNORE INTO paper_state(id,added_at) VALUES(?,?)')
              .run(id, now);
            if (added.changes) imported++;
            else if (old?.payload !== payload) updated++;
            this.ensureSourceTags(sourceTags(payload));
          }
        }
        // Rebuild links only; original source rows and Atlas annotations are retained.
        this.db
          .prepare(
            'DELETE FROM attachments WHERE id IN (SELECT id FROM source_items WHERE library_id=?)',
          )
          .run(snap.id);
        for (const item of snap.items) {
          if (item.data.itemType !== 'attachment' || item.data.deleted) continue;
          const id = idFor(item.key),
            parent = item.data.parentItem ? idFor(item.data.parentItem) : id;
          if (this.db.prepare('SELECT id FROM paper_state WHERE id=?').get(parent))
            this.db
              .prepare('INSERT INTO attachments VALUES(?,?,?,?,?)')
              .run(
                id,
                parent,
                String(item.data.title ?? 'PDF'),
                String(item.data.contentType ?? ''),
                String(item.data.filename ?? ''),
              );
        }
      }
      this.setSetting('lastSync', now);
      this.db.exec('COMMIT');
      return { imported, updated };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  library(): LibraryResponse {
    const rows = this.db
      .prepare(
        'SELECT s.*,p.status,p.starred,p.archived,p.summary,p.notes,p.added_at FROM source_items s JOIN paper_state p ON p.id=s.id ORDER BY p.added_at DESC,s.id',
      )
      .all() as any[];
    const attachments = this.db
      .prepare('SELECT a.* FROM attachments a JOIN source_items s ON s.id=a.id WHERE s.missing=0')
      .all() as any[];
    const byPaper = new Map<string, any[]>();
    for (const a of attachments) {
      const list = byPaper.get(a.paper_id) ?? [];
      list.push({ id: a.id, title: a.title, contentType: a.content_type, filename: a.filename });
      byPaper.set(a.paper_id, list);
    }
    const atlasTagRows = this.db
      .prepare(
        "SELECT pt.paper_id,td.name FROM paper_tags pt JOIN tag_definitions td ON td.id=pt.tag_id WHERE td.origin='atlas' ORDER BY pt.rowid",
      )
      .all() as { paper_id: string; name: string }[];
    const atlasTagsByPaper = new Map<string, string[]>();
    for (const row of atlasTagRows) {
      const names = atlasTagsByPaper.get(row.paper_id) ?? [];
      names.push(row.name);
      atlasTagsByPaper.set(row.paper_id, names);
    }
    const papers = rows.map((row) => {
      const d = JSON.parse(row.payload);
      return {
        id: row.id,
        zoteroKey: row.zotero_key,
        title: d.title || 'Untitled paper',
        authors: (d.creators ?? []).map(
          (c: any) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
        ),
        year: String(d.date ?? '').match(/\b\d{4}\b/)?.[0] ?? '',
        publication: d.publicationTitle || d.proceedingsTitle || d.university || d.publisher || '',
        abstract: d.abstractNote || '',
        doi: d.DOI || '',
        url: d.url || '',
        itemType: d.itemType || '',
        tags: atlasTagsByPaper.get(row.id) ?? [],
        zoteroTags: sourceTags(row.payload),
        collections: (d.collections ?? []).map((key: string) => `${row.library_id}:${key}`),
        status: row.status,
        starred: !!row.starred,
        archived: !!row.archived,
        summary: row.summary,
        notes: row.notes,
        addedAt: row.added_at,
        updatedAt: row.updated_at,
        attachments: byPaper.get(row.id) ?? [],
        sourceMissing: !!row.missing,
      } as Paper;
    });
    const collections = this.db
      .prepare('SELECT id,name,parent_id AS parentId FROM collections ORDER BY name COLLATE NOCASE')
      .all() as unknown as Collection[];
    const counts = new Map<string, number>();
    const definitions = this.db
      .prepare(
        'SELECT id,origin,name,description FROM tag_definitions ORDER BY origin,name COLLATE NOCASE',
      )
      .all() as { id: string; origin: string; name: string; description: string }[];
    const atlasIds = new Map(
      definitions.filter((tag) => tag.origin === 'atlas').map((tag) => [tag.name, tag.id]),
    );
    const zoteroIds = new Map(
      definitions.filter((tag) => tag.origin === 'zotero').map((tag) => [tag.name, tag.id]),
    );
    for (const paper of papers) {
      if (paper.archived) continue;
      for (const name of new Set(paper.tags)) {
        const id = atlasIds.get(name);
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const name of new Set(paper.zoteroTags)) {
        const id = zoteroIds.get(name);
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const tags = definitions.map((row) => this.tag(row, counts.get(row.id) ?? 0));
    return { papers, collections, tags };
  }
  paper(id: string) {
    return this.library().papers.find((p) => p.id === id);
  }
  patchPaper(id: string, patch: Record<string, unknown>) {
    if (!this.db.prepare('SELECT id FROM paper_state WHERE id=?').get(id)) return null;
    const allowed = ['status', 'starred', 'archived', 'summary', 'notes', 'tags'];
    let tagNames: string[] | undefined;
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) throw new Error(`Unknown paper field: ${key}`);
      if (key === 'status' && !['inbox', 'reading', 'read'].includes(value as string))
        throw new Error('Invalid reading status');
      if (['starred', 'archived'].includes(key) && typeof value !== 'boolean')
        throw new Error(`${key} must be a boolean`);
      if (
        ['summary', 'notes'].includes(key) &&
        (typeof value !== 'string' || value.length > 200000)
      )
        throw new Error(`${key} must be text under 200,000 characters`);
      if (key === 'tags') {
        if (!Array.isArray(value) || value.length > 100)
          throw new Error('tags must be an array of at most 100 names');
        tagNames = [...new Set(value.map(atlasTagName))];
      }
    }
    const entries = Object.entries(patch).filter(([key]) => key !== 'tags');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (entries.length)
        this.db
          .prepare(`UPDATE paper_state SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
          .run(...entries.map(([, v]) => (typeof v === 'boolean' ? Number(v) : (v as string))), id);
      if (tagNames) {
        this.db.prepare('DELETE FROM paper_tags WHERE paper_id=?').run(id);
        const insert = this.db.prepare('INSERT INTO paper_tags(paper_id,tag_id) VALUES(?,?)');
        for (const name of tagNames) {
          insert.run(id, this.ensureAtlasTag(name));
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.paper(id);
  }
  annotations(paperId: string): Annotation[] {
    return this.db
      .prepare(
        'SELECT id,paper_id AS paperId,attachment_id AS attachmentId,page,text,quote,color,created_at AS createdAt FROM annotations WHERE paper_id=? ORDER BY page,created_at',
      )
      .all(paperId) as unknown as Annotation[];
  }
  addAnnotation(paperId: string, data: Record<string, unknown>) {
    if (
      typeof data.attachmentId !== 'string' ||
      !this.db
        .prepare('SELECT id FROM attachments WHERE id=? AND paper_id=?')
        .get(data.attachmentId, paperId)
    )
      throw new Error('Attachment does not belong to this paper');
    if (!Number.isInteger(data.page) || Number(data.page) < 1 || Number(data.page) > 100000)
      throw new Error('A valid page number is required');
    const note = data.text ?? '',
      quote = data.quote ?? '',
      color = data.color ?? '#d6e2b6';
    if (
      typeof note !== 'string' ||
      typeof quote !== 'string' ||
      note.length > 20000 ||
      quote.length > 20000 ||
      !(note.trim() || quote.trim())
    )
      throw new Error('Add a note or quote (under 20,000 characters)');
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))
      throw new Error('Invalid annotation color');
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO annotations VALUES(?,?,?,?,?,?,?,?)')
      .run(id, paperId, data.attachmentId, Number(data.page), note, quote, color, createdAt);
    return this.annotations(paperId).find((a) => a.id === id)!;
  }
  deleteAnnotation(id: string) {
    return this.db.prepare('DELETE FROM annotations WHERE id=?').run(id).changes > 0;
  }
  attachment(id: string) {
    return this.db
      .prepare(
        'SELECT a.*,s.zotero_key,l.prefix,l.server_id FROM attachments a JOIN source_items s ON s.id=a.id JOIN libraries l ON l.id=s.library_id WHERE a.id=? AND s.missing=0',
      )
      .get(id) as
      | { content_type: string; zotero_key: string; prefix: string; server_id: string | null }
      | undefined;
  }
}
