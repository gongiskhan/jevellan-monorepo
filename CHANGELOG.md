# Changelog

Every package of this repository carries the same version (`scripts/bump-version.mjs`).

## 0.1.0 - 2026-11-01

The first release of Jevellan as a monorepo: the `jv` engine of `gongiskhan/jevellan-skills` lifted into a library,
with the command, a control MCP, cross-agent memory, a web UI, an always-on bot, schedules, a planner and an
improver around it. The skills themselves stay in `jevellan-skills`; `jv bootstrap --skills <checkout>` installs
them. The checkout is the install: `~/.jv/bin/jv` runs this checkout's build.

### jevellan-core

- The lifted engine with its tests: the store, tasks and steps, Jev placement, landing, the runtimes (Claude SDK,
  Claude in tmux, Codex, plain LLM), the coordinator, doctor, usage and the report contract.
- Store schema 2 (brief section 3): goals, jobs, schedules, memories, UI tokens, A2UI columns on reports and
  messages, task origins and the coordinator conversation task. Version 1 stores migrate with a `.v1.bak` copy made
  by `VACUUM INTO`.
- Reconcile: lost runs resumed on their native session, queued tasks admitted under per-project and total limits,
  messages and wake lines delivered.
- The jobs machinery the planner and the improver share, the bot's configuration and status view, and the provider
  probes.
- Landings carry their checks with an outcome line in `jv task show --json`.
- A project's MCP servers in `project.json` name their secrets as files under `~/.jv/secrets` (`envFiles` for a
  stdio server's environment, `headerFiles` and `bearerTokenFile` for an http or sse server); a literal value under a
  credential's name is refused. Their values reach the worker through its environment or a mode 600 file, never a
  command line.
- One redactor masks every known secret before text is cut, stored or typed, and again on the way out; jv signals only
  processes it can show it started; the version 1 backup is taken under the migration's write lock and an existing
  one is kept only when it matches the store; doctor's agent CLI probes run in a jv-owned home.

### jevellan-cli

- Every command of the lifted `jv`, unchanged in output, plus `jv memory`, `jv goal`, `jv job`, `jv improve`,
  `jv schedule`, `jv bot`, `jv mcp` and `jv ui`.

### jevellan-memory

- Memories with full-text search, dedupe, ranking, archive and supersede (nothing deleted), the worker tools
  `jv_remember` and `jv_recall`, and the "What this project remembers:" block in worker and coordinator prompts.

### jevellan-mcp

- The 34 tools of brief section 5 and three resources over stdio and stateless Streamable HTTP (bearer token,
  `/health`), with the same JSON as `jv ... --json`, and one log line per call without arguments.

### jevellan-ui

- A node:http server over the same operations table (cookie sign-in, server-sent events, evidence, the CSP of
  M-044) and a React web app: projects with the coordinator conversation, tasks with their actions (Message,
  Answer, Stop, Resume, Override from the providers.json menu, Changes, Attach, Land now and Leave it), sessions,
  reports with A2UI surfaces, memory, schedules, goals, jobs, decisions, usage, the bot and doctor; light and dark,
  desktop and phone.

### jevellan-bot

- The tick loop under a lock: heartbeat, reconcile, the coordinators' conversations, due schedules, jobs and an
  hourly housekeeping; a health endpoint, a trimmed log, a configuration reread on change, and launchd and systemd
  service files that the owner loads.

### jevellan-scheduler, jevellan-planner, jevellan-improver

- Five-field cron with Vixie daylight-saving semantics and per-schedule time zones; schedules that create tasks or
  jobs.
- Goals and the plan job, which proposes the next tasks with their `after` links.
- improve-memory, improve-docs and improve-skills jobs; their changes go through the normal landing.

### Dependencies

- dompurify, under `@a2ui/react` 0.14.0, is raised to 3.4.17 by an npm override (M-070).
