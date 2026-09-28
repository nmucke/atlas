import type { AIRecordInput, AICandidate, Citation } from '../shared/assistant.ts';
import { AssistantStore } from './assistant-store.ts';
import { AtlasDatabase } from './database.ts';
import { ProjectStore } from './projects.ts';
import { Retrieval } from './retrieval.ts';

export class AssistantService {
  library: AtlasDatabase;
  projects: ProjectStore;
  store: AssistantStore;
  retrieval: Retrieval;
  private indexing: Promise<ReturnType<Retrieval['status']>> | null = null;
  constructor(library: AtlasDatabase, projects: ProjectStore) {
    this.library = library;
    this.projects = projects;
    this.store = new AssistantStore(library.db);
    this.retrieval = new Retrieval(library, projects, this.store);
  }
  status() {
    return {
      records: this.store.list(),
      profile: this.store.getProfile(),
      index: { ...this.retrieval.status(), indexing: !!this.indexing },
    };
  }
  index(includePdfs = true) {
    if (this.indexing) return this.indexing;
    this.indexing = this.retrieval.index(includePdfs).finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }
  submit(
    input: Omit<AIRecordInput, 'agent' | 'citations'> & {
      runId: string;
      citationIds: string[];
      requestKey?: string;
    },
  ) {
    const { runId, citationIds, requestKey, ...record } = input;
    const run = this.retrieval.run(runId);
    // A stable request key makes network retries idempotent within one run, without replacing prior content.
    const key = requestKey ? `assistantSubmission:${runId}:${requestKey}` : null;
    if (key) {
      const previous = this.library.getSetting(key);
      if (previous) {
        const found = this.store.list().find((r) => r.id === previous);
        if (found) return found;
      }
    }
    const evidence = citationIds.length ? this.retrieval.citations(runId, citationIds) : [];
    if (record.kind !== 'profile' && !evidence.length)
      throw new Error('Retrieve and cite evidence before submitting');
    if (
      record.kind === 'review' &&
      !evidence.some((e) => e.paperId === record.paperId && ['paper', 'pdf'].includes(e.kind))
    )
      throw new Error('A review must cite primary evidence for this paper');
    if (record.kind === 'note' && !evidence.some((e) => e.projectId === record.projectId))
      throw new Error('Retrieve this project context before writing a project note');
    if (record.kind === 'recommendation') {
      if (
        record.paperId &&
        !evidence.some((e) => e.paperId === record.paperId && ['paper', 'pdf'].includes(e.kind))
      )
        throw new Error('Retrieve the recommended paper before submitting');
      if (record.projectId && !evidence.some((e) => e.projectId === record.projectId))
        throw new Error('Project recommendations must cite project context');
      if (record.candidate) {
        const external = evidence.find(
          (e) =>
            e.kind === 'external' &&
            e.sourceId === `external:${record.candidate!.doi.toLowerCase()}`,
        );
        if (!external)
          throw new Error('External recommendations must cite metadata from atlas_find_papers');
        const chunks = this.library.db
          .prepare('SELECT text FROM rag_chunks WHERE document_id=? ORDER BY ordinal')
          .all(external.sourceId) as { text: string }[];
        // Candidate metadata is read back from its verified record; never trust model-invented titles or DOIs.
        const raw = chunks.map((c, n) => (n ? c.text.slice(200) : c.text)).join('');
        const candidate = JSON.parse(raw) as AICandidate;
        record.candidate = candidate;
        const existing = this.library
          .library()
          .papers.find(
            (p) =>
              p.doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '') ===
              candidate.doi.toLowerCase(),
          );
        if (existing) {
          record.paperId = existing.id;
          record.candidate = null;
        }
      }
    }
    if (record.kind === 'tags') {
      if (record.paperId && !evidence.some((e) => e.paperId === record.paperId))
        throw new Error('Retrieve paper evidence for paper tags');
      if (record.projectId && !evidence.some((e) => e.projectId === record.projectId))
        throw new Error('Retrieve project evidence for project tags');
    }
    const citations: Citation[] = evidence.map(
      ({ chunkId, sourceId, title, quote, page, hash }) => ({
        chunkId,
        sourceId,
        title: title.slice(0, 500),
        quote,
        page,
        hash,
      }),
    );
    const saved = this.store.submit({
      ...record,
      agent: { name: run.agent_name, model: run.model },
      citations,
    });
    if (key) this.library.setSetting(key, saved.id);
    return saved;
  }
  async findPapers(runId: string, query: string, limit = 8, fetcher: typeof fetch = fetch) {
    this.retrieval.run(runId);
    if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 15)
      throw new Error('Use a public research query under 500 characters and limit 1–15');
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query.bibliographic', query);
    url.searchParams.set('rows', String(limit));
    const response = await fetcher(url, {
      headers: { 'User-Agent': 'Atlas-local-research/0.1 (MCP literature discovery)' },
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Crossref returned ${response.status}. Try again later.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty Crossref response');
    let size = 0;
    const buffers: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Crossref response too large');
      }
      buffers.push(value);
    }
    const payload = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!Array.isArray(payload.message?.items)) throw new Error('Invalid Crossref response');
    const results = [];
    for (const item of payload.message.items) {
      if (
        typeof item.DOI !== 'string' ||
        !/^10\.\d{4,9}\/\S+$/i.test(item.DOI) ||
        typeof item.title?.[0] !== 'string'
      )
        continue;
      const candidate: AICandidate = {
        title: item.title[0].slice(0, 300),
        authors: (Array.isArray(item.author) ? item.author : [])
          .slice(0, 100)
          .map((a: any) =>
            [a.given, a.family]
              .filter((v) => typeof v === 'string')
              .join(' ')
              .slice(0, 160),
          )
          .filter(Boolean),
        year: String(item.published?.['date-parts']?.[0]?.[0] ?? '').slice(0, 20),
        doi: item.DOI.slice(0, 250),
        url: `https://doi.org/${encodeURIComponent(item.DOI)}`,
        abstract:
          typeof item.abstract === 'string'
            ? item.abstract.replace(/<[^>]*>/g, ' ').slice(0, 20000)
            : '',
      };
      const evidence = this.retrieval.addExternal(runId, candidate);
      results.push({ candidate, ...evidence });
    }
    return {
      results,
      coverage:
        'Crossref metadata only; no full text was read. This is not an exhaustive literature search.',
    };
  }
}
