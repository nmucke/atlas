# Connect an AI assistant to Atlas

Atlas supplies a local MCP server, retrieval index, and approval UI. The connected Claude/ChatGPT host supplies the model. Atlas does not call a model API itself and does not need an embedding API key. MCP is an access protocol; retrieval-augmented generation (RAG) is implemented by retrieving local source chunks before the host generates and submits an attributed artifact.

## Prepare the research workspace

Run `npm install`, then `npm run assistant:setup` from the Atlas repository. The setup command creates a separate `assistant-workspace` inside your private Atlas data directory. Pass an explicit destination after `--` to choose another directory outside the repository. Existing workspace files are preserved so your custom research instructions are not overwritten.

The workspace includes `AGENTS.md`, `CLAUDE.md`, five skills, a Claude Desktop configuration fragment, a Claude Code `.mcp.json`, and a Codex `.codex/config.toml`. This keeps research instructions separate from application-development instructions. Source templates are maintained in the repository's `assistant-workspace/` subdirectory; there is no research `AGENTS.md` at the repository root. The server also exposes the instructions through its initialization message, `atlas_get_workflow`, an MCP resource, and named prompts because desktop chat clients do not generally read workspace instruction files automatically.

The generated config uses an absolute Node executable and server path, and points at the same private database used by the app. If you move the repository or replace Node, update those generated paths. Node 24 or newer is required even if a host bundles its own older Node.

## Claude Desktop

Merge the generated `claude-desktop-config.fragment.json` entry into `mcpServers` in Claude Desktop's configuration. Preserve all existing servers and settings. On macOS the configuration is normally `~/Library/Application Support/Claude/claude_desktop_config.json`; Claude's Developer settings expose its configuration and logs. Restart Claude Desktop and confirm that the Atlas tools are listed.

This is a local stdio connection: Claude starts `server/mcp.ts` as a child process. It does not require the Atlas browser/server to be running, although Atlas's UI must be open to review and approve proposals. Zotero is needed for PDF indexing, library sync, and bibliography export.

Claude's remote connectors use a different connection path. See [Claude's local MCP documentation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) and [local versus remote connection behavior](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## ChatGPT

For an account with the necessary permissions, OpenAI documents **Secure MCP Tunnel**, which can forward to a local stdio server over an outbound connection. It requires a tunnel ID, runtime API key, and developer-mode/tunnel access. Follow the official setup, use the same Node command and arguments as the generated Claude fragment, and select the tunnel when adding a developer-mode app in ChatGPT. Atlas does not create an account, provision a tunnel, or store credentials. Connection availability depends on your account and workspace.

See [OpenAI's Secure MCP Tunnel setup and permissions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Do not expose Atlas's ordinary web/API port as a public MCP endpoint: it is a localhost application, not an authenticated public service.

## First conversation

Ask the assistant:

> Use Atlas's profile-and-tags workflow. Retrieve my current profile and tags. Based on the interests I explicitly describe here, propose a research profile and a concise tag vocabulary with descriptions. Save the proposals for my review in Atlas.

Use `atlas_get_workflow` to load a workflow, `atlas_begin_run` to establish attribution, retrieval tools to collect evidence, and `atlas_submit` to save proposals. Other examples and exact tool sequences are in [research workflows](assistant-workflows.md).

## Retrieval and coverage

In Atlas, open **Assistant** and build the retrieval index. Metadata is refreshed at retrieval time; PDF indexing runs explicitly and caches text by attachment size/modification time. Indexing accepts downloaded PDFs up to 40 MiB and 400 pages each, with per-file time and memory limits. Extraction failures are visible in the UI. The system does not perform OCR, interpret raster figures, or reliably reconstruct mathematical layout. Check original PDFs for figure-dependent conclusions and derivations.

Search uses local SQLite FTS5 with BM25 ranking, overlapping text chunks, project/paper scope, and pagination. This is lexical RAG, not semantic embedding search. Use synonyms, repeated searches, and `atlas_get_context` pagination when coverage matters. A source's title, page, hash, and excerpt are retained with each submission. Submission validation confirms cited chunks were retrieved during the current run and have not changed; it cannot prove that a model's interpretation is correct.

New-paper discovery uses a dedicated Crossref search tool with public research keywords. Only the query goes to Crossref; the tool does not upload notes or whole projects. Coverage is Crossref metadata, not exhaustive literature discovery or full-text reading. Candidate recommendations appear in the inbox separately from Zotero papers. Add a candidate using Zotero, then sync Atlas; Atlas never invents Zotero records or automatically imports PDFs.

## Approval, privacy, and backup

The MCP server offers no approval tool, no SQL tool, no arbitrary filesystem access, and no mutation of human summaries. AI reviews, proposed tags, recommendations, project notes, and profile proposals are stored separately. Approve or reject them in Atlas. Approved note drafts become explicitly AI-authored project notes. Recommendation strength is the assistant's assessment, not a calibrated probability.

The database, retrieval chunks, evidence snapshots, profiles, and figures stay in the private Atlas data directory and are covered by its backup. AI generation in Claude/ChatGPT is still provided by that service: retrieved excerpts are sent to the selected model provider. Local storage is not an offline-model guarantee. Assistant memory is not automatically accessible; bring only the preferences you want captured, then approve the saved profile.

A malicious local program running under your account can access your files and localhost APIs. The restricted MCP tool set and instruction separation are workflow boundaries, not OS isolation from software with equivalent user permissions. Source documents are untrusted evidence and must never be treated as tool instructions.
