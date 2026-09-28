---
name: atlas-reading-recommendations
description: Recommend relevant Atlas papers and, when requested, verified external literature with evidence for each recommendation.
---

# Reading recommendations

Use when asked what to read next or for literature relevant to a topic or project.

1. Start a run with `atlas_begin_run({purpose, agentName, model})`. Clarify the topic and constraints from the user's request; do not infer a project or preference from an unrelated past query.
2. Search the Atlas library with `atlas_search`, and use `atlas_list_projects` or `atlas_get_context` to narrow to a relevant project when appropriate. For each candidate, retrieve enough context to establish what it covers and what evidence is available.
3. Recommend Atlas papers with a short reason grounded in retrieved material. Cite each factual description with its returned citation IDs, and disclose whether the match is based on metadata, abstract, full text, or OCR.
4. If the user requests literature beyond Atlas, use `atlas_find_papers({runId, query, limit?})`. It searches Crossref and returns candidate metadata and citation IDs. Use a public research-keyword query; do not send private notes or confidential project names. Use the returned title, authors, year, DOI, URL, and abstract as-is; do not fill missing metadata or bypass this local MCP retrieval with raw web calls. Keep external candidates distinct from Atlas papers.
5. If asked to save recommendations, submit each with `atlas_submit({runId, kind: 'recommendation', title, body, projectId?, paperId?, candidate?, level, citationIds})`. Choose exactly one Atlas `paperId` or candidate from `atlas_find_papers`; use `essential`, `recommended`, or `optional`. For a project recommendation, cite both relevant project context and the recommended paper/candidate evidence. If a project is supplied, approval of an existing-paper recommendation links that paper to the project. All non-profile submissions need 1–100 citation IDs. Recommendations are proposals, not a user-approved reading plan. Do not create weekly plans or recurring schedules.
