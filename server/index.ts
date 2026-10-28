import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, stat, readFile, open } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtlasDatabase } from './database.ts';
import { AssistantService } from './assistant-service.ts';
import { loadAssistantToken } from './assistant-access.ts';
import { createAssistantRpc } from './assistant-rpc.ts';
import { atlasDataDirectory } from './paths.ts';
import { ProjectStore } from './projects.ts';
import { BetterBibTeX } from './bibtex.ts';
import { decodeFigure } from './project-assets.ts';
import { ZoteroClient, ZOTERO_BASE } from './zotero.ts';
import { attachmentAvailability, setAttachmentVisibility } from './attachment-availability.ts';
import { secureRequest, json, readJson } from './http.ts';
import { NewsZotero } from './news-zotero.ts';
import type { NewsListFilter } from '../shared/news.ts';
import type { SyncState } from '../shared/types.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}
if (production && !existsSync(join(root, 'dist', 'index.html')))
  exitWith('Atlas has not been built yet. Run `npm run build` first, or use `npm run dev`.');
const port = Number(process.env.ATLAS_PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  exitWith('ATLAS_PORT must be an integer from 1024 to 65535.');
const dataDirectory = atlasDataDirectory();
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
process.umask(0o077);
const database = new AtlasDatabase(join(dataDirectory, 'atlas.sqlite'));
const projects = new ProjectStore(database.db);
const assistant = new AssistantService(database, projects);
assistant.retrieval.refresh();
const assistantRpc = await createAssistantRpc(assistant, await loadAssistantToken(dataDirectory));
const bibliography = new BetterBibTeX();
const zotero = new ZoteroClient();
const sync: SyncState = {
  syncing: false,
  lastSync: database.getSetting('lastSync'),
  error: null,
  imported: 0,
  updated: 0,
};
async function syncFromZotero() {
  if (sync.syncing) throw new Error('A Zotero sync is already in progress');
  sync.syncing = true;
  sync.error = null;
  try {
    const snapshots = await zotero.snapshots();
    Object.assign(sync, database.applySnapshots(snapshots));
    sync.lastSync = database.getSetting('lastSync');
  } catch (error) {
    sync.error = error instanceof Error ? error.message : 'Sync failed';
    throw error;
  } finally {
    sync.syncing = false;
  }
}
assistant.zotero.setSync(syncFromZotero);
const newsZotero = new NewsZotero(database, projects, assistant.zotero);
const vite = production
  ? null
  : await (
      await import('vite')
    ).createServer({
      root,
      server: { middlewareMode: true, host: '127.0.0.1', hmr: false, ws: false },
      appType: 'spa',
    });
const server = createServer(async (req, res) => {
  if (!secureRequest(req, port)) {
    json(res, 403, { error: 'Only same-origin localhost requests are allowed' });
    return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`),
      path = url.pathname;
    if (path === '/api/assistant/mcp') return await assistantRpc.handle(req, res);
    if (req.headers.authorization)
      return json(res, 403, {
        error: 'Assistant credentials cannot access the Atlas review interface.',
      });
    if (path.startsWith('/api/')) {
      if (
        !['GET', 'HEAD'].includes(req.method ?? '') &&
        !req.headers['content-type']?.startsWith('application/json')
      )
        return json(res, 415, { error: 'Use application/json for Atlas API changes' });
      if (req.method === 'GET' && path === '/api/info')
        return json(res, 200, {
          name: 'Atlas',
          version: '0.1.0',
          dataDirectory,
          zoteroBaseUrl: ZOTERO_BASE,
          sync,
        });
      if (req.method === 'GET' && path === '/api/assistant')
        return json(res, 200, { ...assistant.status(), zotero: await assistant.zotero.status() });
      if (req.method === 'GET' && path === '/api/zotero/status')
        return json(res, 200, await assistant.zotero.status());
      if (req.method === 'POST' && path === '/api/zotero/authorize')
        return json(res, 200, await assistant.zotero.authorize());
      const zoteroAction = path.match(/^\/api\/zotero\/actions\/([^/]+)\/(decision|retry)$/);
      if (req.method === 'POST' && zoteroAction) {
        const id = decodeURIComponent(zoteroAction[1]);
        if (zoteroAction[2] === 'retry') return json(res, 200, await assistant.zotero.retry(id));
        const body = await readJson(req);
        if (typeof body.approve !== 'boolean') throw new Error('approve must be a boolean');
        return json(res, 200, await assistant.zotero.decide(id, body.approve));
      }
      if (req.method === 'POST' && path === '/api/assistant/profile') {
        const body = await readJson(req);
        const profile = assistant.store.setProfile(body.text as string);
        assistant.retrieval.refresh();
        return json(res, 200, profile);
      }
      if (req.method === 'POST' && path === '/api/assistant/index') {
        // Continue the job locally; the UI polls status rather than holding a long request open.
        void assistant.index(true).catch((error) => {
          database.setSetting(
            'ragPdfErrors',
            JSON.stringify([error instanceof Error ? error.message : 'Index failed']),
          );
        });
        return json(res, 202, assistant.status().index);
      }
      const aiDecision = path.match(/^\/api\/assistant\/records\/([^/]+)\/decision$/);
      if (req.method === 'POST' && aiDecision) {
        const body = await readJson(req);
        if (typeof body.approve !== 'boolean') throw new Error('approve must be a boolean');
        const record = assistant.store.decide(decodeURIComponent(aiDecision[1]), body.approve);
        assistant.retrieval.refresh();
        return json(res, record ? 200 : 404, record ?? { error: 'AI record not found' });
      }
      if (path === '/api/news' || path.startsWith('/api/news/')) {
        const news = assistant.news;
        if (req.method === 'GET' && path === '/api/news') {
          const number = (key: string) =>
            url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined;
          return json(
            res,
            200,
            news.list({
              state: (url.searchParams.get('state') || undefined) as NewsListFilter | undefined,
              limit: number('limit'),
              offset: number('offset'),
            }),
          );
        }
        if (path === '/api/news/collect') {
          if (req.method === 'GET') return json(res, 200, news.collectStatus());
          if (req.method === 'POST') {
            // Manual refresh only; the UI polls the status instead of holding the request open.
            news.collect().catch((error) => console.error('News collection failed:', error));
            return json(res, 202, news.collectStatus());
          }
        }
        if (path === '/api/news/sources') {
          if (req.method === 'GET')
            return json(res, 200, {
              sources: news.sources(),
              suggestions: news.suggestions(),
              settings: news.settings(),
            });
          if (req.method === 'POST')
            return json(res, 201, news.addSource((await readJson(req)) as any));
        }
        if (req.method === 'POST' && path === '/api/news/sources/detect') {
          const body = await readJson(req);
          return json(res, 200, await news.detectSources(body.input as string));
        }
        const newsSource = path.match(/^\/api\/news\/sources\/([^/]+)$/);
        if (newsSource) {
          const id = decodeURIComponent(newsSource[1]);
          if (req.method === 'PATCH') {
            const source = news.patchSource(id, (await readJson(req)) as any);
            return json(res, source ? 200 : 404, source ?? { error: 'Source not found' });
          }
          if (req.method === 'DELETE') {
            const ok = news.removeSource(id);
            return json(res, ok ? 200 : 404, ok ? { ok } : { error: 'Source not found' });
          }
        }
        const suggestion = path.match(/^\/api\/news\/suggestions\/([^/]+)\/decision$/);
        if (req.method === 'POST' && suggestion) {
          const id = decodeURIComponent(suggestion[1]);
          if (!news.store.suggestionRow(id))
            return json(res, 404, { error: 'Suggestion not found' });
          const body = await readJson(req);
          return json(res, 200, { source: news.decideSuggestion(id, body.accept as boolean) });
        }
        if (req.method === 'PUT' && path === '/api/news/settings')
          return json(res, 200, news.setSettings((await readJson(req)) as any));
        const newsItem = path.match(
          /^\/api\/news\/items\/([^/]+)\/(state|feedback|zotero|project)$/,
        );
        if (req.method === 'POST' && newsItem) {
          const id = decodeURIComponent(newsItem[1]);
          const current = news.item(id);
          if (!current) return json(res, 404, { error: 'News item not found' });
          const body = await readJson(req);
          if (newsItem[2] === 'state')
            return json(
              res,
              200,
              news.setState(id, body.state as any, (body.reason ?? null) as any),
            );
          if (newsItem[2] === 'feedback')
            return json(res, 200, news.feedback(id, body.action as any));
          if (newsItem[2] === 'project') {
            const item = news.linkProject(id, body.projectId as string);
            assistant.retrieval.refresh();
            return json(res, 200, item);
          }
          for (const key of Object.keys(body))
            if (!['collectionId', 'projectId', 'attachPdf'].includes(key))
              throw new Error(`Unknown field: ${key}`);
          const input = {
            collectionId: body.collectionId ?? null,
            projectId: body.projectId ?? null,
            attachPdf: body.attachPdf ?? false,
          };
          if (input.collectionId !== null && typeof input.collectionId !== 'string')
            throw new Error('collectionId must be a string or null');
          if (input.projectId !== null && typeof input.projectId !== 'string')
            throw new Error('projectId must be a string or null');
          if (typeof input.attachPdf !== 'boolean') throw new Error('attachPdf must be a boolean');
          if (input.projectId && !projects.detail(input.projectId))
            return json(res, 404, { error: 'Project not found' });
          let added;
          try {
            added = await newsZotero.add(current, input as any);
          } catch (error) {
            return json(res, 502, {
              error: error instanceof Error ? error.message : 'Adding to Zotero failed',
            });
          }
          const item = news.markAdded(id, added.paperId)!;
          assistant.retrieval.refresh();
          return json(res, 200, { ...added, item });
        }
        return json(res, 404, { error: 'News endpoint not found' });
      }
      if (req.method === 'GET' && path === '/api/library')
        return json(res, 200, database.library());
      if (path === '/api/projects') {
        if (req.method === 'GET') return json(res, 200, projects.list());
        if (req.method === 'POST') return json(res, 201, projects.create(await readJson(req)));
      }
      const projectRoute = path.match(
        /^\/api\/projects\/([^/]+)(?:\/(notes|assets|bibtex)(?:\/([^/]+))?)?$/,
      );
      if (projectRoute) {
        const id = decodeURIComponent(projectRoute[1]);
        const section = projectRoute[2];
        const child = projectRoute[3] && decodeURIComponent(projectRoute[3]);
        const detail = projects.detail(id);
        if (!detail) return json(res, 404, { error: 'Project not found' });
        if (!section && req.method === 'GET') return json(res, 200, detail);
        if (!section && req.method === 'PATCH')
          return json(res, 200, projects.patch(id, await readJson(req)));
        if (section === 'notes') {
          if (!child && req.method === 'POST')
            return json(res, 201, projects.createNote(id, await readJson(req, 6 * 1024 * 1024)));
          if (child && req.method === 'PATCH') {
            const note = projects.patchNote(id, child, await readJson(req, 6 * 1024 * 1024));
            return json(res, note ? 200 : 404, note ?? { error: 'Note not found' });
          }
        }
        if (section === 'assets') {
          if (!child && req.method === 'POST')
            return json(
              res,
              201,
              projects.addAsset(id, decodeFigure(await readJson(req, 12 * 1024 * 1024))),
            );
          if (child && req.method === 'GET') {
            const asset = projects.asset(id, child);
            if (!asset) return json(res, 404, { error: 'Figure not found' });
            res.writeHead(200, {
              'Content-Type': asset.contentType,
              'Content-Length': asset.size,
              'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
              'Cache-Control': 'private, no-store',
            });
            res.end(asset.data);
            return;
          }
        }
        if (section === 'bibtex' && !child && req.method === 'GET') {
          if (!detail.project.paperIds.length)
            return json(res, 400, {
              error: 'Link papers to this project before exporting a bibliography.',
            });
          try {
            const bib = await bibliography.export(database.db, detail.project.paperIds);
            const filename =
              (detail.project.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') ||
                'references') + '.bib';
            res.writeHead(200, {
              'Content-Type': 'application/x-bibtex; charset=utf-8',
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Cache-Control': 'no-store',
            });
            res.end(bib);
            return;
          } catch (error) {
            return json(res, 502, {
              error: error instanceof Error ? error.message : 'Bibliography export failed',
            });
          }
        }
        return json(res, 405, { error: 'Unsupported project operation' });
      }
      if (req.method === 'POST' && path === '/api/tags')
        return json(res, 201, database.createTag(await readJson(req)));
      const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
      if (req.method === 'PATCH' && tagMatch) {
        const tag = database.patchTag(decodeURIComponent(tagMatch[1]), await readJson(req));
        return json(res, tag ? 200 : 404, tag ?? { error: 'Tag not found' });
      }
      if (req.method === 'POST' && path === '/api/sync') {
        try {
          await syncFromZotero();
        } catch {
          /* Return the sync error below. */
        }
        return json(
          res,
          sync.error ? 502 : 200,
          sync.error ? { ...sync, error: sync.error } : sync,
        );
      }
      const paperMatch = path.match(/^\/api\/papers\/([^/]+)$/);
      if (req.method === 'PATCH' && paperMatch) {
        const paper = database.patchPaper(decodeURIComponent(paperMatch[1]), await readJson(req));
        return json(res, paper ? 200 : 404, paper ?? { error: 'Paper not found' });
      }
      const annotations = path.match(/^\/api\/papers\/([^/]+)\/annotations$/);
      if (annotations) {
        const id = decodeURIComponent(annotations[1]);
        if (!database.paper(id)) return json(res, 404, { error: 'Paper not found' });
        if (req.method === 'GET') return json(res, 200, database.annotations(id));
        if (req.method === 'POST')
          return json(res, 201, database.addAnnotation(id, await readJson(req)));
      }
      const annotation = path.match(/^\/api\/annotations\/([^/]+)$/);
      if (req.method === 'DELETE' && annotation) {
        const ok = database.deleteAnnotation(decodeURIComponent(annotation[1]));
        return json(res, ok ? 200 : 404, ok ? { ok } : { error: 'Annotation not found' });
      }
      const attachmentState = path.match(
        /^\/api\/attachments\/([^/]+)\/(availability|visibility)$/,
      );
      if (attachmentState) {
        const id = decodeURIComponent(attachmentState[1]);
        const record = database.attachment(id);
        if (!record) return json(res, 404, { error: 'Attachment not found' });
        if (req.method === 'GET' && attachmentState[2] === 'availability')
          return json(res, 200, await attachmentAvailability(zotero, record));
        if (req.method === 'POST' && attachmentState[2] === 'visibility') {
          const { hidden } = await readJson(req);
          if (typeof hidden !== 'boolean')
            return json(res, 400, { error: 'hidden must be a boolean' });
          return json(res, 200, await setAttachmentVisibility(database, zotero, id, hidden));
        }
      }
      const attachment = path.match(/^\/api\/attachments\/([^/]+)\/file$/);
      if (req.method === 'GET' && attachment) {
        const record = database.attachment(decodeURIComponent(attachment[1]));
        if (!record || record.content_type !== 'application/pdf')
          return json(res, 404, { error: 'PDF attachment not found. Sync Zotero and try again.' });
        const requestedPaper = new URL(req.url!, 'http://localhost').searchParams.get('paperId');
        if (requestedPaper && requestedPaper !== record.paper_id)
          return json(res, 409, {
            error: 'This PDF does not belong to the selected paper. Refresh Atlas and try again.',
          });
        let filename: string;
        try {
          filename = await zotero.attachmentPath(record);
        } catch (e) {
          return json(res, 502, {
            error: e instanceof Error ? e.message : 'Cannot open attachment',
          });
        }
        let handle;
        try {
          handle = await open(filename, 'r');
        } catch {
          return json(res, 404, {
            error: 'This PDF is not downloaded locally. Open or download it in Zotero first.',
          });
        }
        let info;
        try {
          info = await handle.stat();
          const signature = Buffer.alloc(1024);
          await handle.read(signature, 0, 1024, 0);
          if (!info.isFile() || !signature.includes(Buffer.from('%PDF-'))) {
            await handle.close();
            return json(res, 415, { error: 'This attachment is not a valid PDF' });
          }
        } catch (e) {
          await handle.close();
          throw e;
        }
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': info.size,
          'Content-Disposition': `inline; filename="${record.zotero_key}.pdf"; filename*=UTF-8''${encodeURIComponent(record.filename || `${record.zotero_key}.pdf`).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))}`,
          'Cache-Control': 'private, no-store',
        });
        const stream = handle.createReadStream({ start: 0 });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      return json(res, 404, { error: 'API endpoint not found' });
    }
    if (vite) {
      vite.middlewares(req, res);
      return;
    }
    const dist = join(root, 'dist');
    let file = resolve(dist, '.' + decodeURIComponent(path));
    if (!file.startsWith(dist + sep) && file !== dist)
      return json(res, 403, { error: 'Invalid path' });
    try {
      if (!(await stat(file)).isFile()) file = join(dist, 'index.html');
    } catch {
      // Missing assets (e.g. after a rebuild) are real 404s; only app routes fall back.
      if (extname(file)) return json(res, 404, { error: 'File not found' });
      file = join(dist, 'index.html');
    }
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    };
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    // Read before writing headers so a missing build gets a useful error.
    res.end(await readFile(file));
  } catch (e) {
    if (!res.headersSent)
      json(res, 400, { error: e instanceof Error ? e.message : 'Request failed' });
    else res.destroy();
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Atlas is running at http://127.0.0.1:${port}\nYour library is stored in ${dataDirectory}`,
  ),
);
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE')
    exitWith(
      `Port ${port} is already in use. Stop the other process (another Atlas?) or set ATLAS_PORT to a free port.`,
    );
  exitWith(e.message);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void vite?.close();
    void assistantRpc.close();
    database.close();
    process.exit(0);
  });
