---
name: atlas-review-paper
description: Produce a grounded review of a paper in Atlas, with citation-linked claims and clear evidence limits.
---

# Review an Atlas paper

Use when asked to assess, summarize, or critique a paper stored in Atlas.

1. Start a run with `atlas_begin_run({purpose, agentName, model})`. Identify the requested paper, then retrieve its metadata and relevant text with `atlas_get_context({runId, paperId, ...})`; use `atlas_search` for specific claims or comparisons. For either tool, follow each returned `nextOffset` until null when reviewing all available paper evidence.
2. State what material was available: metadata, abstract, full text, and/or OCR. If the PDF is unavailable, unindexed, or has no extractable text, keep the review at the metadata/abstract level and say full-text analysis was unavailable; never imply that you read the PDF or use filesystem access to retrieve it. If only title-level metadata is available, limit the response to that and ask for an abstract or full text before making a substantive assessment.
3. Separate the paper's reported claims and findings from your assessment. Cover the question, approach, evidence, contribution, limitations, and relevance to the user's stated purpose only when supported by retrieved material. Mark uncertainty explicitly.
4. Cite every paper-specific factual claim with a returned citation ID, placed close to the claim. Do not infer unreported methods, results, sample sizes, or causal conclusions.
5. If the user asks to save the review, submit it with `atlas_submit({runId, kind: 'review', title, body, paperId, citationIds})`. Reviews require 1–100 returned citation IDs. Keep it labeled as AI-generated review content and do not overwrite or blend it with human notes.
