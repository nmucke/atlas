import { PdfDownloadCache } from './pdf-download-cache.ts';
import { extractCandidatePdf, verifyPdfIdentity } from './pdf-verification.ts';
import { attachmentAvailability } from './attachment-availability.ts';
import { pdfLocation } from './pdf-location.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { AtlasDatabase } from './database.ts';
import type { ProjectStore } from './projects.ts';
import type { Retrieval } from './retrieval.ts';
import { ZoteroClient } from './zotero.ts';
import { ZoteroWriter, downloadPublicPdf, publicHttpsUrl } from './zotero-write.ts';
import type { Citation } from '../shared/assistant.ts';
import type {
  ZoteroAction,
  ZoteroPdfCandidate,
  ZoteroPdfInventoryItem,
} from '../shared/zotero-workflow.ts';

type Source = {
  id: string;
  key: string;
  prefix: string;
  serverId: string;
  data: Record<string, any>;
  missing: number;
};
type ActionRow = {
  id: string;
  kind: 'pdf' | 'trash';
  paper_id: string;
  keep_paper_id: string | null;
  title: string;
  reason: string;
  pdf_url: string | null;
  source_url: string | null;
  license: string | null;
  preview_json: string | null;
  agent_json: string;
  citations_json: string;
  status: ZoteroAction['status'];
  error: string | null;
  server_id: string;
  prefix: string;
  item_key: string;
  expected_version: number;
  attachment_key: string | null;
  created_at: string;
  updated_at: string;
};
type Child = {
  key: string;
  title: string;
  type: string;
  version: number;
  contentType: string;
  filename: string;
};
type PreviewSide = NonNullable<ZoteroAction['preview']>['trash'];
const keyAlphabet = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
function attachmentKey() {
  return [...randomBytes(8)].map((byte) => keyAlphabet[byte % keyAlphabet.length]).join('');
}
function doi(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
}
function titleKey(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function validKey(value: unknown): value is string {
  return typeof value === 'string' && /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(value);
}
function itemData(value: any) {
  if (!value || !validKey(value.key) || !value.data || typeof value.data !== 'object')
    throw new Error('Zotero returned an invalid item');
  const version = Number(value.version ?? value.data.version);
  if (!Number.isInteger(version) || version < 0) throw new Error('Zotero item version is missing');
  return { ...value.data, key: value.key, version } as Record<string, any> & {
    key: string;
    version: number;
  };
}
function children(value: unknown): Child[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('Zotero returned invalid child items');
  return value
    .map((raw) => {
      const d = itemData(raw);
      return {
        key: d.key,
        title: String(d.title ?? ''),
        type: String(d.itemType ?? ''),
        version: d.version,
        contentType: String(d.contentType ?? ''),
        filename: String(d.filename ?? ''),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}
function isPdfChild(child: Child) {
  return (
    child.type === 'attachment' &&
    (child.contentType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(child.filename))
  );
}

export class ZoteroWorkflow {
  private library: AtlasDatabase;
  private projects: ProjectStore;
  private retrieval: Retrieval;
  readonly writer: ZoteroWriter;
  private client: ZoteroClient;
  private fetcher: typeof fetch;
  private downloader: (url: string) => Promise<Buffer>;
  private downloadCache: PdfDownloadCache;
  private extractCandidate: (pdf: Buffer) => Promise<string[]>;
  private busy = new Set<string>();
  private syncQueue: Promise<void> = Promise.resolve();
  private syncer: (() => Promise<void>) | null = null;
  constructor(
    library: AtlasDatabase,
    projects: ProjectStore,
    retrieval: Retrieval,
    options: {
      fetcher?: typeof fetch;
      downloader?: (url: string) => Promise<Buffer>;
      downloadCache?: PdfDownloadCache;
      extractCandidate?: (pdf: Buffer) => Promise<string[]>;
    } = {},
  ) {
    this.library = library;
    this.projects = projects;
    this.retrieval = retrieval;
    this.fetcher = options.fetcher ?? fetch;
    this.downloader = options.downloader ?? downloadPublicPdf;
    this.downloadCache = options.downloadCache ?? new PdfDownloadCache();
    this.extractCandidate = options.extractCandidate ?? extractCandidatePdf;
    this.writer = new ZoteroWriter(this.fetcher);
    this.client = new ZoteroClient(this.fetcher);
    library.db.exec(`
      CREATE TABLE IF NOT EXISTS zotero_pdf_candidates(
        id TEXT PRIMARY KEY,run_id TEXT NOT NULL,paper_id TEXT NOT NULL,pdf_url TEXT NOT NULL,
        source_url TEXT NOT NULL,license TEXT,version TEXT,title TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS zotero_verified_pdfs(candidate_id TEXT PRIMARY KEY REFERENCES zotero_pdf_candidates(id), sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS zotero_actions(
        id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('pdf','trash')),
        paper_id TEXT NOT NULL,keep_paper_id TEXT,title TEXT NOT NULL,reason TEXT NOT NULL,
        pdf_url TEXT,source_url TEXT,license TEXT,preview_json TEXT,
        agent_json TEXT NOT NULL,citations_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','write_done','completed','failed','rejected')),
        error TEXT,server_id TEXT NOT NULL,prefix TEXT NOT NULL,item_key TEXT NOT NULL,
        expected_version INTEGER NOT NULL,attachment_key TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS zotero_actions_status ON zotero_actions(status,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS zotero_pdf_active_per_paper ON zotero_actions(paper_id) WHERE kind='pdf' AND status IN ('running','write_done');
      INSERT OR IGNORE INTO schema_migrations VALUES(7);
    `);
    library.db
      .prepare(
        "UPDATE zotero_actions SET status='failed',error='Atlas restarted before this action finished' WHERE status='running'",
      )
      .run();
  }
  setSync(callback: () => Promise<void>) {
    this.syncer = callback;
  }
  private sync() {
    const run = this.syncQueue.then(async () => {
      if (this.syncer) await this.syncer();
      else this.library.applySnapshots(await this.client.snapshots());
      this.retrieval.refresh();
    });
    this.syncQueue = run.catch(() => undefined);
    return run;
  }
  private source(paperId: string): Source {
    const row = this.library.db
      .prepare(
        `
      SELECT s.id,s.zotero_key AS key,s.payload,s.missing,l.prefix,l.server_id AS serverId
      FROM source_items s JOIN libraries l ON l.id=s.library_id
      JOIN paper_state p ON p.id=s.id WHERE s.id=?
    `,
      )
      .get(paperId) as (Omit<Source, 'data'> & { payload: string }) | undefined;
    if (!row || row.missing || !row.serverId || !/^\/(users\/0|groups\/\d+)$/.test(row.prefix))
      throw new Error('Paper is unavailable in the current Zotero library');
    return { ...row, data: JSON.parse(row.payload) };
  }
  private async live(source: Source) {
    const response = await this.writer.read(
      `${source.prefix}/items/${source.key}`,
      source.serverId,
    );
    return itemData(await response.json());
  }
  private async childItems(source: Source) {
    const response = await this.writer.read(
      `${source.prefix}/items/${source.key}/children`,
      source.serverId,
    );
    return children(await response.json());
  }
  private row(row: ActionRow): ZoteroAction {
    return {
      id: row.id,
      kind: row.kind,
      paperId: row.paper_id,
      keepPaperId: row.keep_paper_id,
      title: row.title,
      reason: row.reason,
      pdfUrl: row.pdf_url,
      sourceUrl: row.source_url,
      license: row.license,
      preview: row.kind === 'trash' && row.preview_json ? JSON.parse(row.preview_json) : null,
      agent: JSON.parse(row.agent_json),
      citations: JSON.parse(row.citations_json),
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private get(id: string): ActionRow | null {
    return this.library.db
      .prepare('SELECT * FROM zotero_actions WHERE id=?')
      .get(id) as ActionRow | null;
  }
  list() {
    return (
      this.library.db
        .prepare('SELECT * FROM zotero_actions ORDER BY created_at DESC,id')
        .all() as ActionRow[]
    ).map((row) => this.row(row));
  }
  async status() {
    try {
      const value = await this.writer.probe();
      return {
        reachable: true,
        version: value.version,
        authorized: value.authorized,
        automaticPdfWrites: value.automaticPdfWrites,
        actions: this.list(),
      };
    } catch {
      return {
        reachable: false,
        version: null,
        authorized: false,
        automaticPdfWrites: false,
        actions: this.list(),
      };
    }
  }
  async authorize() {
    return this.writer.authorize();
  }
  private update(id: string, status: ZoteroAction['status'], error: string | null = null) {
    this.library.db
      .prepare('UPDATE zotero_actions SET status=?,error=?,updated_at=? WHERE id=?')
      .run(status, error, new Date().toISOString(), id);
  }
  private async pdfAvailable(source: Source, child: { id: string; title: string }) {
    try {
      const attachment = this.library.attachment(child.id);
      if (!attachment) return false;
      const path = await this.client.attachmentPath(attachment);
      const info = await stat(path);
      if (!info.isFile() || info.size < 5) return false;
      const file = await open(path, 'r');
      try {
        const header = Buffer.alloc(5);
        await file.read(header, 0, 5, 0);
        return header.toString() === '%PDF-';
      } finally {
        await file.close();
      }
    } catch {
      return false;
    }
  }
  private async checkExistingPdfs(source: Source, children: Child[], ownKey?: string) {
    for (const child of children.filter((child) => child.key !== ownKey && isPdfChild(child))) {
      const state = await attachmentAvailability(this.client, {
        prefix: source.prefix,
        server_id: source.serverId,
        zotero_key: child.key,
        content_type: 'application/pdf',
      });
      if (state.state === 'available')
        throw new Error(
          'Paper already has a usable local PDF. Use atlas_index and retrieve its full text.',
        );
      if (state.state === 'unknown')
        throw new Error(
          `Cannot verify existing PDF ${child.key}: ${state.message} Retry when Zotero is available.`,
        );
    }
  }
  async inventory(
    runId: string,
    offset = 0,
    limit = 30,
  ): Promise<{ items: ZoteroPdfInventoryItem[]; nextOffset: number | null }> {
    this.retrieval.run(runId);
    const papers = this.library.library().papers.filter((p) => !p.sourceMissing);
    const items: ZoteroPdfInventoryItem[] = [];
    for (const paper of papers.slice(offset, offset + limit)) {
      const pdfs = paper.attachments.filter((a) => a.contentType === 'application/pdf');
      const attachments = [];
      for (const pdf of pdfs)
        attachments.push({
          id: pdf.id,
          title: pdf.title,
          state: (await this.pdfAvailable(this.source(paper.id), pdf))
            ? ('available' as const)
            : ('unavailable' as const),
        });
      const state =
        paper.itemType === 'attachment'
          ? ('unsupported' as const)
          : !attachments.length
            ? ('no_pdf' as const)
            : attachments.some((a) => a.state === 'available')
              ? ('available' as const)
              : ('unavailable' as const);
      items.push({ paperId: paper.id, title: paper.title, doi: paper.doi, state, attachments });
    }
    return { items, nextOffset: offset + limit < papers.length ? offset + limit : null };
  }
  async findPdf(
    runId: string,
    paperId: string,
    suppliedUrl?: string,
  ): Promise<ZoteroPdfCandidate | null> {
    this.retrieval.run(runId);
    const source = this.source(paperId);
    if (suppliedUrl) return this.verifyPdfUrl(runId, source, suppliedUrl);
    const paperDoi = doi(String(source.data.DOI ?? ''));
    if (!paperDoi || paperDoi.length > 250)
      throw new Error('This paper has no usable DOI for PDF discovery');
    const response = await this.fetcher(
      `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(paperDoi)}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenAlex lookup failed (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('OpenAlex returned no data');
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error('OpenAlex response is too large');
      }
      parts.push(value);
    }
    const raw = Buffer.concat(parts).toString('utf8');
    const work = JSON.parse(raw) as any;
    if (doi(String(work.doi ?? '')) !== paperDoi)
      throw new Error('OpenAlex returned a different DOI');
    const location = pdfLocation(work);
    if (!location) return null;
    const { pdfUrl, sourceUrl } = location;
    const candidate: ZoteroPdfCandidate = {
      id: randomUUID(),
      paperId,
      title: String(work.title ?? source.data.title ?? '').slice(0, 300),
      pdfUrl,
      sourceUrl,
      license: typeof location.license === 'string' ? location.license.slice(0, 100) : null,
      version: typeof location.version === 'string' ? location.version.slice(0, 100) : null,
    };
    this.library.db
      .prepare('INSERT INTO zotero_pdf_candidates VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        candidate.id,
        runId,
        paperId,
        pdfUrl,
        sourceUrl,
        candidate.license,
        candidate.version,
        candidate.title,
        new Date().toISOString(),
      );
    return candidate;
  }
  private async verifyPdfUrl(
    runId: string,
    source: Source,
    suppliedUrl: string,
  ): Promise<ZoteroPdfCandidate> {
    const pdfUrl = publicHttpsUrl(suppliedUrl).href;
    const pdf = await this.downloader(pdfUrl);
    if (pdf.length > 40 * 1024 * 1024 || !pdf.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new Error('Candidate is not a valid PDF within the 40 MiB verification limit');
    const title = String(source.data.title ?? '');
    const creator = source.data.creators?.[0];
    verifyPdfIdentity(await this.extractCandidate(pdf), {
      title,
      doi: String(source.data.DOI ?? ''),
      author: String(creator?.lastName ?? creator?.name ?? ''),
    });
    const candidate: ZoteroPdfCandidate = {
      id: randomUUID(),
      paperId: source.id,
      title,
      pdfUrl,
      sourceUrl: pdfUrl,
      license: null,
      version: 'verified full-text copy',
    };
    this.library.db
      .prepare('INSERT INTO zotero_pdf_candidates VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        candidate.id,
        runId,
        source.id,
        pdfUrl,
        pdfUrl,
        null,
        candidate.version,
        title,
        new Date().toISOString(),
      );
    this.library.db
      .prepare('INSERT INTO zotero_verified_pdfs VALUES(?,?)')
      .run(candidate.id, this.downloadCache.put(pdf));
    return candidate;
  }
  async addPdf(runId: string, candidateId: string): Promise<ZoteroAction> {
    const run = this.retrieval.run(runId);
    const candidate = this.library.db
      .prepare('SELECT * FROM zotero_pdf_candidates WHERE id=? AND run_id=?')
      .get(candidateId, runId) as any;
    if (!candidate) throw new Error('PDF candidate was not returned in this run');
    const verification = this.library.db
      .prepare('SELECT sha256 FROM zotero_verified_pdfs WHERE candidate_id=?')
      .get(candidateId) as { sha256: string } | undefined;
    const prior = this.library.db
      .prepare(
        "SELECT * FROM zotero_actions WHERE kind='pdf' AND paper_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(candidate.paper_id) as ActionRow | undefined;
    if (prior) {
      if (prior.status === 'completed' && prior.pdf_url === candidate.pdf_url) {
        const priorChild = await this.writer.readOptional(
          `${prior.prefix}/items/${prior.attachment_key}`,
          prior.server_id,
        );
        if (priorChild) return this.row(prior);
      }
      if (prior.status === 'running' || prior.status === 'write_done')
        return prior.status === 'write_done' ? this.runPdf(prior.id) : this.row(prior);
      if (prior.status === 'failed') {
        if (
          prior.pdf_url === candidate.pdf_url &&
          (JSON.parse(prior.preview_json || '{}').pdfHash ?? null) ===
            (verification?.sha256 ?? null)
        )
          return this.runPdf(prior.id);
        const priorChild = await this.writer.readOptional(
          `${prior.prefix}/items/${prior.attachment_key}`,
          prior.server_id,
        );
        if (priorChild)
          throw new Error(
            'An earlier PDF action created an attachment; retry that action before changing source',
          );
      }
    }
    const source = this.source(candidate.paper_id);
    const current = await this.live(source);
    if (current.deleted || current.itemType === 'attachment')
      throw new Error('Cannot attach a PDF to this item');
    const childList = await this.childItems(source);
    await this.checkExistingPdfs(source, childList);
    const active = this.library.db
      .prepare(
        "SELECT * FROM zotero_actions WHERE kind='pdf' AND paper_id=? AND status IN ('running','write_done')",
      )
      .get(source.id) as ActionRow | undefined;
    if (active) return this.row(active);
    const id = randomUUID(),
      now = new Date().toISOString();
    this.library.db
      .prepare(`INSERT INTO zotero_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        'pdf',
        source.id,
        null,
        `Add PDF to ${String(current.title ?? 'paper').slice(0, 150)}`,
        `PDF ${String(candidate.version ?? 'copy')} from ${candidate.source_url}`,
        candidate.pdf_url,
        candidate.source_url,
        candidate.license,
        JSON.stringify({
          title: String(current.title ?? ''),
          doi: String(current.DOI ?? ''),
          pdfHash: verification?.sha256,
        }),
        JSON.stringify({ name: run.agent_name, model: run.model }),
        '[]',
        'running',
        null,
        source.serverId,
        source.prefix,
        source.key,
        current.version,
        attachmentKey(),
        now,
        now,
      );
    return this.runPdf(id);
  }
  /** Re-reads Zotero into Atlas through the same queue that action writes use. */
  syncLibrary() {
    return this.sync();
  }
  /**
   * Attaches a PDF from a URL Atlas derived itself (for example arxiv.org/pdf/<id>) to a paper the
   * user just added. No assistant run is needed; the title and first author are still verified
   * and the addition is tracked as a normal, retryable PDF action.
   */
  async attachPdfFromUrl(
    paperId: string,
    url: string,
    requestedBy: string,
    reason: string,
  ): Promise<ZoteroAction> {
    const pdfUrl = publicHttpsUrl(url).href;
    const source = this.source(paperId);
    const active = this.library.db
      .prepare(
        "SELECT * FROM zotero_actions WHERE kind='pdf' AND paper_id=? AND status IN ('running','write_done')",
      )
      .get(source.id) as ActionRow | undefined;
    if (active) return this.row(active);
    const current = await this.live(source);
    if (current.deleted || current.itemType === 'attachment')
      throw new Error('Cannot attach a PDF to this item');
    await this.checkExistingPdfs(source, await this.childItems(source));
    const pdf = await this.downloader(pdfUrl);
    if (pdf.length > 40 * 1024 * 1024 || !pdf.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new Error('Candidate is not a valid PDF within the 40 MiB verification limit');
    const creator = current.creators?.[0];
    verifyPdfIdentity(await this.extractCandidate(pdf), {
      title: String(current.title ?? ''),
      doi: '',
      author: String(creator?.lastName ?? creator?.name ?? ''),
    });
    const id = randomUUID(),
      now = new Date().toISOString();
    this.library.db
      .prepare(`INSERT INTO zotero_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        'pdf',
        source.id,
        null,
        `Add PDF to ${String(current.title ?? 'paper').slice(0, 150)}`,
        reason.slice(0, 4000),
        pdfUrl,
        pdfUrl,
        null,
        JSON.stringify({
          title: String(current.title ?? ''),
          doi: String(current.DOI ?? ''),
          pdfHash: this.downloadCache.put(pdf),
        }),
        JSON.stringify({ name: requestedBy, model: '' }),
        '[]',
        'running',
        null,
        source.serverId,
        source.prefix,
        source.key,
        current.version,
        attachmentKey(),
        now,
        now,
      );
    return this.runPdf(id);
  }
  async retryPdf(runId: string, id: string) {
    this.retrieval.run(runId);
    const row = this.get(id);
    if (!row || row.kind !== 'pdf') throw new Error('PDF action not found');
    if (!['failed', 'write_done'].includes(row.status))
      throw new Error('PDF action is not retryable');
    return this.runPdf(id);
  }
  async retry(id: string) {
    const row = this.get(id);
    if (!row) throw new Error('Zotero action not found');
    if (row.status === 'write_done') return this.retrySync(id);
    if (row.kind === 'pdf' && row.status === 'failed') return this.runPdf(id);
    if (row.kind === 'trash' && row.status === 'failed') return this.decide(id, true);
    throw new Error('This action cannot be retried');
  }
  private async runPdf(id: string): Promise<ZoteroAction> {
    if (this.busy.has(id)) throw new Error('This PDF action is already running');
    this.busy.add(id);
    try {
      const row = this.get(id)!;
      if (row.status !== 'write_done') {
        this.update(id, 'running');
        const source = this.source(row.paper_id);
        if (
          source.serverId !== row.server_id ||
          source.prefix !== row.prefix ||
          source.key !== row.item_key
        )
          throw new Error('Zotero source changed; this PDF action cannot continue');
        const { serverId, automaticPdfWrites } = await this.writer.probe();
        if (serverId !== row.server_id)
          throw new Error('Zotero profile changed; sync before retry');
        if (!automaticPdfWrites)
          throw new Error('Enable remembered Zotero writes in Atlas before adding PDFs');
        let ownKey = row.attachment_key!;
        const original = JSON.parse(row.preview_json!) as {
          title: string;
          doi: string;
          pdfHash?: string;
          uploadFilename?: string;
          createAttempt?: number;
        };
        original.uploadFilename ??= `${ownKey}.pdf`;
        this.library.db
          .prepare('UPDATE zotero_actions SET preview_json=? WHERE id=?')
          .run(JSON.stringify(original), id);
        let existingResponse = await this.writer.readOptional(
          `${row.prefix}/items/${ownKey}`,
          row.server_id,
        );
        let existing = existingResponse ? await existingResponse.json() : null;
        if (!existing) {
          // Recover a server-assigned key if the create response was interrupted.
          const matches = (await this.childItems(source)).filter(
            (child) => child.filename === original.uploadFilename,
          );
          if (matches.length > 1)
            throw new Error(
              'Multiple attachments match this upload; inspect the action before retrying',
            );
          if (matches.length === 1) {
            const recovered = itemData(
              await (
                await this.writer.read(`${row.prefix}/items/${matches[0].key}`, row.server_id)
              ).json(),
            );
            if (
              recovered.parentItem !== row.item_key ||
              recovered.itemType !== 'attachment' ||
              recovered.url !== row.pdf_url
            )
              throw new Error('The recovered attachment does not match this PDF action');
            ownKey = recovered.key;
            existing = { key: recovered.key, version: recovered.version, data: recovered };
            this.library.db
              .prepare('UPDATE zotero_actions SET attachment_key=? WHERE id=?')
              .run(ownKey, id);
          }
        }
        if (existing) {
          const data = itemData(existing);
          if (data.parentItem !== row.item_key || data.itemType !== 'attachment')
            throw new Error('The proposed attachment key now belongs to another Zotero item');
          if (data.md5 && data.filename) {
            this.update(id, 'write_done');
          }
        }
        if (this.get(id)!.status !== 'write_done') {
          const parent = await this.live(source);
          if (
            parent.deleted ||
            String(parent.title ?? '') !== original.title ||
            String(parent.DOI ?? '') !== original.doi ||
            (!existing && parent.version !== row.expected_version)
          )
            throw new Error('Paper changed in Zotero; review the PDF addition again');
          const allChildren = await this.childItems(source);
          await this.checkExistingPdfs(source, allChildren, ownKey);
          const pdf =
            (original.pdfHash ? this.downloadCache.get(original.pdfHash) : null) ??
            (await this.downloader(row.pdf_url!));
          if (
            original.pdfHash &&
            createHash('sha256').update(pdf).digest('hex') !== original.pdfHash
          )
            throw new Error(
              'PDF content changed since verification. Find and verify a fresh candidate before attaching it.',
            );
          if (
            pdf.length > 100 * 1024 * 1024 ||
            !pdf.subarray(0, 1024).includes(Buffer.from('%PDF-'))
          )
            throw new Error('PDF is invalid or too large');
          if (!existing) {
            const result = await this.writer.write(
              `${row.prefix}/items`,
              'POST',
              JSON.stringify([
                {
                  itemType: 'attachment',
                  parentItem: row.item_key,
                  linkMode: 'imported_url',
                  title: 'Open-access PDF',
                  url: row.pdf_url,
                  contentType: 'application/pdf',
                  filename: original.uploadFilename,
                },
              ]),
              // Keep the token across ambiguous transport failures. Advance it only
              // after an explicit per-object rejection (which consumes the token).
              {
                'Content-Type': 'application/json',
                'Zotero-Write-Token': createHash('sha256')
                  .update(`${id}:create:${original.createAttempt ?? 0}`)
                  .digest('hex')
                  .slice(0, 32),
              },
              true,
              row.server_id,
            );
            const saved = (await result.json()) as any;
            const createdKey = saved.successful?.['0']?.key ?? saved.success?.['0'];
            if (!validKey(createdKey)) {
              if (saved.failed?.['0']) {
                original.createAttempt = (original.createAttempt ?? 0) + 1;
                this.library.db
                  .prepare('UPDATE zotero_actions SET preview_json=? WHERE id=?')
                  .run(JSON.stringify(original), id);
              }
              throw new Error(
                `Zotero could not create the attachment: ${saved.failed?.['0']?.message ?? 'No valid created item key was returned; retry to reconcile'}`,
              );
            }
            const created = itemData(
              await (
                await this.writer.read(`${row.prefix}/items/${createdKey}`, row.server_id)
              ).json(),
            );
            if (
              created.parentItem !== row.item_key ||
              created.itemType !== 'attachment' ||
              created.filename !== original.uploadFilename ||
              created.url !== row.pdf_url
            )
              throw new Error('Created attachment does not match this PDF action');
            ownKey = createdKey;
            this.library.db
              .prepare('UPDATE zotero_actions SET attachment_key=? WHERE id=?')
              .run(ownKey, id);
          }
          await this.writer.upload(
            row.prefix,
            ownKey,
            pdf,
            original.uploadFilename!,
            row.server_id,
          );
          this.update(id, 'write_done');
        }
      }
      await this.sync();
      this.update(id, 'completed');
    } catch (error) {
      const row = this.get(id)!;
      this.update(
        id,
        row.status === 'write_done' ? 'write_done' : 'failed',
        error instanceof Error ? error.message : 'PDF action failed',
      );
    } finally {
      this.busy.delete(id);
    }
    return this.row(this.get(id)!);
  }
  duplicateCandidates(runId: string) {
    this.retrieval.run(runId);
    const papers = this.library
      .library()
      .papers.filter((paper) => !paper.sourceMissing && paper.itemType !== 'attachment');
    const groups = new Map<string, typeof papers>();
    for (const paper of papers) {
      const source = this.source(paper.id);
      const library = source.id.slice(0, source.id.lastIndexOf(':'));
      const key = doi(paper.doi)
        ? `doi:${doi(paper.doi)}`
        : `title:${titleKey(paper.title)}:${paper.year}:${titleKey(paper.authors[0] ?? '')}`;
      if (!doi(paper.doi) && titleKey(paper.title).length < 12) continue;
      const groupKey = `${library}:${key}`;
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), paper]);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .slice(0, 100)
      .map((group) =>
        group.map((paper) => ({
          paperId: paper.id,
          title: paper.title,
          doi: paper.doi,
          authors: paper.authors,
          year: paper.year,
          attachmentCount: paper.attachments.length,
        })),
      );
  }
  private async preview(
    source: Source,
    data: Record<string, any>,
    childList: Child[],
  ): Promise<PreviewSide> {
    const paper = this.library.paper(source.id)!;
    const projects = this.library.db
      .prepare(
        `SELECT p.name FROM projects p JOIN project_papers pp ON pp.project_id=p.id WHERE pp.paper_id=?`,
      )
      .all(source.id) as { name: string }[];
    return {
      key: source.key,
      title: String(data.title ?? '').slice(0, 300),
      doi: String(data.DOI ?? ''),
      authors: (data.creators ?? [])
        .map((c: any) => String(c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')))
        .slice(0, 100),
      year: String(data.date ?? '').match(/\b\d{4}\b/)?.[0] ?? '',
      tags: (data.tags ?? []).map((tag: any) => String(tag.tag ?? '')).slice(0, 100),
      collections: (data.collections ?? []).map(String).slice(0, 100),
      children: childList,
      atlasSummary: paper.summary,
      atlasNotes: paper.notes,
      projects: projects.map((p) => p.name),
    };
  }
  async proposeDelete(
    runId: string,
    paperId: string,
    keepPaperId: string,
    reason: string,
    citationIds: string[],
    requestKey?: string,
  ) {
    const run = this.retrieval.run(runId);
    if (paperId === keepPaperId) throw new Error('Choose two distinct papers');
    if (!reason.trim() || reason.length > 4000)
      throw new Error('Explain why these items are duplicates');
    if (requestKey) {
      const previous = this.library.getSetting(`zoteroProposal:${runId}:${requestKey}`);
      if (previous) {
        const row = this.get(previous);
        if (row) return this.row(row);
      }
    }
    const cited = this.retrieval.citations(runId, citationIds);
    if (!cited.some((e) => e.paperId === paperId) || !cited.some((e) => e.paperId === keepPaperId))
      throw new Error('Cite retrieved Atlas evidence for both duplicate items');
    const trash = this.source(paperId),
      keep = this.source(keepPaperId);
    if (trash.prefix !== keep.prefix || trash.serverId !== keep.serverId)
      throw new Error('Duplicate items must be in the same Zotero library');
    const [trashData, keepData, trashChildren, keepChildren] = await Promise.all([
      this.live(trash),
      this.live(keep),
      this.childItems(trash),
      this.childItems(keep),
    ]);
    if (trashData.deleted || keepData.deleted)
      throw new Error('A duplicate item is already in Zotero Trash');
    const preview = {
      trash: await this.preview(trash, trashData, trashChildren),
      keep: await this.preview(keep, keepData, keepChildren),
    };
    const citations: Citation[] = cited.map(({ chunkId, sourceId, title, quote, page, hash }) => ({
      chunkId,
      sourceId,
      title,
      quote,
      page,
      hash,
    }));
    const id = randomUUID(),
      now = new Date().toISOString();
    this.library.db
      .prepare('INSERT INTO zotero_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        'trash',
        paperId,
        keepPaperId,
        `Move duplicate to Zotero Trash: ${preview.trash.title}`,
        reason,
        null,
        null,
        null,
        JSON.stringify(preview),
        JSON.stringify({ name: run.agent_name, model: run.model }),
        JSON.stringify(citations),
        'pending',
        null,
        trash.serverId,
        trash.prefix,
        trash.key,
        trashData.version,
        null,
        now,
        now,
      );
    if (requestKey) this.library.setSetting(`zoteroProposal:${runId}:${requestKey}`, id);
    return this.row(this.get(id)!);
  }
  async decide(id: string, approve: boolean) {
    const row = this.get(id);
    if (!row || row.kind !== 'trash') throw new Error('Duplicate proposal not found');
    if ((row.status === 'completed' && approve) || (row.status === 'rejected' && !approve))
      return this.row(row);
    if (row.status !== 'pending' && row.status !== 'failed' && row.status !== 'write_done')
      throw new Error('Duplicate proposal is already being processed');
    if (!approve) {
      if (row.status === 'write_done')
        throw new Error('Item is already in Zotero Trash; Atlas sync must finish');
      this.update(id, 'rejected');
      return this.row(this.get(id)!);
    }
    if (row.status === 'write_done') {
      await this.retrySync(id);
      return this.row(this.get(id)!);
    }
    if (this.busy.has(id)) throw new Error('This duplicate proposal is already running');
    this.busy.add(id);
    try {
      const trash = this.source(row.paper_id),
        keep = this.source(row.keep_paper_id!);
      if (
        trash.serverId !== row.server_id ||
        trash.prefix !== row.prefix ||
        trash.key !== row.item_key ||
        keep.serverId !== row.server_id ||
        keep.prefix !== row.prefix
      )
        throw new Error('Zotero source changed; review duplicates again');
      const [trashData, keepData, trashChildren, keepChildren] = await Promise.all([
        this.live(trash),
        this.live(keep),
        this.childItems(trash),
        this.childItems(keep),
      ]);
      if (trashData.deleted) {
        this.update(id, 'write_done');
      } else {
        const old = JSON.parse(row.preview_json!) as NonNullable<ZoteroAction['preview']>;
        if (
          trashData.version !== row.expected_version ||
          keepData.deleted ||
          JSON.stringify(trashChildren) !== JSON.stringify(old.trash.children) ||
          JSON.stringify(keepChildren) !== JSON.stringify(old.keep.children) ||
          JSON.stringify(await this.preview(keep, keepData, keepChildren)) !==
            JSON.stringify(old.keep) ||
          JSON.stringify(await this.preview(trash, trashData, trashChildren)) !==
            JSON.stringify(old.trash)
        )
          throw new Error('Duplicate items changed since proposal; create a new review');
        this.update(id, 'running');
        await this.writer.write(
          `${row.prefix}/items/${row.item_key}`,
          'PATCH',
          JSON.stringify({ deleted: 1 }),
          {
            'Content-Type': 'application/json',
            'If-Unmodified-Since-Version': String(row.expected_version),
          },
          false,
          row.server_id,
        );
        this.update(id, 'write_done');
      }
      await this.sync();
      this.library.db.prepare('UPDATE paper_state SET archived=1 WHERE id=?').run(row.paper_id);
      this.update(id, 'completed');
    } catch (error) {
      const latest = this.get(id)!;
      this.update(
        id,
        latest.status === 'write_done' ? 'write_done' : 'failed',
        error instanceof Error ? error.message : 'Could not move duplicate to Zotero Trash',
      );
    } finally {
      this.busy.delete(id);
    }
    return this.row(this.get(id)!);
  }
  async retrySync(id: string) {
    const row = this.get(id);
    if (!row || row.status !== 'write_done')
      throw new Error('No Zotero write is awaiting Atlas sync');
    if (this.busy.has(id)) throw new Error('This action is already running');
    this.busy.add(id);
    try {
      await this.sync();
      if (row.kind === 'trash')
        this.library.db.prepare('UPDATE paper_state SET archived=1 WHERE id=?').run(row.paper_id);
      this.update(id, 'completed');
    } catch (error) {
      this.update(id, 'write_done', error instanceof Error ? error.message : 'Atlas sync failed');
    } finally {
      this.busy.delete(id);
    }
    return this.row(this.get(id)!);
  }
}
