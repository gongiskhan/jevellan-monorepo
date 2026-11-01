# Architecture

One SQLite store in the middle, `~/.jv/store.sqlite`, and every package around it. The store is the only state and the
only history: every task, step, run (one row per turn), event, report, decision, landing, message, memory, schedule,
goal and job is a row there. No package keeps state of its own; processes that run at the same time (the bot, `jv
run` workers, the UI server, the MCP server, the command line) all read and write the store in short transactions
(WAL, `busy_timeout` 5000, `BEGIN IMMEDIATE`, request ids on every creating write).

```
                       jevellan-cli  (the jv command; depends on everything, loads ui, bot and mcp lazily)
                            |
     +-----------+----------+----------+------------+-------------+
     |           |          |          |            |             |
 jevellan-ui  jevellan-  jevellan-  jevellan-   jevellan-     jevellan-
 (server +    bot        mcp        scheduler   planner       improver
  web app)    (tick)     (tools)    (cron)      (goals,plan)  (memory, docs, skills jobs)
     |           |          |          |            |             |
     +-----------+----------+----------+------------+-------------+
                            |
                      jevellan-core  ---- registers ----  jevellan-memory
                (store, tasks, Jev placement,             (memories, FTS5,
                 landing, runtimes, reconcile,             recall, brief)
                 coordinator, jobs, worker tools)
                            |
                     ~/.jv/store.sqlite
```

Dependency direction (each `package.json` lists only what its source imports; `packages/core/test/deps.test.ts`
checks it): core and memory depend on nothing in the repository; scheduler, planner and improver on core and memory;
mcp also on scheduler, planner and improver, whose operations its tools are; bot on core, memory, scheduler, planner
and improver; ui on everything but bot and cli (it observes the bot through the store); cli on everything. jevellan-core
reaches memory through a port that the jv process registers at start (M-015), and memory's tables are a schema
extension of the store (M-011).

## What each package does

- **jevellan-core**: the engine, lifted from the jevellan-skills runtime (M-001, M-008). Tasks run as workflows of
  steps; every step is placed by Jev (model, effort, provider; no fallback) and run on one of four runtimes
  (`claude-sdk`, `claude-tmux`, `codex`, `llm`) in its own git worktree; workers report through `jv_report` and
  remember through `jv_remember`/`jv_recall`. When the last step is done, Jev reads the landing policy and the branch
  lands, gets one more verification, or waits for the owner. `reconcile()` keeps it moving: lost runs resumed, queued
  tasks admitted under the limits, messages and wake lines delivered. The coordinator is an interactive Claude Code in
  tmux per project; its conversation is tailed into the store. The jobs machinery and the public contracts (zod
  schemas with fixtures) live here too.
- **jevellan-cli**: the `jv` command, every lifted command with the same flags and JSON plus the new ones. It owns the
  process: open the store, run one core function, print, exit. `~/.jv/bin/jv` is a shim that runs this checkout's
  `packages/cli/dist/bin.js` with the Node 22 recorded at `jv bootstrap` (the checkout is the install, M-007).
- **jevellan-memory**: what every agent remembers between sessions, scoped global, per project and per machine;
  remember with dedupe, recall ranked by bm25 adjusted for age and use, the brief every prompt carries, archive and
  supersede as the only removals.
- **jevellan-mcp**: the control plane for any MCP client (Claude Code, the Claude app over Tailscale, Codex): one tool
  per command of section 5, each returning the same JSON as `jv ... --json`; stdio or token-protected Streamable HTTP.
  Its operations table is also what the UI's JSON routes call.
- **jevellan-ui**: the Jevellan web app over the store: a `node:http` server with password sign-in, JSON routes, live
  updates by Server-Sent Events and evidence files, and a React app (projects, the coordinator chat, tasks, sessions,
  memory, schedules, goals, jobs, the bot, doctor); A2UI surfaces from reports render inside the task page.
- **jevellan-bot**: the always-on loop. Every tick: heartbeat, reconcile, the coordinator tails, due schedules, jobs,
  and hourly housekeeping. It runs no model itself; everything it starts is a step placed by Jev.
- **jevellan-scheduler**: five-field cron in an IANA zone (DST as Vixie cron, M-016) firing tasks or jobs
  idempotently per slot.
- **jevellan-planner**: goals, and the plan job that turns them into queued tasks the bot admits.
- **jevellan-improver**: jobs that tidy memory, bring documentation up to date and propose skill changes, always as
  something the owner can see: memories are superseded or archived, documentation and skill changes land through the
  normal landing, skill changes always ask the owner.

## Where things live

`~/.jv/` (`JV_HOME` overrides it): `store.sqlite`, `providers.json`, `secrets/` (key and token files, mode 600; also
`mcp.token`), `bin/jv` (the shim), `runtime` (a link to this checkout's `packages/core`), `skills` (a link to the
installed skill set), `install.json`, `homes/<provider>/` (the HOME of that provider's sessions), `projects/<name>/`
(project.json, landing.json, notes.md, memory.md, workflows/, coordinator-prompt.md), `worktrees/`, `logs/` (one log
per run, plus bot.log, ui.log, mcp.log), `run/` (pid files and the bot lock), `bot.json`, `ui-password`, `archive/`
(whatever jv moves aside instead of deleting).

The skills (policy, duty, workflow and coordinator skills) are not in this repository: `jv bootstrap --skills
<jevellan-skills checkout>` copies them into `~/.jv/skills/`, the only place jv reads them from.
