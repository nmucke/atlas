# Atlas v1 architecture

## Product boundary

Atlas is a single-user application running on the same computer as Zotero. The app provides a paper library and project workspace. News remains a future section.

The Library offers Inbox (newly imported items), Reading, Read, Starred, and Archived views. All papers includes unarchived items; archive is a separate view. Library is a collapsible navigation group. Its Collections page lists Zotero collections instead of listing each collection in the sidebar. Atlas tags, Zotero tags, and search refine paper views. A paper has one reading status, an independent star, and an independent archive flag. This avoids confusing “starred” with a stage in the reading process.

## Runtime and distribution

React and TypeScript provide the interface. A small Node.js 24 HTTP service binds only to `127.0.0.1` and serves both the interface and API on the same port. Vite handles development and produces the production interface. SQLite uses Node's bundled `node:sqlite`; no database server, Python runtime, cloud account, or API key is needed. Dependencies and PDF.js workers are bundled locally; the application does not fetch fonts or scripts from a CDN.

This browser-based local application is the first distribution format. It offers an integrated reader without the installer/signing overhead of a native shell. A desktop wrapper can reuse the same interface and backend later. It is not a remotely hosted or multi-user application.

## Data ownership and schema

| Table               | Purpose and owner                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `libraries`         | Zotero library identity, route prefix, optional desktop server ID                        |
| `source_items`      | Original Zotero metadata JSON, composite identity, source presence, last metadata change |
| `paper_state`       | Atlas reading status, star, archive, summary, notes, first import time                   |
| `collections`       | Current Zotero collection names and hierarchy                                            |
| `attachments`       | Current attachment-to-paper relationships                                                |
| `annotations`       | Atlas page-linked text/quote notes keyed to paper and attachment                         |
| `settings`          | Successful sync timestamp                                                                |
| `tag_definitions`   | Tag name, origin, and Atlas-owned short explanation                                      |
| `paper_tags`        | Atlas tag-to-paper assignments                                                           |
| `projects`          | Atlas project summaries, status, GitHub and Overleaf links                               |
| `project_tags`      | Atlas-origin tag assignments shared with the library vocabulary                          |
| `project_papers`    | Many-to-many project references to persistent paper state                                |
| `project_notes`     | Markdown notes with folders, pinning, archive, and timestamps                            |
| `project_assets`    | Project-scoped raster figures stored as SQLite BLOBs                                     |
| `schema_migrations` | Database schema versions; v2 adds tags, v3 adds projects                                 |

Source identity combines the desktop server ID, library type/ID, and Zotero key. For older Zotero clients without server IDs, a stable `local-default` namespace is used. Those clients cannot reliably distinguish switching Zotero profiles; do not reuse one Atlas data directory across such profiles. Upgrading to a server-ID-aware version partitions new source records to avoid incorrectly attaching old annotations; automatic identity migration is future work.

Raw source metadata preserves fields Atlas does not yet display. Local state lives separately and never gets overwritten by sync. The schema uses foreign keys, unique source identities, indexes for annotations and attachments, WAL journaling, and atomic imports. Missing or trashed items remain available with their Atlas work and an unavailable-source indication.

For v1 the interface loads cached library metadata and filters it locally. For larger libraries, add paginated queries, normalized Zotero membership indexes, and SQLite FTS5 before attempting full-text PDF ingestion. Avoid a vector database until there is a concrete retrieval feature.

## Atlas and Zotero tags

Tag identity includes its origin and name. `atlas:method/flow` and `zotero:method/flow` are independent definitions even though their names match. Zotero tag membership stays in source metadata; Atlas membership uses its own relational table. `Paper.tags` is Atlas-owned and `Paper.zoteroTags` is source-owned. Filters carry both origin and name to prevent accidental cross-matching.

The sidebar has All tags, method, data, domain, model, task, and Zotero tags pages. All tags excludes Zotero tags. The five categories derive from Atlas name prefixes, not from the existence of a matching name in Zotero. Names without a recognized prefix still appear in All tags. This keeps classification simple and makes names portable without maintaining a second category assignment.

Descriptions are Atlas-owned for both origins, with a 280-character limit. Definition rows outlive assignments so explanations remain available if a tag is removed and later reused. Tag counts include unarchived papers, matching the default filtered paper view. The version 2 migration backfills Zotero definitions from cached source metadata without assigning any Atlas tags or altering notes, statuses, or annotations. Sync refreshes source definitions while preserving local descriptions and Atlas assignments.

## Zotero synchronization

The backend reads the documented desktop API and does not access Zotero's SQLite database directly. Sync reads personal and group libraries, their collections, and all item types. Bibliographic items and standalone PDF attachments appear as papers. Source notes and annotations are retained in raw metadata but are not shown as Atlas annotations.

Each sync fetches and validates a full snapshot before entering one SQLite transaction. This catches unsynced edits on older Zotero clients whose version numbers do not advance locally. Pagination is followed when present, and `Total-Results` is checked when supplied. A failed fetch or invalid snapshot leaves the existing database untouched. Reads across multiple endpoints are not a single Zotero transaction: a concurrent Zotero edit can still cause a temporary cross-endpoint inconsistency; the next sync reconciles it.

Sync is manual in v1. Future periodic sync should reuse this path, expose last-success/error state, and use a single-flight queue. See [Zotero integration](zotero-integration.md) for source references and compatibility details.

## Reading and annotations

PDF.js renders an imported attachment inside Atlas. The backend resolves its known attachment key using Zotero's local file URL endpoint, validates the result as a local PDF, and streams the file. There is no browser-supplied filesystem path endpoint. Zotero continues to own PDF storage; Atlas makes no duplicate PDF copy. Zotero must be running to resolve/open the file.

The first reader supports page navigation, zoom, and page-linked quotes and notes. These persist in SQLite and remain distinct from general paper notes. They are not geometric highlights, are not written into PDFs, and are not synchronized to Zotero. A replaced PDF may invalidate a saved page reference. A later annotation model should record attachment hashes, page dimensions and normalized selection rectangles, with explicit handling of changed files.

## Project workspace

Projects have a dashboard and per-project pages. Migration v3 creates the project tables and seeds one blank Example project once. The migration is atomic and leaves source items and paper state unchanged. Paper relationships reference persistent Atlas records, so missing Zotero sources do not destroy project work. Tags use existing Atlas-origin definitions; Zotero tags cannot be silently assigned to projects.

Notes are independent records with editable Markdown bodies, folders, pinning, archive/restore, and modification timestamps. KaTeX handles inline and display mathematics locally. ReactMarkdown disables raw HTML; image URLs must refer to an asset belonging to the current project. Uploaded raster figures are bounded to 8 MiB and checked against MIME signatures, then stored in SQLite. SVG and arbitrary filesystem paths are not accepted. Storing figures as BLOBs keeps notes and figures in one transactional backup, at the cost of database growth. Orphan-asset cleanup is future work; removing a Markdown image reference does not delete its stored bytes.

Note edits remain explicit-save. Browser-local drafts provide recovery across navigation, but only saved notes are in the database backup. Project overview changes use a navigation warning. GitHub and Overleaf links are validated HTTPS repository/manuscript links, opened on user action; there is no authentication token storage, repository clone, or remote content synchronization.

Bibliography export uses Better BibTeX's loopback JSON-RPC API. Atlas verifies Zotero server identity, resolves source items by canonical personal/group item URI to Better BibTeX's internal library IDs, and calls the Better BibTeX translator per library with existing citation keys. Search excludes attachment, note, and annotation item types because these are not bibliographic entries. Ambiguous identities, missing references, and duplicate citation keys fail visibly. Export does not regenerate citation keys or mutate Zotero. Users download a `.bib` file and upload it to Overleaf themselves. See the [Better BibTeX JSON-RPC documentation](https://retorque.re/zotero-better-bibtex/exporting/json-rpc/).

## Assistant and retrieval

Migration v4 adds append-only `ai_records` with kind, target, attribution, evidence snapshots, approval status, recommendation strength, and optional external candidate metadata. Project notes gain `author_type` (human by default) and `ai_record_id`. Approval transactions create Atlas tag definitions/assignments, link existing references, or create a new AI-authored note; they never overwrite paper summaries or source Zotero fields. User-approved profile text is kept in settings.

The desktop host launches a local MCP stdio bridge, which reads the private assistant credential and forwards allowlisted MCP operations to the running Atlas server over authenticated loopback HTTP. The bridge does not open SQLite; the application owns retrieval and database access. The credential is rejected by ordinary UI routes. Its tools expose bounded retrieval and attributed submissions, but no approval, raw SQL, arbitrary filesystem, or human-content mutation. The localhost web UI handles approval. Tool schemas, storage validation, foreign keys, and source identity checks complement instructions; instructions are not the sole enforcement layer.

Migration v5 adds `rag_documents`, overlapping `rag_chunks`, an FTS5/BM25 index, `assistant_runs`, and per-run evidence snapshots. Metadata refreshes before retrieval; PDFs index explicitly in bounded worker threads. Source hashes invalidate changed citations before submission. Project scope includes linked papers and active notes, with AI authorship preserved. Full-text PDF indexing has no OCR and cannot guarantee faithful equations or figures. This is lexical RAG; semantic embeddings and retrieval evaluation over a larger corpus are future work.

External paper discovery uses a Crossref metadata tool, which returns canonical candidates and citable evidence. Assistants cannot invent candidate metadata during submission. Local candidates, source papers, recommendations, and citation evidence remain distinct. Assistant instructions and six workflow skills live in `assistant-workspace/` and are linked into the private research workspace by the setup script; they do not become developer-root instructions. See [assistant setup](assistant-setup.md) for transport choices and privacy boundaries.

## Privacy and backup

The default database lives in the operating system's user application-data directory, outside the repository. New directories use mode 0700 and database files are created under a 0077 umask where supported. `.gitignore` excludes databases, PDF files, environment files, build output and local data folders. Private PDFs and generated library exports should never be placed in tracked paths.

The server checks Host, Origin, and browser fetch metadata. API mutations require JSON content type. It uses no permissive CORS headers and rejects external origins. This protects the local application from ordinary cross-origin browser requests, but is not an authentication boundary against other software running under the user's account. There is no telemetry, hosted service, or automatic AI provider call. Clicking a paper's external URL intentionally opens that site.

To back up, stop Atlas and copy its data directory; back up Zotero's PDF storage separately. Schema upgrades run transactionally at startup; dedicated backup and restore tooling is future work. Do not delete missing source records automatically because that would destroy research notes.

## Extension path

News should ingest feed candidates into separate tables, with an explicit “add to library” action; discovery results should not silently enter the inbox. AI artifacts already retain model attribution, source hashes, timestamps, and approval decisions; future retrieval work can add semantic ranking and richer extraction.
