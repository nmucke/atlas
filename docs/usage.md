# Using Atlas

This guide covers the library, tags, projects, News and the assistant review queue in more detail than the [README](../README.md).

## Library

Browse your Zotero library in **Inbox**, **Reading**, **Read**, **Starred** and **Archived** views. Search and filter by collection or tag. For each paper you can keep a manual summary, notes, and page-linked notes for PDF passages.

Sync copies bibliographic metadata, tags, collections and attachment details from Zotero. Your Atlas tags, tag descriptions, summary, notes, reading status, star and archive state stay local and are never overwritten by a sync.

Page-linked PDF notes are stored in Atlas. They are not graphical annotations drawn onto the PDF, and they are not written back to Zotero.

The paper's **Human summary** is written by you; Atlas never generates it. AI summaries and reviews from a connected assistant are shown separately under **AI summary**.

Expand **Library** in the sidebar to switch views or open the **Collections** page. Collections come from Zotero; select one to browse its papers. **Library → Recommendations** shows the latest scored assistant reviews, highest score first, with suggested project fits.

## Tags

The **Tags** section is your local tag vocabulary.

- **All tags** lists Atlas tags only.
- The **method**, **data**, **domain**, **model** and **task** pages group tags by name prefix: `method/particle-filter` appears under method. Unprefixed tags appear only in All tags.
- Create tags from these pages, or add them in a paper's **Tags** section.

**Zotero tags** is a separate page and a separate section on each paper. Tags imported from Zotero stay there whatever their name; they are never promoted into your Atlas categories, and you can use the same name independently in both systems. Edit Zotero tag assignments in Zotero, then sync.

Every tag can have an explanation of up to 280 characters, edited on the tag's page. Explanations for Zotero tags are also stored only in Atlas. Removing an Atlas tag from a paper keeps its definition and explanation for reuse. Tag counts include unarchived papers only.

## Projects

Expand **Projects** for the dashboard and project pages. An empty **Example project** is created on first run; rename it or create more projects from the dashboard.

Each project has a manual summary, status, Atlas tags, linked library papers, and links to a GitHub repository and an Overleaf manuscript. Save changes with **Save project**. The links open the repository or manuscript in your browser; Atlas does not clone repositories or synchronize manuscript contents.

Project tags reuse your Atlas vocabulary and descriptions; Zotero tags stay separate.

### Bibliography export

In **Papers**, choose references from your library and save the selection. **Export BibTeX** downloads a `.bib` file using your running Zotero and its [Better BibTeX extension](https://retorque.re/zotero-better-bibtex/). Citation keys come from Better BibTeX. Missing items or duplicate citation keys produce an error instead of an incorrect bibliography. Upload the file to Overleaf yourself; there is no automatic Overleaf sync.

### Notes

Each project has multiple notes, organized with folders, search, pins and an archive.

- Write Markdown with inline maths (`$x^2$`) or display equations (`$$` on separate lines), in edit, split or preview mode.
- The preview renders LaTeX maths with KaTeX, including aligned equations and matrices. It is not a full LaTeX compiler.
- Upload PNG, JPEG, GIF or WebP figures up to 8 MiB each. Figures are stored in the SQLite database. Remote images and raw HTML are not rendered.
- Use **Save** or **Cmd/Ctrl+S** to save. Unsaved drafts are kept in this browser's local storage as a recovery aid; they are not in the database backup until saved, and you need the same browser and address to recover them.
- Archive notes to hide them without deleting them; open the archive to restore them.

## News

**News** shows new papers, blog posts and releases from sources you add in **News → Sources**.

- Paste an arXiv category such as `stat.ML`, a blog or journal URL, a GitHub repository, an OpenAlex author or work, or plain keywords into **Add a source**. Atlas detects what it is.
- Remove a source with one click, or disable it with its toggle.
- Atlas collects only when you press **Refresh** or ask your assistant to run the `atlas-news-scan` workflow. Nothing runs on a schedule.
- Items are ranked by a local relevance score. The assistant can add a 1–5 score with a "why this matters" note citing your library.
- Save or dismiss items, or use **Add to Zotero** to create the item in a chosen collection, put it in your Inbox, link it to a project and optionally attach its PDF. This needs Zotero's write permission (see the README).
- OpenAlex and keyword sources need a free OpenAlex API key, set in News → Sources.

See [News design](news-design.md) for sources and ranking.

## Assistant review queue

The **Assistant** page holds your saved research profile, the **Research index** (with **Rebuild index**), Zotero actions, and the review queue.

- AI reviews, proposed tags, recommendations, project notes and profile proposals are stored separately from your own work and need your approval.
- Paper reviews include a 1–5 reading score and a short rationale. Evidence appears in the expandable Evidence section, not in the prose.
- Proposed tags prefer your existing vocabulary and must describe any new tags. Approving a tag proposal creates and assigns the tags.
- Recommendations appear in Inbox with Essential, Recommended or Optional strength. Approving a project recommendation links the paper to the project.
- Approved project notes keep their AI attribution.

Retrieval is local SQLite full-text search over metadata, downloaded PDF text, project context and notes. No embedding service or automatic model call runs inside Atlas. New-paper discovery searches Crossref metadata; candidates stay separate from Zotero until you add them there. See [Assistant setup](assistant-setup.md) for retrieval limits and privacy.
