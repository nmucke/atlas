---
name: atlas-project-references
description: Build or update a cited reference list for an Atlas project using papers already indexed in the library.
---

# Project references

Use when asked to collect, organize, or annotate papers for an Atlas project.

1. Start a run with `atlas_begin_run({purpose, agentName, model})`. Use `atlas_list_projects` to identify the project; if the target is ambiguous, ask a concise clarifying question before saving.
2. Retrieve complete project context with paginated `atlas_get_context({runId, projectId, limit: 30, offset?})`. Continue from each returned `nextOffset` until it is null; Atlas notes may span more than 30 chunks. Use `atlas_search` to find relevant papers within that scope and retrieve enough evidence to verify each paper's relevance. If the user asks for papers outside Atlas, use `atlas_find_papers({runId, query, limit?})`; it uses Crossref and returns candidate records and citation IDs. Send only public research keywords, not private notes or confidential project names. Use candidate metadata as returned without inventing or replacing DOI details.
3. Present references with stable paper identity/title as returned by Atlas, a concise relevance note, and returned citation IDs. State when a relevance assessment relies on abstract or metadata because full text/OCR is unavailable.
4. Submit each requested recommendation through `atlas_submit({runId, kind: 'recommendation', title, body, projectId, paperId?, candidate?, level, citationIds})`. Use exactly one of `paperId` for an Atlas paper or `candidate` from `atlas_find_papers`; choose `essential`, `recommended`, or `optional` based on the user's purpose and evidence. Include project context citations as well as the paper or candidate citations, since each recommendation must support both project fit and paper identity. Non-profile submissions require 1–100 citation IDs. An optional comparison across the list can be saved separately as `kind: 'note'` with the project ID and relevant project evidence citations.
5. Keep entries as AI-authored recommendations. They do not change project membership until the user approves them in the Atlas interface; approving an existing-paper recommendation links its paper to the project. Do not edit membership or human-authored notes through any other path.
