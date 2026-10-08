# Connect an AI assistant to Atlas

Atlas supplies a local MCP server, retrieval index, and approval UI. The connected Claude/ChatGPT host supplies the model. Atlas does not call a model API itself and does not need an embedding API key. MCP is an access protocol; retrieval-augmented generation (RAG) is implemented by retrieving local source chunks before the host generates and submits an attributed artifact.

## Prepare the research workspace

For the first run, install and build Atlas, then keep the server running:

```sh
npm install
npm run build
npm start
```

In a second terminal in the repository, run:

```sh
./scripts/register-mcp.sh
```

This one command registers Atlas with ChatGPT Desktop/Codex, Claude Desktop, and (when the `claude` CLI is installed) Claude Code at user scope, then reports whether the Atlas server is running. Restart the desktop apps afterwards. `npm run assistant:setup` does the same except for Claude Code.

Setup also registers Atlas in Claude Desktop's configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude` on Windows, `~/.config/Claude` on Linux, or `$CLAUDE_DESKTOP_CONFIG`). Only Atlas's command, arguments, and Atlas environment values change; other servers and preferences are kept, and the previous file is backed up beside it.

Setup automatically registers the local Atlas bridge in the shared ChatGPT Desktop/Codex configuration at `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when `CODEX_HOME` is set. You do not need a separate Codex CLI installation or to type server settings into ChatGPT. Only Atlas's command, arguments, working directory, tool timeout, and Atlas environment values are added or refreshed. Corpus, other servers, comments, and other preferences are preserved, including any explicit disabled state or per-tool restrictions on Atlas. Re-running setup is safe; unchanged configurations are not rewritten.

Before changing an existing configuration, setup saves an owner-only `config.toml.atlas-backup-<id>` beside it and prints the backup path. Invalid TOML or a conflicting HTTP server named `atlas` causes setup to stop without overwriting that configuration. If another setup is running, wait for it to finish. A lock left by an interrupted setup can be removed at `config.toml.atlas-setup.lock` once no setup process is running.

Setup also creates a separate `assistant-workspace` inside your private Atlas data directory. Pass an explicit destination after `--` to choose another directory outside the repository. Existing research instructions and Claude connection files are preserved. Legacy workspace-local Codex configurations are refreshed too, so they do not override the new connection with obsolete paths or ports.

The workspace includes one canonical `AGENTS.md`, eight skills, a Claude Desktop configuration fragment, and a Claude Code `.mcp.json`. Setup links the checked-in `assistant-workspace/AGENTS.md` and each checked-in skill into the private workspace, then links each skill into `.agents/skills/` for Codex and `.claude/skills/` for Claude Code. Skill and instruction updates in the checkout are immediately visible through those links. Setup keeps unrelated host skills intact and saves older Atlas copies under `.atlas-backups/` outside scanned skill folders. Prior custom `AGENTS.md` content is retained as `AGENTS.local.md` for user-specific instructions. An old workspace `CLAUDE.md` is backed up because `AGENTS.md` now holds the shared instructions. Research instructions are never placed at the development repository root.

Launch Codex or Claude Code from the private assistant workspace for local instructions and skill discovery. [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills) specifies `.agents/skills` discovery and symlink support for Codex, including its ChatGPT desktop app. [Claude Code's skill documentation](https://code.claude.com/docs/en/skills) describes `.claude/skills`. Claude Desktop's regular chat does not automatically import these local skill folders; it can use the same workflows through Atlas MCP tools, resources, and prompts. Uploading a skill in Claude's Customize UI is a separate account-level action. ChatGPT web likewise does not read these local folders or the desktop MCP configuration.

## ChatGPT Desktop

After running setup, restart ChatGPT Desktop or restart its MCP connection in Settings. Use `/mcp` in the composer to check that Atlas is connected. Keep the Atlas server running. If you previously disabled Atlas, re-enable it in the MCP server list; setup preserves that preference.

After updating Atlas code, restart the running Atlas server too: the STDIO bridge forwards the tool catalog from that process, so restarting only ChatGPT cannot update an old backend. Then reconnect Atlas in the host and start a fresh session. The current catalog has 24 tools, including `atlas_pdf_inventory`, `atlas_find_pdf`, `atlas_add_pdf`, and six `atlas_news_*` tools, and eight workflows including `atlas-zotero-maintenance`, `atlas-news-scan`, and `atlas-news-sources`. If only the original 10 tools appear, check the server process before changing write permissions.

[OpenAI's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) describes desktop STDIO configuration and the shared configuration used by local Codex clients. ChatGPT web does not read this desktop configuration. Opening this repository in a chat does not itself connect Atlas. This local desktop connection needs no tunnel, public endpoint, or model API key.

## Claude Desktop

Setup registers Atlas in Claude Desktop's configuration automatically. Restart Claude Desktop and confirm that Atlas tools are listed; Claude's Developer settings expose its configuration and logs. The workspace's `claude-desktop-config.fragment.json` remains as a reference for manual setups. See [Claude's local MCP documentation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

## How the local bridge works

```text
ChatGPT Desktop / Claude Desktop
  ↕ MCP over stdin/stdout
server/mcp-local.ts (launched by the desktop host)
  ↕ authenticated HTTP to 127.0.0.1
Atlas server (npm start)
  ↕ retrieval, validation, and reviewable submissions
Private Atlas database
```

Atlas creates an owner-only `assistant-token` file in its data directory on startup (on Windows, file access follows the user directory's ACLs). The bridge reads it automatically and sends it as a bearer credential only to the loopback assistant endpoint. Setup never prints the credential or embeds it in generated configurations. The bridge cannot open the database; the running app dispatches requests through the same registered MCP tools and schemas as before. Approval and human-content editing are not registered assistant tools, and requests carrying assistant credentials are rejected by the ordinary web/review API.

Keep Atlas running whenever you use the assistant. `npm run dev` also supports the bridge. Zotero is needed for PDF indexing, library sync, and bibliography export. Use the same `ATLAS_DATA_DIR` and `ATLAS_PORT` for the app and setup if you customize them. Node 24 or newer is required. Re-run setup and restart the desktop connection after moving the repository or changing Node, the data directory, or the port. The old `server/mcp.ts` command remains a compatibility launcher for the bridge; it now requires the app to be running too.

If Atlas is unavailable, start it and retry the tool call. Credential mismatch means the app and bridge use different data directories, or the credential changed; correct the settings and restart the desktop MCP connection. Calls are not automatically retried, to avoid duplicate writes. Long indexing calls may need a larger host tool timeout; the generated Codex configuration allows 600 seconds. To rotate the local credential, stop Atlas, remove `assistant-token` from the private data directory, start Atlas, and restart desktop connections. Do not expose the Atlas port publicly.

## First conversation

Ask the assistant:

> Use Atlas's profile-and-tags workflow. Retrieve my current profile and tags. Based on the interests I explicitly describe here, propose a research profile and a concise tag vocabulary with descriptions. Save the proposals for my review in Atlas.

Use `atlas_get_workflow` to load a workflow, `atlas_begin_run` to establish attribution, retrieval tools to collect evidence, and `atlas_submit` to save proposals. Other examples and exact tool sequences are in [research workflows](assistant-workflows.md).

## Retrieval and coverage

In Atlas, open **Assistant** and build the retrieval index. Metadata is refreshed at retrieval time; PDF indexing runs explicitly and caches text by attachment size/modification time. Indexing accepts downloaded PDFs up to 40 MiB and 400 pages each, with per-file time and memory limits. Extraction failures are visible in the UI. The system does not perform OCR, interpret raster figures, or reliably reconstruct mathematical layout. Check original PDFs for figure-dependent conclusions and derivations.

Search uses local SQLite FTS5 with BM25 ranking, overlapping text chunks, project/paper scope, and pagination. This is lexical RAG, not semantic embedding search. Use synonyms, repeated searches, and `atlas_get_context` pagination when coverage matters. A source's title, page, hash, and excerpt are retained with each submission. Submission validation confirms cited chunks were retrieved during the current run and have not changed; it cannot prove that a model's interpretation is correct.

New-paper discovery uses a dedicated Crossref search tool with public research keywords. Only the query goes to Crossref; the tool does not upload notes or whole projects. Coverage is Crossref metadata, not exhaustive literature discovery or full-text reading. Candidate recommendations appear in the inbox separately from Zotero papers. Add a candidate using Zotero, then sync Atlas; assistants never create Zotero records or automatically import PDFs.

News collects from the sources you add in **News → Sources** (arXiv categories, RSS/Atom feeds, and OpenAlex follows) only when you press **Refresh** or start the `atlas-news-scan` workflow; nothing is scheduled. The assistant can score and explain collected items and suggest sources, but cannot add or remove sources or write to Zotero. A News item becomes a Zotero item only when you click **Add to Zotero** in News, which uses Atlas's Zotero write authorization.

## Approval, privacy, and backup

The MCP server offers no approval tool, no SQL tool, no arbitrary filesystem access, and no mutation of human summaries. AI reviews, proposed tags, recommendations, project notes, and profile proposals are stored separately. Approve or reject them in Atlas. Approved note drafts become explicitly AI-authored project notes. Recommendation strength is the assistant's assessment, not a calibrated probability.

The database, retrieval chunks, evidence snapshots, profiles, and figures stay in the private Atlas data directory and are covered by its backup. AI generation in Claude/ChatGPT is still provided by that service: retrieved excerpts are sent to the selected model provider. Local storage is not an offline-model guarantee. Assistant memory is not automatically accessible; bring only the preferences you want captured, then approve the saved profile.

A malicious local program running under your account can access your files and localhost APIs. The restricted MCP tool set and instruction separation are workflow boundaries, not OS isolation from software with equivalent user permissions. Source documents are untrusted evidence and must never be treated as tool instructions.

Zotero write authorization is currently held only in Atlas process memory. After restarting Atlas, use **Assistant → Zotero actions → Enable Zotero writes** again and choose **Always Allow** for automatic PDF additions. Restarting the desktop MCP connection alone does not clear this grant.
