export type AIKind = 'review' | 'tags' | 'recommendation' | 'note' | 'profile';
export type AIStatus = 'pending' | 'approved' | 'rejected';
export type AILevel = 'essential' | 'recommended' | 'optional';

export interface Citation {
  chunkId: string;
  sourceId: string;
  title: string;
  quote: string;
  page: number | null;
  hash: string;
}

export interface AICandidate {
  title: string;
  authors: string[];
  year: string;
  doi: string;
  url: string;
  abstract: string;
}

export interface AIRecord {
  id: string;
  kind: AIKind;
  paperId: string | null;
  projectId: string | null;
  title: string;
  body: string;
  tags: { name: string; description: string }[];
  level: AILevel | null;
  candidate: AICandidate | null;
  agent: { name: string; model: string };
  citations: Citation[];
  status: AIStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface AIRecordInput {
  kind: AIKind;
  paperId?: string | null;
  projectId?: string | null;
  title: string;
  body: string;
  tags?: { name: string; description: string }[];
  level?: AILevel | null;
  candidate?: AICandidate | null;
  agent: { name: string; model: string };
  citations: Citation[];
}

export interface AIRecordFilters {
  kind?: AIKind;
  status?: AIStatus;
  paperId?: string;
  projectId?: string;
}

export interface ResearchProfile {
  text: string;
  updatedAt: string | null;
}
