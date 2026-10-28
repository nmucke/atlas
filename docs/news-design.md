# News: design

Status: the MVP described in [Build phases](#10-build-phases) is implemented. This design record extends the "Extension path" in [architecture](architecture.md). Sections marked **Later** describe direction, not the current build.

News shows new papers, blog posts, repositories, releases and datasets that are relevant to your profile and projects, so you can triage them in a few minutes. From a paper you can add it to Zotero, put it in your Atlas Inbox and link it to a project in one action.

## Product decisions

These decisions shape the rest of the design:

1. **Nothing runs automatically.** Atlas has no timer, internal scheduler or recurring schedule for News, and the assistant workflow is never scheduled. Collection runs only when you press **Refresh** in News, or when you start the `atlas-news-scan` assistant workflow, which calls `atlas_news_collect` itself and then triages.
2. **Sources are easy to add and remove.** The Sources page is built around one **Add a source** box. It accepts whatever you have (an arXiv category such as `stat.ML`, an arXiv listing URL, a blog or journal homepage or feed URL, a GitHub repository URL, an OpenAlex author or work URL or ID, or plain keywords), detects what it is and offers one-click Add. Remove is one click with an in-page Undo, and each source has an enable toggle. Sources the assistant proposes appear as suggestions with Add / Dismiss.

## 1. Core decision: a watchlist, not the open web

Searching the open web for "anything new and relevant" is expensive and noisy, and the results can't be reproduced. Every working research-feed product (Scholar Inbox, arxiv-sanity, zotero-arxiv-daily, Semantic Scholar feeds) does the opposite: it polls a bounded set of structured sources and ranks what comes in. Atlas does the same, in three stages:

```
 Stage A: Atlas collector (deterministic, no model calls)
   on Refresh or atlas_news_collect only
   sources ──► arXiv RSS · RSS/Atom (blogs, journal ToCs, GitHub releases) · OpenAlex
           ──► normalize ─► dedupe (DOI/arXiv/OpenAlex/URL) ─► library match
           ──► pre-score (lexical + follows + freshness + source prior − negative)
           ─► news_items (state = new)
                              │ top of the queue by pre-score
                              ▼
 Stage B: agent triage over MCP (atlas-news-scan, started by you)
   judge relevance vs profile & projects ─► "why this matters" with library citations
   propose sources (atlas-news-sources) ─► submit
                              ▼
 Stage C: you, in News: Add to Zotero · Link project · Save · Dismiss · More/Less
             ─► append-only feedback ─► source priors, negative profile
```

Why this split:

- **Collection is ordinary HTTP, like Zotero sync.** It doesn't break Atlas's "no automatic model calls" rule. News also works without an agent: untriaged items are shown by pre-score and labelled as untriaged.
- **The agent sees only the top of the funnel, not the firehose.** Its cost stays flat as the source list grows, and its job is judgement and explanation, not crawling.
- **Open-ended web search has no role in collection.** The assistant can propose **new sources**, so everything still arrives through a deterministic source you added.

## 2. Sources (verified status, Oct 2026)

| Scope | Source                                                                              | Access                                          | Use                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP   | arXiv RSS (`rss.arxiv.org/rss/cat+cat`)                                             | none                                            | Category feeds. Replacement announcements are skipped so revisions are not news.                                                                                                          |
| MVP   | RSS/Atom                                                                            | none                                            | Lab and personal blogs, Substack, journal tables of contents, GitHub `releases.atom`, PMLR. Homepages are resolved by feed autodiscovery.                                                 |
| MVP   | OpenAlex author, query and `cites`                                                  | free key (required since Feb 2026), $1/day free | Follow authors, keyword queries, and new works citing a key paper, with `from_created_date`. Covers journals that aren't on arXiv. The key and a contact email are set in News → Sources. |
| Later | Semantic Scholar Recommendations (`POST /recommendations/v1/papers`)                | free key                                        | Personalised recommender: library and saved items are positive seeds, dismissed items are negative seeds. Its pool is the last ~60 days. Coverage outside CS still needs checking.        |
| Later | OpenAlex venues and topics, OPML import                                             | —                                               | Venue and topic follows; bulk feed import.                                                                                                                                                |
| Later | GitHub search                                                                       | token                                           | Topic and query watches; finding a paper's repo by its arXiv ID.                                                                                                                          |
| Later | Hugging Face daily/trending papers                                                  | none (unofficial API)                           | Trending signal and paper→code links. Replaces Papers with Code, which shut down in July 2025.                                                                                            |
| Later | OpenReview, bioRxiv/medRxiv, Europe PMC                                             | guest/none                                      | Conference season; only if relevant to your field.                                                                                                                                        |
| Later | HN Algolia, Bluesky public AppView / profile RSS                                    | none                                            | Discussion signal; following specific researchers.                                                                                                                                        |
| Skip  | X, Reddit, Google Scholar, Scholar Inbox, Litmaps/ResearchRabbit, Elicit, Undermind | —                                               | No usable API at personal scale, or paid or enterprise-only.                                                                                                                              |

Atlas does the fetching itself instead of depending on third-party MCP servers (OpenAlex, arXiv, Exa and Semantic Scholar all have one), so that it controls dedupe, state, rate limits and keys. Fetches go only to public http(s) hosts with size limits and timeouts; feed text is untrusted data.

### Suggesting sources from your library

Agent-proposed, user-added (skill `atlas-news-sources`). The assistant derives suggestions from your profile, projects, your explicit request and library evidence:

1. Authors with several library papers, weighted toward recent ones, become OpenAlex author suggestions.
2. Your most frequent venues become journal table-of-contents feed suggestions.
3. The arXiv primary categories of your preprints become category feeds.
4. Key papers your projects build on become `cites` follows ("new work citing X").
5. Topics that categories and authors miss become OpenAlex keyword queries.

Each suggestion carries a reason and appears in News → Sources until you add or dismiss it.

## 3. Ranking

Pre-score, computed deterministically by Atlas with each signal in [0, 1] (MVP):

```
pre   = 0.45·lex + 0.20·follow + 0.20·fresh + 0.15·source_prior − 0.30·neg   (clamped to [0, 1])
final = 0.6·(triage_score − 1)/4 + 0.4·pre                                    (untriaged: final = pre)
```

- **lex**: FTS5 BM25 of the title and abstract against a profile query. The query uses distinctive terms from the approved profile, Atlas tag names and descriptions, project names and summaries, and starred and read titles, normalized within the candidate batch.
- **follow**: 1 for items from an OpenAlex author or `cites` source.
- **fresh**: `exp(-age_days/7)`.
- **source_prior**: `(kept + 1)/(kept + dismissed + 2)` for the source, from your actions.
- **neg**: term overlap with items marked "less" or dismissed as not relevant.

The features are stored with each item and shown under "Why you're seeing this".

**Later:**

- **graph**: how many of your library papers it cites, `min(1, log2(1+n)/2)`. This is the strongest cheap signal, and it gives the easiest explanation: "cites 3 papers in your library".
- **s2rec**: rank in the Semantic Scholar recommendations.
- **pop**: stars velocity, early citations.
- Stories rather than individual items (a paper plus its repo plus a blog post as one card), per-source and per-topic caps, MMR diversity and labelled exploration slots.
- Local embeddings (bge-small via transformers.js, brute-force cosine), only if replaying logged features shows recall gaps for blogs and repos.

## 4. Feedback loop

| Action                          | Signal                                   |
| ------------------------------- | ---------------------------------------- |
| Add to Zotero / link to project | kept                                     |
| Save                            | kept                                     |
| Open                            | logged, implicit                         |
| Dismiss                         | dismissed, with an optional reason chip  |
| More / less like this           | `less` adds terms to the negative signal |
| Remove or disable a source      | stops collection from it, undoable       |

How feedback is used:

- Kept and dismissed counts update each source's prior.
- "Less like this" and "not relevant" dismissals feed the negative signal.
- The agent can read aggregated feedback (`atlas_news_get_feedback`) to calibrate its scores and source suggestions, but cannot change weights or sources directly.

**Later:** Semantic Scholar seeds from feedback, automatic source suggestions after repeated positive actions on one author or venue, pruning flags for low-precision sources, and an evaluation panel (precision@10, add-to-library rate, precision per source, "surfaced first").

## 5. Data model (migration v8)

These are new tables. News rows never enter `source_items` until you add them to Zotero. They are separate from `ai_records`, because that table's kind CHECK would need a rebuild.

```sql
news_sources(id, kind arxiv|rss|openalex_author|openalex_query|openalex_cites, label, value,
             enabled, created_at, last_fetched_at, last_error)
news_source_suggestions(id, run_id, kind, value, label, reason, status, created_at, decided_at)
news_items(id, kind paper|post|repo|release|dataset, title, authors_json, abstract, url, venue,
           published_at, first_seen_at, doi, arxiv_id, payload_json, pre_score, features_json,
           state new|saved|added|dismissed, dismiss_reason, paper_id)
news_identifiers(kind doi|arxiv|openalex|url, value, item_id, PRIMARY KEY(kind, value))
news_item_sources(item_id, source_id, run_id)        -- provenance: which source found it
news_triage(item_id, run_id, score, why, project_ids_json, agent_json, citations_json, created_at)
                                                     -- history kept; latest wins
news_feedback(id, item_id, action, detail_json, created_at)   -- append-only
news_runs(id, started_at, finished_at, stats_json)   -- collection runs
news_fts  -- FTS5 over title, abstract
```

The contact email and OpenAlex key are kept in the existing `settings` table; the key is never returned to the interface or the assistant.

Identity priority for dedupe:

1. Lower-cased DOI
2. arXiv ID without its version suffix (also matches the `10.48550/arXiv.` DOI form)
3. OpenAlex ID
4. Normalized URL

Every candidate is checked against `source_items` (DOI, arXiv ID in `url`/`extra`/`archiveID`) at collection time, when listed, and again when you click Add. Matching items show "In your library" and are left out of the assistant's queue. Removing a source keeps the items it found.

**Later:** `news_stories` and `news_links` (paper ↔ repo ↔ post), Semantic Scholar and GitHub identifiers, digests, and showing a new arXiv version of a library paper as an update.

## 6. MCP tools

These follow the existing conventions: every tool takes `runId`, network tools are marked open-world, fetched text is untrusted evidence, and **no tool adds or removes sources, approves anything, or writes to Zotero**.

| Tool                                                                                                  | Purpose                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `atlas_news_collect {runId}`                                                                          | Collect from enabled sources now and wait for the result. Write, open-world. Used by the user-started scan workflow. |
| `atlas_news_queue {runId, limit≤30, offset}`                                                          | Untriaged `new` items not in the library, by pre-score, with features and provenance. Read-only.                     |
| `atlas_news_list_sources {runId}`                                                                     | Sources with health and yield, plus pending suggestions. Read-only.                                                  |
| `atlas_news_get_feedback {runId, since?}`                                                             | Aggregated kept/dismissed items with reasons, more/less and per-source precision. Read-only.                         |
| `atlas_news_submit {runId, items:[{itemId, score 1–5, why, projectIds?, citationIds?}], requestKey?}` | Triage judgements. Citations must be library evidence retrieved in the same run.                                     |
| `atlas_news_propose_sources {runId, sources:[{kind, value, label?, reason}]}`                         | Source suggestions, which you add or dismiss in News → Sources.                                                      |

`atlas_add_pdf` remains the only agent-side Zotero write, and News doesn't extend it.

**Later:** `atlas_news_lookup` (bounded enrichment: find a paper's repo or published version), `atlas_news_fetch_url` (Atlas-verified metadata for a page the agent found), and digest submission.

## 7. Skills and workflows

Both skills live in `assistant-workspace/skills/` and are started by you. Neither is scheduled.

- **`atlas-news-scan`:**
  1. Begin a run and call `atlas_news_collect`.
  2. Read the profile, projects, sources and feedback.
  3. Page through `atlas_news_queue`.
  4. For each item: score 1–5 and write a concise "why this matters" that names the project and cites library evidence from `atlas_search` where it exists.
  5. Submit in batches with `atlas_news_submit`, and report counts and the top items.
- **`atlas-news-sources`:** derive source suggestions from the profile, projects, library authors, venues and arXiv categories, and your explicit request, then submit them with reasons through `atlas_news_propose_sources`.

**Later:** a weekly digest of saved and added items per project, and an exploration pass that proposes sources similar to exemplar papers or posts.

## 8. "Add to Zotero" path

Atlas already creates items through the **Zotero 10 local API write support** (`ZoteroWriter`, `server/zotero-write.ts`; item creation in `server/zotero-workflow.ts`). News reuses it:

1. Re-check dedupe against the library. If the paper is already there, only link the project.
2. Ensure write authorization. Your click is the approval.
3. `POST {prefix}/items` with Zotero JSON built from verified metadata:
   - DOI papers become `journalArticle`.
   - arXiv papers become `preprint` with `repository: arXiv`, `archiveID: arXiv:<id>`, `DOI: 10.48550/arXiv.<id>` unless a real DOI exists.
   - Posts, repositories, releases and datasets become `webpage`, `computerProgram` or `dataset`.
   - Set `collections: [chosen]`, an `atlas:news` tag, and a deterministic `Zotero-Write-Token`.
4. Sync. The new paper lands in **Inbox** automatically, because `paper_state` defaults to inbox.
5. Link it to the chosen project (`project_papers`) and set `news_items.paper_id`.
6. Attach a PDF, optionally, through the existing PDF pipeline with `https://arxiv.org/pdf/<id>`. A PDF failure is reported but keeps the created item.

Clear errors cover Zotero not running, Zotero older than 10, and missing write authorization. **Later:** a connector-endpoint fallback for older Zotero versions.

UI-only routes (assistant credentials are rejected):

- `GET /api/news`, `POST|GET /api/news/collect`
- `GET|POST /api/news/sources`, `POST /api/news/sources/detect`, `PATCH|DELETE /api/news/sources/:id`
- `POST /api/news/suggestions/:id/decision`, `PUT /api/news/settings`
- `POST /api/news/items/:id/state`, `/feedback`, `/zotero`, `/project`

## 9. Interface

Mockup: an interactive, standalone HTML file that uses Atlas's palette and supports light and dark mode.

**Sidebar:** a **News** group between Library and Projects (replacing the disabled "News · soon" item in `src/App.tsx`):

- **Today** (badge: new items)
- **Saved**
- **Added**
- **Dismissed**
- **Sources**

**Header:** a **Refresh** button that collects now and shows progress, and a short line suggesting the `atlas-news-scan` workflow with the last triage time. There is no "next run" time, because nothing runs on its own.

**Cards:**

- The top line has a type pill (text plus icon, never colour alone), the source, the age, an "In your library" badge, and a relevance meter with a word.
- Below it: the title, the byline, a **Why this matters** box when triaged, and project chips.
- Expanding a card in place shows the abstract and "Why you're seeing this" (which source found it, which features matched).

**Primary action by type:**

- **Paper: Add to Zotero.** The popover has a collection search, the last-used collection, and Attach PDF and Link to project.
- **Repo, post, release or dataset: Save** and Open.
- **Already in the library:** Open in library and Link to project.

**Feedback happens as part of triage.** Dismiss removes the card immediately and offers reasons (Not relevant · Already know · Low quality · Less from this source) and Undo. More/less thumbs record a preference.

**Keyboard:**

```
j/k next/prev   o expand   z Zotero   s save   d dismiss   u undo   ? help
```

**Sources page:** one large **Add a source** box with Find, which lists detected sources with Add buttons. Below it, your sources grouped by kind with label, last fetch, error, item and kept counts, an enable toggle and a one-click Remove with Undo. Pending assistant suggestions have Add / Dismiss. A small settings section holds the contact email and the OpenAlex API key.

**Later:** an All items archive, a per-project News tab, `⇧Z` to add to the last collection, and source health and precision panels.

## 10. Build phases

1. **MVP (implemented):**
   - Migration v8.
   - Collectors for arXiv RSS, RSS/Atom (including GitHub releases) and OpenAlex author, query and `cites`.
   - The smart Add a source box, one-click remove and enable toggle.
   - DOI/arXiv/OpenAlex/URL dedupe and the library match.
   - Pre-score from lex, follow, fresh, source prior and negative feedback.
   - Manual collection only: the Refresh button and `atlas_news_collect`.
   - The Today, Saved, Added and Dismissed views.
   - One-click Add to Zotero with collection, Inbox, project link and PDF.
   - Feedback logging.
   - The six News MCP tools and the `atlas-news-scan` and `atlas-news-sources` skills.
2. **Later:**
   - Semantic Scholar recommendations with positive and negative seeds.
   - GitHub search and HF papers.
   - Stories and clustering, plus agent links between papers, repos and posts.
   - Citation-graph signal, MMR and exploration slots.
   - Digests and an exploration pass that proposes sources.
   - The evaluation panel, then weights fitted from feedback.
   - Optional local embeddings.
   - Preprint → published notifications for library papers.
   - Bluesky and HN discussion signals.

## Open questions

- **Field coverage.** Does OpenAlex cover your non-arXiv venues quickly enough? Does the Semantic Scholar "recent" pool cover them, if it is added later? Test on your sources before relying on it.
- **Keys.** A free OpenAlex key is stored in Atlas settings. Semantic Scholar keys and a GitHub token come with the later sources.
- **Privacy.** Only source values (categories, feed URLs, public IDs and keyword queries) and the optional contact email leave the machine during collection. Using a cloud agent for triage sends candidate abstracts and retrieved library excerpts to that provider, as the existing workflows already do.
