# Zotero integration design

Researched 28 September 2026. This document records integration constraints and design recommendations. The implementation status below reflects the initial v1 source; recommendations are not claims of completed functionality.

## Implemented v1 and remaining work

The backend uses Node's SQLite API with WAL, foreign keys, and a schema version table. Manual synchronization discovers the personal and group libraries, retrieves complete source snapshots, and commits them together in one transaction. It preserves Atlas summaries, notes, reading state, favorites, and archive state. Source records and annotations survive source disappearance. Imported tags and collection memberships are stored in source JSON, while collection metadata and PDF attachment relationships have dedicated tables.

The Zotero adapter requests API v3, uses a fixed loopback endpoint, rejects redirects, applies request timeouts, limits individual response bodies to 128 MB, validates basic snapshot structure, and follows restricted pagination links. Source IDs incorporate the Zotero server ID when available. Older clients use a `local-default` source partition; changing profiles on those clients is not automatically detected.

Atlas's PDF route resolves a known attachment through Zotero, verifies a local file URL and PDF signature, and streams the original PDF. It does not cache PDF bytes or modify Zotero files. Zotero must remain running when opening a PDF. The route currently streams the whole file and does not implement byte ranges.

The annotation API stores **page-linked text notes and manually entered quotes** against an attachment. Page numbers are one-based. These records are local to Atlas. Graphical selection highlights, PDF-coordinate geometry, document fingerprints, automatic page validation, imported Zotero annotation display, and annotation writeback are future work.

Current scope excludes automatic/background sync, generated summaries, and an FTS index. Schema version 2 adds Atlas-owned tag definitions, descriptions, and paper assignments with a transactional upgrade from version 1. Zotero tag membership remains in source JSON; source tags are never reclassified as Atlas tags. Descriptions for both origins are stored locally and survive sync. Zotero trash and absent source items currently share the `sourceMissing` presentation flag; the source payload retains the original `deleted` field. The detailed recommendations and test checklist below describe the intended design, including work beyond this first implementation.

## Connection and compatibility

Zotero must be running. Enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. Read requests require no API key. The desktop API is `http://localhost:23119/api/`; use `users/0` for the current personal library. A disabled API responds with 403. Zotero 10 adds instance identification through `Zotero-Server-ID`, local version counters, and authenticated writes. Earlier releases report synced versions that do not change for unsynced edits. Atlas therefore must not depend on version-only incremental sync for older clients. [Official local API documentation](https://www.zotero.org/support/dev/web_api/v3/local_api)

Keep v1 integration read-only even when a newer Zotero supports writes. Zotero owns bibliography, imported tags, collections, and original PDFs; Atlas owns its custom tags, all local tag descriptions, reading status, favorites, summaries, personal notes, and its annotations. This avoids synchronization conflicts and allows an offline Atlas library to remain useful after Zotero closes.

Send `Zotero-API-Version: 3` and `Zotero-Allowed-Request: true` from the backend. Zotero 10 restricts Host values to loopback names and addresses, and browser-like requests require an allowed-request header. [Zotero 10 developer notes](https://www.zotero.org/support/dev/zotero_10_for_developers)

## Endpoints

Paths below are relative to `http://localhost:23119/api`:

| Purpose                                 | GET path                                           |
| --------------------------------------- | -------------------------------------------------- |
| Check API and response headers          | `/`                                                |
| Discover local group libraries          | `/users/0/groups`                                  |
| Personal library items, including trash | `/users/0/items?format=json&includeTrashed=1`      |
| Collections                             | `/users/0/collections?format=json`                 |
| One paper's children                    | `/users/0/items/ABCD1234/children`                 |
| Local PDF location                      | `/users/0/items/PDFKEY12/file/view/url`            |
| Group items                             | `/groups/12345/items?format=json&includeTrashed=1` |

The PDF URL endpoint returns a local file URL as text; `/file` instead redirects to that file URL. The Zotero 7 implementation already provides these endpoints, group discovery, collections, and item filtering. Fetch all items rather than only `/items/top` to retain attachments, notes, and annotations. [Zotero 7 API implementation](https://raw.githubusercontent.com/zotero/zotero/7.0/chrome/content/zotero/xpcom/server/server_localAPI.js)

JSON responses contain an item key, version, library metadata, and a `data` object. Preserve the original payload alongside indexed fields so unfamiliar bibliographic types are not lost. [API v3 response format](https://www.zotero.org/support/dev/web_api/v3/changes_from_v2)

Local requests return all matching objects by default. Explicit `limit`/`start` and pagination `Link` headers remain supported. The web API's default 25-item page does not apply locally. [API basics](https://www.zotero.org/support/dev/web_api/v3/basics)

## Recommended synchronization algorithm

1. Serialize sync runs so startup, manual, and scheduled triggers cannot overlap.
2. Probe Zotero with a timeout. Record instance identity when supplied. A changed identity starts a distinct source partition; never attach another person's library to previous personal notes just because keys match. On older clients, retain a configured source identity and document that changing Zotero profiles requires a new Atlas source.
3. Fetch the complete item snapshot and collection snapshot per configured library. For typical personal libraries, one local item request is simpler and safer than mutable offset pagination. Bound response size and duration; fail visibly rather than silently truncate.
4. Validate response shape and keys before changing the database. Treat a malformed or partial response as a failed run.
5. In one transaction, upsert source metadata and replace imported tag and collection memberships. Never replace Atlas-owned fields. Classify attachment, note, and annotation items separately from bibliographic records. Link children using `parentItem`.
6. Mark absent source records as unavailable only after a complete successful snapshot. Retain local notes and annotations. Trashed items and missing items must remain distinguishable. Do not infer deletion from a failed page, unavailable group, or connection error.
7. Record counts, completion time, and error details. Keep the last successful library fully usable if Zotero is unavailable.

For very large libraries, capture all keys first and fetch batches by explicit `itemKey`, then compare a second key inventory. Reject or retry if it changes. This reduces false removals caused by changing offset pages. A future incremental mode can use local versions only after the server advertises the newer instance-aware version contract; still retain periodic full reconciliation.

Use `(source_id, library_type, library_id, item_key)` as the source identity, with an independent Atlas primary key. Do not deduplicate solely on DOI: editions, preprints, and intentional duplicates must remain separate. SQLite foreign keys, transactions, WAL mode, schema migrations, and an FTS index are sufficient for v1. Keep a source JSON column for lossless compatibility and normalized tables for frequently filtered tags and collections.

## Reading and annotations

Use a same-origin backend route such as `/api/attachments/:id/file`. It resolves a known imported attachment through Zotero, converts the returned file URL with the platform URL utility, verifies a regular PDF file, and streams it. Never expose a generic path-reading route or accept a client-supplied filesystem path. Support byte ranges for efficient viewing. A missing local attachment needs an explicit message directing the user to download it in Zotero.

PDF.js can render individual pages in an application-owned reader; its viewport handles scaling and rotation. [Official PDF.js examples](https://mozilla.github.io/pdf.js/examples/) Bundle the worker and fonts locally so normal reading does not depend on a CDN.

Recommended Atlas annotation records contain attachment identity, document fingerprint, zero-based page index, page label, annotation type, comment, selected text, color, and rectangle geometry in PDF coordinates. Store multiple rectangles for multiline highlights. Convert using the PDF viewport rather than saving screen pixels. Keep imported Zotero annotations separate and read-only; clearly identify which application owns an annotation. Do not claim that Atlas annotations synchronize back to Zotero in v1.

Persist the last page and zoom per attachment. A changed document fingerprint should trigger review of existing annotations instead of silently placing them on different content. Always offer an **Open in Zotero** escape hatch. A simple initial reader can support durable page-linked notes before implementing selection highlights, provided the UI describes that capability accurately.

## Local privacy boundary

Bind Atlas to loopback, validate the Host header, enforce same-origin browser requests, and require an application-specific header on mutation endpoints. Do not enable wildcard CORS. Backend Zotero access should use a fixed loopback origin, bounded requests, and no automatic redirects to arbitrary hosts. Serve imported note HTML as text or sanitize it. Open only allowed external URL schemes.

Default data belongs in the user's OS application-data directory, outside the checkout. Exclude SQLite files and sidecars, PDFs, attachment caches, logs, exports, secrets, and local settings from Git. Do not seed source control with the user's real library. Keep demo data explicit and separate. Backups should use SQLite's supported backup mechanism or a cleanly closed database, not a blind copy during writes.

## Required integration tests

- Unsynced edits update Atlas even when the Zotero item version is unchanged.
- A failed or malformed snapshot preserves both the previous library and Atlas-owned notes.
- A successful source removal preserves personal work and distinguishes missing from trash.
- Repeated synchronization is idempotent; restoring an item clears its missing state.
- Personal and group items with equal keys do not collide.
- PDF requests cannot read an arbitrary client-selected path; missing files and invalid ranges are handled.
- Foreign-origin mutations and invalid Host headers are rejected.
