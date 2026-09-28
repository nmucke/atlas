import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Project,
  ProjectAsset,
  ProjectDetail,
  ProjectNote,
  ProjectStatus,
} from '../shared/types.ts';

const statuses = new Set<ProjectStatus>(['active', 'paused', 'completed']);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const maxAssetSize = 8 * 1024 * 1024;

function textField(value: unknown, field: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`${field} must be text under ${limit} characters`);
  const result = required ? value.trim() : value;
  if (required && !result) throw new Error(`${field} is required`);
  return result;
}

function tagName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Tag name must be text');
  const name = value.trim();
  if (!name || name.length > 120 || name.split('/').some((part) => !part.trim()))
    throw new Error('Tag name must have no empty slash segments');
  return name;
}

function names(value: unknown, field: string, limit: number, validate: (item: unknown) => string) {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error(`${field} must be an array of at most ${limit} items`);
  return [...new Set(value.map(validate))];
}

function linkedUrl(value: unknown, kind: 'githubUrl' | 'overleafUrl'): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`Invalid ${kind}`);
  if (kind === 'githubUrl') {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/i.exec(value);
    if (!match || match[2] === '.' || match[2] === '..')
      throw new Error('GitHub URL must identify an owner and repository');
    return `https://github.com/${match[1]}/${match[2]}`;
  }
  const match = /^https:\/\/www\.overleaf\.com\/(project|read)\/([A-Za-z0-9]+)\/?$/i.exec(value);
  if (!match) throw new Error('Overleaf URL must identify a project');
  return `https://www.overleaf.com/${match[1].toLowerCase()}/${match[2]}`;
}

function projectFields(data: Record<string, unknown>, creating: boolean) {
  const allowed = new Set([
    'name',
    'summary',
    'tags',
    'paperIds',
    'githubUrl',
    'overleafUrl',
    'status',
  ]);
  for (const key of Object.keys(data))
    if (!allowed.has(key)) throw new Error(`Unknown project field: ${key}`);
  if (creating && data.name === undefined) throw new Error('name is required');
  const result: {
    name?: string;
    summary?: string;
    tags?: string[];
    paperIds?: string[];
    githubUrl?: string;
    overleafUrl?: string;
    status?: ProjectStatus;
  } = {};
  if (data.name !== undefined) result.name = textField(data.name, 'name', 160, true);
  if (data.summary !== undefined) result.summary = textField(data.summary, 'summary', 200000);
  if (data.tags !== undefined) result.tags = names(data.tags, 'tags', 100, tagName);
  if (data.paperIds !== undefined)
    result.paperIds = names(data.paperIds, 'paperIds', 2000, (item) =>
      textField(item, 'paperId', 500, true),
    );
  if (data.githubUrl !== undefined) result.githubUrl = linkedUrl(data.githubUrl, 'githubUrl');
  if (data.overleafUrl !== undefined)
    result.overleafUrl = linkedUrl(data.overleafUrl, 'overleafUrl');
  if (data.status !== undefined) {
    if (!statuses.has(data.status as ProjectStatus)) throw new Error('Invalid project status');
    result.status = data.status as ProjectStatus;
  }
  return result;
}

function noteFields(data: Record<string, unknown>, creating: boolean) {
  const allowed = new Set(['title', 'body', 'folder', 'pinned', 'archived']);
  for (const key of Object.keys(data))
    if (!allowed.has(key)) throw new Error(`Unknown note field: ${key}`);
  const result: {
    title?: string;
    body?: string;
    folder?: string;
    pinned?: boolean;
    archived?: boolean;
  } = {};
  if (data.title !== undefined) result.title = textField(data.title, 'title', 200, true);
  if (data.body !== undefined) result.body = textField(data.body, 'body', 1000000);
  if (data.folder !== undefined) result.folder = textField(data.folder, 'folder', 80, true);
  if (data.pinned !== undefined) {
    if (typeof data.pinned !== 'boolean') throw new Error('pinned must be a boolean');
    result.pinned = data.pinned;
  }
  if (data.archived !== undefined) {
    if (typeof data.archived !== 'boolean') throw new Error('archived must be a boolean');
    result.archived = data.archived;
  }
  if (creating) {
    result.title ??= 'Untitled note';
    result.body ??= '';
    result.folder ??= 'General';
    result.pinned ??= false;
    result.archived ??= false;
  }
  return result;
}

type ProjectRow = {
  id: string;
  name: string;
  summary: string;
  github_url: string;
  overleaf_url: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
};
type NoteRow = {
  id: string;
  project_id: string;
  title: string;
  body: string;
  folder: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
  author_type?: 'human' | 'ai';
  ai_record_id?: string | null;
};
type AssetRow = {
  id: string;
  project_id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
};

export class ProjectStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('PRAGMA foreign_keys=ON');
    if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE projects(
            id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
            github_url TEXT NOT NULL DEFAULT '', overleaf_url TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE project_tags(
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tag_definitions(id),
            PRIMARY KEY(project_id,tag_id)
          );
          CREATE INDEX project_tags_tag ON project_tags(tag_id);
          CREATE TABLE project_papers(
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            paper_id TEXT NOT NULL REFERENCES paper_state(id),
            PRIMARY KEY(project_id,paper_id)
          );
          CREATE INDEX project_papers_paper ON project_papers(paper_id);
          CREATE TABLE project_notes(
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT 'General',
            pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
            archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE INDEX project_notes_project ON project_notes(project_id,archived,pinned,updated_at);
          CREATE TABLE project_assets(
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
            data BLOB NOT NULL, created_at TEXT NOT NULL
          );
          CREATE INDEX project_assets_project ON project_assets(project_id);
        `);
        const now = new Date().toISOString();
        this.db
          .prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)')
          .run(randomUUID(), 'Example project', now, now);
        this.db.prepare('INSERT INTO schema_migrations(version) VALUES(3)').run();
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

  private project(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as
      ProjectRow | undefined;
    if (!row) return null;
    const tags = this.db
      .prepare(
        `
      SELECT td.name FROM project_tags pt JOIN tag_definitions td ON td.id=pt.tag_id
      WHERE pt.project_id=? AND td.origin='atlas' ORDER BY pt.rowid
    `,
      )
      .all(id) as { name: string }[];
    const papers = this.db
      .prepare('SELECT paper_id FROM project_papers WHERE project_id=? ORDER BY rowid')
      .all(id) as { paper_id: string }[];
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM project_notes WHERE project_id=? AND archived=0')
      .get(id) as { count: number };
    return {
      id: row.id,
      name: row.name,
      summary: row.summary,
      tags: tags.map((tag) => tag.name),
      githubUrl: row.github_url,
      overleafUrl: row.overleaf_url,
      status: row.status,
      paperIds: papers.map((paper) => paper.paper_id),
      noteCount: count.count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT id FROM projects ORDER BY updated_at DESC,id').all() as {
      id: string;
    }[];
    return rows.map(({ id }) => this.project(id)!);
  }

  detail(id: string): ProjectDetail | null {
    const project = this.project(id);
    if (!project) return null;
    const rows = this.db
      .prepare(
        `
      SELECT * FROM project_notes WHERE project_id=?
      ORDER BY archived,pinned DESC,updated_at DESC,id
    `,
      )
      .all(id) as NoteRow[];
    return { project, notes: rows.map((row) => this.note(row)) };
  }

  private note(row: NoteRow): ProjectNote {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      body: row.body,
      folder: row.folder,
      pinned: !!row.pinned,
      archived: !!row.archived,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      authorType: row.author_type ?? 'human',
      aiRecordId: row.ai_record_id ?? null,
    };
  }

  private assetMetadata(row: AssetRow): ProjectAsset {
    return {
      id: row.id,
      projectId: row.project_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      createdAt: row.created_at,
    };
  }

  private replaceTags(projectId: string, names: string[]) {
    this.db.prepare('DELETE FROM project_tags WHERE project_id=?').run(projectId);
    const definition = this.db.prepare(
      "INSERT OR IGNORE INTO tag_definitions(id,origin,name) VALUES(?,'atlas',?)",
    );
    const select = this.db.prepare(
      "SELECT id FROM tag_definitions WHERE origin='atlas' AND name=?",
    );
    const assign = this.db.prepare('INSERT INTO project_tags(project_id,tag_id) VALUES(?,?)');
    for (const name of names) {
      definition.run(randomUUID(), name);
      const tag = select.get(name) as { id: string };
      assign.run(projectId, tag.id);
    }
  }

  private replacePapers(projectId: string, paperIds: string[]) {
    const exists = this.db.prepare('SELECT id FROM paper_state WHERE id=?');
    for (const paperId of paperIds)
      if (!exists.get(paperId)) throw new Error(`Unknown paperId: ${paperId}`);
    this.db.prepare('DELETE FROM project_papers WHERE project_id=?').run(projectId);
    const assign = this.db.prepare('INSERT INTO project_papers(project_id,paper_id) VALUES(?,?)');
    for (const paperId of paperIds) assign.run(projectId, paperId);
  }

  create(data: Record<string, unknown>): Project {
    const fields = projectFields(data, true);
    const id = randomUUID(),
      now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO projects(id,name,summary,github_url,overleaf_url,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
      `,
        )
        .run(
          id,
          fields.name!,
          fields.summary ?? '',
          fields.githubUrl ?? '',
          fields.overleafUrl ?? '',
          fields.status ?? 'active',
          now,
          now,
        );
      if (fields.tags) this.replaceTags(id, fields.tags);
      if (fields.paperIds) this.replacePapers(id, fields.paperIds);
    });
    return this.project(id)!;
  }

  patch(id: string, data: Record<string, unknown>): Project | null {
    if (!this.project(id)) return null;
    const fields = projectFields(data, false);
    const column: Record<string, string> = {
      name: 'name',
      summary: 'summary',
      githubUrl: 'github_url',
      overleafUrl: 'overleaf_url',
      status: 'status',
    };
    this.transaction(() => {
      const entries = Object.entries(fields).filter(([key]) => key in column);
      if (entries.length || fields.tags || fields.paperIds) {
        const assignments = entries.map(([key]) => `${column[key]}=?`);
        assignments.push('updated_at=?');
        this.db
          .prepare(`UPDATE projects SET ${assignments.join(',')} WHERE id=?`)
          .run(...entries.map(([, value]) => value as string), new Date().toISOString(), id);
      }
      if (fields.tags) this.replaceTags(id, fields.tags);
      if (fields.paperIds) this.replacePapers(id, fields.paperIds);
    });
    return this.project(id);
  }

  createNote(projectId: string, data: Record<string, unknown>): ProjectNote | null {
    if (!this.project(projectId)) return null;
    const fields = noteFields(data, true);
    const id = randomUUID(),
      now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO project_notes(id,project_id,title,body,folder,pinned,archived,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
      `,
        )
        .run(
          id,
          projectId,
          fields.title!,
          fields.body!,
          fields.folder!,
          Number(fields.pinned),
          Number(fields.archived),
          now,
          now,
        );
      this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, projectId);
    });
    return this.note(this.db.prepare('SELECT * FROM project_notes WHERE id=?').get(id) as NoteRow);
  }

  patchNote(projectId: string, noteId: string, data: Record<string, unknown>): ProjectNote | null {
    const existing = this.db
      .prepare('SELECT * FROM project_notes WHERE id=? AND project_id=?')
      .get(noteId, projectId) as NoteRow | undefined;
    if (!existing) return null;
    const fields = noteFields(data, false);
    const column: Record<string, string> = {
      title: 'title',
      body: 'body',
      folder: 'folder',
      pinned: 'pinned',
      archived: 'archived',
    };
    const entries = Object.entries(fields);
    if (entries.length) {
      const now = new Date().toISOString();
      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE project_notes SET ${entries.map(([key]) => `${column[key]}=?`).join(',')},updated_at=? WHERE id=? AND project_id=?`,
          )
          .run(
            ...entries.map(([, value]) =>
              typeof value === 'boolean' ? Number(value) : (value as string),
            ),
            now,
            noteId,
            projectId,
          );
        this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, projectId);
      });
    }
    return this.note(
      this.db.prepare('SELECT * FROM project_notes WHERE id=?').get(noteId) as NoteRow,
    );
  }

  addAsset(
    projectId: string,
    input: { filename: string; contentType: string; data: Uint8Array },
  ): ProjectAsset | null {
    if (!this.project(projectId)) return null;
    const filename = textField(input.filename, 'filename', 255, true);
    if (/[\\/\u0000-\u001f\u007f]/.test(filename)) throw new Error('Invalid filename');
    if (!imageTypes.has(input.contentType)) throw new Error('Unsupported image content type');
    if (
      !(input.data instanceof Uint8Array) ||
      !input.data.byteLength ||
      input.data.byteLength > maxAssetSize
    )
      throw new Error('Image must be 1 byte to 8 MiB');
    const id = randomUUID(),
      now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO project_assets(id,project_id,filename,content_type,size,data,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(id, projectId, filename, input.contentType, input.data.byteLength, input.data, now);
      this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, projectId);
    });
    return {
      id,
      projectId,
      filename,
      contentType: input.contentType,
      size: input.data.byteLength,
      createdAt: now,
    };
  }

  asset(projectId: string, assetId: string): (ProjectAsset & { data: Uint8Array }) | null {
    const row = this.db
      .prepare('SELECT * FROM project_assets WHERE id=? AND project_id=?')
      .get(assetId, projectId) as (AssetRow & { data: Uint8Array }) | undefined;
    return row ? { ...this.assetMetadata(row), data: row.data } : null;
  }
}
