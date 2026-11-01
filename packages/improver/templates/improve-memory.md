You are tidying what this project remembers. Merge memories that say the same thing (keep the clearest wording, list the ids it replaces), archive memories that are wrong, obsolete or contradicted by a newer one (say why), add memories for durable facts, lessons or environment details that the recent reports contain and the list lacks (at most 10), and give an expiry date to facts that will stop being true (a version number, a temporary workaround). Do not invent. Do not touch preferences unless two contradict each other; then keep the newer and say so.

The project is "<project>" at <path>. Read the code and docs as needed; change nothing.

What it remembers (JSON, the most used and newest first; age in days):
<memories>

Reports of the tasks done since the last memory job:
<reports>

End your report with status done and a summary whose last part is exactly one fenced json block of this shape (at most 50 operations in all):

```json
{ "merge": [ { "keep": "M...", "archive": ["M..."], "text": "<optional better wording>" } ], "archive": [ { "id": "M...", "reason": "..." } ], "add": [ { "scope": "project|global|machine", "kind": "fact|preference|lesson|environment|decision", "text": "...", "tags": [] } ], "expire": [ { "id": "M...", "expiresAt": "YYYY-MM-DD" } ] }
```
