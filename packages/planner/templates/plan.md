You are planning the next tasks for the project "<project>" at <path>. Read the code and docs as needed; change nothing.

Goals (highest priority first):
<goals>

Done in the last 14 days:
<recent>

Open now (do not duplicate these):
<open>

What the project remembers:
<memory>

Coordinator notes:
<notes>

Propose at most <maxTasks> tasks that move the goals forward and that a capable engineer could do from the text alone: what, why, where in the code, how the owner will see the result. Prefer small tasks that land on their own. Mark a task that must wait for another with "after". End your report with status done and a summary whose last part is exactly one fenced json block:

```json
{ "tasks": [ { "goal": "G...", "kind": "feature|bug|automation|single", "duty": "<only for single>", "title": "<= 120 chars", "text": "...", "after": "<index of an earlier task in this list, or null>" } ] }
```
