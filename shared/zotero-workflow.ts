import type { Citation } from './assistant.ts';

export type ZoteroActionStatus =
  'pending' | 'running' | 'write_done' | 'completed' | 'failed' | 'rejected';

export interface ZoteroAction {
  id: string;
  kind: 'pdf' | 'trash';
  paperId: string;
  keepPaperId: string | null;
  title: string;
  reason: string;
  pdfUrl: string | null;
  sourceUrl: string | null;
  license: string | null;
  preview: {
    trash: {
      key: string;
      title: string;
      doi: string;
      authors: string[];
      year: string;
      tags: string[];
      collections: string[];
      children: {
        key: string;
        title: string;
        type: string;
        version: number;
        contentType: string;
        filename: string;
      }[];
      atlasSummary: string;
      atlasNotes: string;
      projects: string[];
    };
    keep: {
      key: string;
      title: string;
      doi: string;
      authors: string[];
      year: string;
      tags: string[];
      collections: string[];
      children: {
        key: string;
        title: string;
        type: string;
        version: number;
        contentType: string;
        filename: string;
      }[];
      atlasSummary: string;
      atlasNotes: string;
      projects: string[];
    };
  } | null;
  agent: { name: string; model: string };
  citations: Citation[];
  status: ZoteroActionStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZoteroPdfInventoryItem {
  paperId: string;
  title: string;
  doi: string;
  state: 'no_pdf' | 'available' | 'unavailable' | 'unsupported';
  attachments: { id: string; title: string; state: 'available' | 'unavailable' }[];
}

export interface ZoteroPdfCandidate {
  id: string;
  paperId: string;
  title: string;
  pdfUrl: string;
  sourceUrl: string;
  license: string | null;
  version: string | null;
}
