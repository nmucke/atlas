export type ReadingStatus = 'inbox' | 'reading' | 'read';
export interface Paper {
  id: string;
  zoteroKey: string;
  title: string;
  authors: string[];
  year: string;
  publication: string;
  abstract: string;
  doi: string;
  url: string;
  itemType: string;
  /** Atlas-owned tags, independent of Zotero metadata. */
  tags: string[];
  zoteroTags: string[];
  collections: string[];
  status: ReadingStatus;
  starred: boolean;
  archived: boolean;
  summary: string;
  notes: string;
  addedAt: string;
  updatedAt: string;
  attachments: Attachment[];
  sourceMissing?: boolean;
}
export interface Attachment {
  id: string;
  title: string;
  contentType: string;
  filename: string;
}
export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
}
export interface Annotation {
  id: string;
  paperId: string;
  attachmentId: string;
  page: number;
  text: string;
  quote: string;
  color: string;
  createdAt: string;
}
export type TagCategory = 'method' | 'data' | 'domain' | 'model' | 'task';
export type TagOrigin = 'atlas' | 'zotero';
export interface Tag {
  id: string;
  name: string;
  description: string;
  origin: TagOrigin;
  category: TagCategory | null;
  paperCount: number;
}
export interface LibraryResponse {
  papers: Paper[];
  collections: Collection[];
  tags: Tag[];
}
export interface SyncState {
  syncing: boolean;
  lastSync: string | null;
  error: string | null;
  imported: number;
  updated: number;
}
export interface AppInfo {
  name: string;
  version: string;
  dataDirectory: string;
  zoteroBaseUrl: string;
  sync: SyncState;
}

export type ProjectStatus = 'active' | 'paused' | 'completed';
export interface Project {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  githubUrl: string;
  overleafUrl: string;
  status: ProjectStatus;
  paperIds: string[];
  noteCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectNote {
  id: string;
  projectId: string;
  title: string;
  body: string;
  folder: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  authorType?: 'human' | 'ai';
  aiRecordId?: string | null;
}
export interface ProjectAsset {
  id: string;
  projectId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}
export interface ProjectDetail {
  project: Project;
  notes: ProjectNote[];
}
