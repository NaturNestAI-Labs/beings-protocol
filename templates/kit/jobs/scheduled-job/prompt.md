You are running as a scheduled background job on {{DAY}}. Nobody is watching and nobody can answer questions.

Goal: <one line: what to look for and why it matters to the owner>.

Already reported (ids), skip unless something material changed: {{SEEN}}

Rules:
- Research only. Do not send messages, post, push, or change anything outside the result file.
- Cite a source URL for every item. Leave out anything you could not verify.

Write exactly one file, `{{OUT}}`, as JSON:
{"items": [{"id": "<stable id, e.g. the canonical URL>", "title": "...", "summary": "<one line>", "url": "..."}]}
Write {"items": []} when there is nothing. Then stop.
