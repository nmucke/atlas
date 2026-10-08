# Atlas

[![CI](https://github.com/nmucke/atlas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nmucke/atlas/actions/workflows/ci.yml)
[![Dependency audit](https://github.com/nmucke/atlas/actions/workflows/dependency-audit.yml/badge.svg?branch=main)](https://github.com/nmucke/atlas/actions/workflows/dependency-audit.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)](https://sqlite.org/)
[![Zotero](https://img.shields.io/badge/Zotero-CC2936?logo=zotero&logoColor=white)](https://www.zotero.org/)
[![MCP](https://img.shields.io/badge/MCP-local_server-526B50)](docs/assistant-setup.md)
[![Local-first](https://img.shields.io/badge/storage-local--first-526B50)](#local-data-and-privacy)

Atlas is a local-first academic research library and project workspace under active development. It connects to Zotero for paper metadata and PDF access, while keeping your reading workflow and notes in a local SQLite database. It runs on your computer; it does not require a cloud account or API key.

**Topics:** `academic-research` · `reference-management` · `local-first` · `zotero` · `better-bibtex` · `bibtex` · `mcp` · `rag` · `research-notes` · `latex` · `pdf` · `sqlite` · `typescript` · `react` · `vite`

## Requirements

- Node.js 24 or newer
- npm
- Zotero desktop, when syncing your library or opening PDFs

## Get started

```sh
npm install
npm run dev
```

Open [http://localhost:3210](http://localhost:3210). In Zotero, enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. Atlas talks to Zotero's local API at `127.0.0.1:23119/api`.

For a production build, run:

```sh
npm run build
npm start
```

The test suite is available with `npm test`.

## What Atlas does today

Browse a Zotero library in inbox, reading, and read views; star or archive papers; search and filter by collection or tag; and keep a manual summary, notes, and page-linked notes for PDF passages. Atlas syncs bibliographic metadata, tags, collections, and attachment details from Zotero. Your Atlas tags, tag descriptions, summary, notes, reading status, starred state, and archive state remain local when Zotero metadata syncs.

Page-linked PDF notes are stored in Atlas. They are not graphical annotations drawn onto the PDF. Summaries are written by you; Atlas does not generate them automatically. Projects are available as a local research workspace, and News collects new work from sources you choose.

## Organizing your library

Expand **Library** in the sidebar to switch reading views or open the **Collections** page. Collections come from Zotero; select a collection to browse its papers.

The **Tags** section is your local tag vocabulary. **All tags** lists Atlas tags only. The **method**, **data**, **domain**, **model**, and **task** pages group tags by name prefix: for example, `method/particle-filter` appears under method. Unprefixed Atlas tags appear in All tags. Create tags from these pages or add them directly in a paper's **Tags** section.

**Zotero tags** is a separate page and a separate section on each paper. Tags imported from Zotero stay there regardless of their name; they are never automatically promoted into your Atlas categories. You can use the same name independently in both systems. Edit Zotero tag assignments in Zotero and sync to refresh them.

Every tag can have a short explanation of up to 280 characters. Edit and save it on the tag's page; explanations for Zotero tags are also stored only in Atlas. Removing an Atlas tag from a paper keeps its definition and explanation available for reuse. Tag counts show unarchived papers.

Existing databases upgrade automatically: imported tags remain Zotero tags, and your notes and reading state are preserved.

## Projects and research notes

Expand **Projects** for the dashboard and individual project pages. An empty **Example project** is created once when your database upgrades. Rename it or create more projects from the dashboard. Each project has a manual summary, status, Atlas tags, linked library papers, and links to a GitHub repository and an Overleaf manuscript. Save your changes with **Save project**. These links open the actual repository/manuscript in your browser; Atlas does not clone repositories or synchronize manuscript contents.

Project tags reuse your Atlas vocabulary and descriptions; Zotero tags remain separate. In **Papers**, choose references from your library and save the selection. **Export BibTeX** downloads a `.bib` file using your running Zotero and its [Better BibTeX extension](https://retorque.re/zotero-better-bibtex/). Citation keys come from Better BibTeX. Missing items or duplicate citation keys produce an error instead of an incorrect bibliography. You can upload the downloaded file to Overleaf; this is a manual export, not an automatic Overleaf sync.

Each project has multiple notes, organized with folders, search, pins, and an archive. Write Markdown with inline mathematics (`$x^2$`) or display equations (`$$` on separate lines), and use edit, split, or preview mode. The preview renders LaTeX mathematics with KaTeX, including aligned equations and matrices; it is not a full LaTeX document compiler. Upload PNG, JPEG, GIF, or WebP figures up to 8 MiB each. Figures are stored inside the local SQLite database. Remote images and raw HTML are not rendered.

Use **Save** or **Cmd/Ctrl+S** to persist notes to SQLite. Unsaved note drafts are kept in this browser's local storage as a recovery aid when switching pages. Drafts are not part of the SQLite backup until saved; use the same browser and local address to recover them. Archive notes to hide them without deleting them; open the archive to restore them.

## News

**News** shows new papers, blog posts and releases from sources you add in **News → Sources**: paste an arXiv category such as `stat.ML`, a blog or journal URL, a GitHub repository, an OpenAlex author or work, or plain keywords into **Add a source**, and Atlas detects what it is. Remove a source with one click. Atlas collects only when you press **Refresh** or ask your assistant to run the `atlas-news-scan` workflow; nothing runs on a schedule. Items are ranked by a local relevance score, and the assistant can add a 1–5 score with a "why this matters" note citing your library. Save or dismiss items, or use **Add to Zotero** to create the item in a chosen collection, put it in your Inbox, link it to a project and optionally attach its PDF. OpenAlex sources need a free API key, set in News → Sources. See [News design](docs/news-design.md).

## AI research assistant

The **Assistant** page holds a saved research profile, retrieval-index controls, and a review queue. Connect Claude Desktop or another local MCP host to use eight workflows: profile and tag setup, paper reviews, reading recommendations, project references, research notes, Zotero PDF and duplicate maintenance, News scans, and News source suggestions. AI-authored reviews remain separate from human summaries. Paper reviews include a 1–5 reading score and brief rationale; **Library → Recommendations** shows the latest scored reviews and suggested project fits. Accepting a project suggestion links the paper to that project. Reviews keep internal evidence IDs out of the prose, with sources in the expandable Evidence section. Proposed tags prefer the existing vocabulary, require descriptions for new tags, and need approval before assignment; approved project notes retain AI attribution. Recommendations appear in Inbox with Essential, Recommended, or Optional strength, and project recommendations can be approved to link existing papers.

Keep Atlas running with `npm start`, then run `./scripts/register-mcp.sh` to register Atlas with ChatGPT Desktop/Codex, Claude Desktop, and Claude Code in one step and create a private research-assistant workspace outside this repository, with its own `AGENTS.md`, skills, and connection configuration. Restart the desktop MCP connection after setup; no manual server entry is needed. See [connection setup](docs/assistant-setup.md) and [research workflows](docs/assistant-workflows.md). ChatGPT Desktop and Claude Desktop launch a local bridge that authenticates to the running Atlas server. No tunnel or public endpoint is needed; ChatGPT web does not use the desktop configuration.

Retrieval is local SQLite full-text search over metadata, downloaded PDF text, project context, and notes. Each submitted artifact carries retrieved evidence and author/model attribution. No hosted embedding service or automatic model call runs inside Atlas. Using a cloud assistant sends the retrieved excerpts to that provider. New-paper discovery searches Crossref metadata; candidate papers stay separate from Zotero until you add them there.

## Local data and privacy

Atlas uses a local Node.js HTTP server, a React/Vite interface, and SQLite (`node:sqlite`). By default, its database is stored outside the repository:

- macOS: `~/Library/Application Support/Atlas/atlas.sqlite`
- Linux: `$XDG_DATA_HOME/atlas/atlas.sqlite`, or `~/.local/share/atlas/atlas.sqlite` when `XDG_DATA_HOME` is unset
- Windows: `%LOCALAPPDATA%\Atlas\atlas.sqlite`

Set `ATLAS_DATA_DIR` to use another data directory, or `ATLAS_PORT` to change the server port. Keep the data directory private: it contains your Atlas notes, project figures, project links, and library state. To back it up, stop Atlas and copy the directory. PDF files remain managed by Zotero rather than copied into Atlas.

Zotero must be running for sync and PDF access. Previously cached metadata remains available while Zotero is offline. Review `git status` before committing: the repository ignores local databases, PDFs, and environment files, but you should confirm no private files are staged.

## Current limitations

Atlas is an early, single-computer tool. Zotero provides the source library and PDF storage; Atlas does not replace Zotero or provide cross-device sync. Only source fields are refreshed from Zotero, while Atlas-managed reading state and notes stay local. Features may change as development continues.

## Design and development

The [architecture](docs/architecture.md) explains data ownership, SQLite schema, privacy, Projects, and News. The [Zotero integration notes](docs/zotero-integration.md) document API behavior and compatibility.

Run `npm run typecheck`, `npm test`, and `npm run build` before sharing changes. `npm run format` formats the source; `npm run format:check` checks formatting. Dependencies are locked in `package-lock.json`; use `npm ci` for repeatable installs.

## Continuous integration

- **CI** runs on pushes and pull requests using Node.js 24 on Linux, macOS, and Windows. It checks formatting (including assistant instructions and skills), runs the storage/retrieval/MCP test suite, typechecks, and builds the production app. Tests use temporary fixture databases and mocked integrations; Zotero, an AI account, and your private library are not needed.
- **Dependency audit** checks the lockfile for high and critical vulnerabilities in production and development dependencies whenever dependency files change, every Monday, and on manual runs.
- **Dependabot** proposes weekly updates for npm dependencies and pinned GitHub Actions. Minor and patch npm updates are grouped; major updates remain separate for review.

Workflows have read-only repository permissions and do not deploy, publish packages, or upload local research data. Status badges reflect GitHub runs once these files are pushed to the repository.
