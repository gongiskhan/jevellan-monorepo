# Acceptance results

Written by `acceptance/run-all.mjs` at 2026-11-01 18:48:34 UTC on Goncalos-MacBook-Pro.local, checkout `/Users/ggomes/dev/jevellan-monorepo` at 1e0fbcf. Journeys are the ones of brief section 14; each section below lists the journey's own checks (PASS or FAIL, with the time each took) and notes, from `acceptance/results/<journey>.json`.

| Journey | Title | Status | Elapsed | Ran at | Mode |
| --- | --- | --- | --- | --- | --- |
| M1 | Install | pass | 10 s | 2026-11-01 18:47:03 UTC | real home /Users/ggomes/.jv |
| M2 | Command parity | pass | 9 s | 2026-11-01 18:48:29 UTC | temporary JV_HOME, made-up providers, no model |
| M3 | Store compatibility | pass | 20 s | 2026-11-01 18:47:51 UTC | real providers and Jev in a temporary JV_HOME |
| M4 | One task end to end | not written yet |  |  |  |
| M5 | Queue under the bot | not written yet |  |  |  |
| M6 | UI actions | not written yet |  |  |  |
| M7 | Coordinator chat | not written yet |  |  |  |
| M8 | A2UI | not written yet |  |  |  |
| M9 | MCP | not written yet |  |  |  |
| M10 | Memory | not written yet |  |  |  |
| M11 | Scheduler | not written yet |  |  |  |
| M12 | Planner | not written yet |  |  |  |
| M13 | Bot recovery | not written yet |  |  |  |
| M14 | Service file | not written yet |  |  |  |
| M15 | Phone | not written yet |  |  |  |
| M16 | No leaks | not written yet |  |  |  |
| M17 | Member untouched | not written yet |  |  |  |

Totals: 3 pass, 14 not written yet.

## M1 Install

Status: pass. 11 of 11 checks passed in 10 s; ran 2026-11-01 18:46:53 UTC to 2026-11-01 18:47:03 UTC on Goncalos-MacBook-Pro.local, commit 1e0fbcf, mode: real home /Users/ggomes/.jv. From an earlier run (not run this time).

Checks:

- PASS Node 22.22.0 at /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node (0.0 s): v22.22.0
- PASS npm ci at the checkout (5.3 s): 5 s
- PASS npm run build at the checkout (0.3 s): 0 s
- PASS build output present (0.0 s): /Users/ggomes/dev/jevellan-monorepo/packages/cli/dist/bin.js
- PASS jv bootstrap --skills /Users/ggomes/dev/jevellan-skills (0.2 s): 14 skills unchanged, skills 0.1.0 at bcf93d2, node /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node
- PASS runtime link points at the checkout (M-007) (0.0 s): /Users/ggomes/.jv/runtime -> /Users/ggomes/dev/jevellan-monorepo/packages/core
- PASS jv --version prints the three versions (0.3 s): jevellan 0.1.0 (store schema 2, skills 0.1.0)
- PASS the shim execs Node 22.22.0 on the checkout CLI (D-001, D-024) (0.0 s): exec /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node --disable-warning=ExperimentalWarning /Users/ggomes/dev/jevellan-monorepo/packages/cli/dist/bin.js
- PASS jv doctor --json answers (through the shim) (4.2 s): 38 lines, exit 0
- PASS the shim runs Node 22.22.0 (doctor node line) (0.0 s): OK Node 22.22.0
- PASS jv doctor: every line OK or an allowed WARN (0.0 s): 33 OK; 5 allowed WARN (models:ollama: Ollama without models; key:glm: provider without key file; key:deepseek: provider without key file; key:kimi: provider without key file; login:glm: provider without key file)

Notes:

- mode: real home /Users/ggomes/.jv

## M2 Command parity

Status: pass. 30 of 30 checks passed in 9 s; ran 2026-11-01 18:48:20 UTC to 2026-11-01 18:48:29 UTC on Goncalos-MacBook-Pro.local, commit 1e0fbcf, mode: temporary JV_HOME, made-up providers, no model. From an earlier run (not run this time).

Checks:

- PASS skills runtime built in a temporary copy (5.0 s): /Users/ggomes/.jv-test/m02-20261101t184820z-1190/jevellan-skills at bcf93d2: npm ci 4 s, tsc 1 s
- PASS jv doctor --help (0.2 s): identical
- PASS jv project --help (0.2 s): identical
- PASS jv providers --help (0.2 s): identical
- PASS jv status --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 4: jv status gains --watch
- PASS jv task --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 4: jv task gains list and changes
- PASS jv land --help (0.2 s): identical
- PASS jv report --help (0.2 s): identical
- PASS jv tail --help (0.2 s): identical
- PASS jv attach --help (0.2 s): identical
- PASS jv ui --help (0.2 s): identical
- PASS jv coordinator --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 4: jv coordinator gains message
- PASS jv handoff --help (0.2 s): identical
- PASS jv notes --help (0.2 s): identical
- PASS jv evals --help (0.2 s): identical
- PASS jv usage --help (0.2 s): identical
- PASS jv gc --help (0.2 s): identical
- PASS jv --help lists every command line of the skills runtime (0.1 s): 22 lines, 3 changed with their command, 4 added
- PASS skills runtime: jv project add (made-up providers, throwaway repository) (0.1 s): PTPZ5QH at /Users/ggomes/.jv-test/m02-20261101t184820z-1190/project
- PASS skills runtime: tasks, runs, report written through its dist modules (0.0 s): T1 T4P7BSG (waiting-owner, report on RSR984D), T2 T15QQKX (running, RJVC2KB queued), T3 TYA7DSH (done)
- PASS the store is schema 1 before this jv opens it (0.0 s): schema_version 1
- PASS skills runtime: jv status --json (0.1 s): 4 top-level keys
- PASS skills runtime: jv task show T4P7BSG --json (0.1 s): 23 top-level keys
- PASS skills runtime: jv report RSR984D --json (0.1 s): 14 top-level keys
- PASS this jv: jv status --json (0.1 s): 5 top-level keys
- PASS this jv: jv task show T4P7BSG --json (0.1 s): 24 top-level keys
- PASS this jv: jv report RSR984D --json (0.1 s): 14 top-level keys
- PASS jv status --json: every key of the skills runtime is kept (0.0 s): 51 keys in the skills runtime, 63 in this jv; added: bot, bot.alive, bot.heartbeatAgeSeconds, bot.heartbeatAt, bot.limits, bot.limits.perProject, bot.limits.total, bot.pid, bot.queued, bot.running, bot.startedAt, bot.tick
- PASS jv task show --json: every key of the skills runtime is kept (0.0 s): 95 keys in the skills runtime, 96 in this jv; added: origin
- PASS jv report --json: every key of the skills runtime is kept (0.0 s): 24 keys in the skills runtime, 24 in this jv

Notes:

- node <copy>/dist/cli.js status --help printed nothing (exit 0): dist/cli.js only exports main(), so the journey calls it through a driver
- DIFF jv status --help

  ```
    skills runtime: jv status [--project N]
    this jv:        jv status [--project N] [--watch]
    reason: brief section 4: jv status gains --watch
  ```
- DIFF jv task --help

  ```
    skills runtime: jv task create|show|message|answer|stop|resume|override ...  (create: --project N --kind K [--duty D] --title T (--text ... | --file F) [--parent T] [--after T] [--visible])
    this jv:        jv task create|show|list|changes|message|answer|stop|resume|override ...  (create: --project N --kind K [--duty D] --title T (--text ... | --file F) [--parent T] [--after T] [--visible]; list: [--project N] [--state S] [--limit N]; changes: T [--stat])
    reason: brief section 4: jv task gains list and changes
  ```
- DIFF jv coordinator --help

  ```
    skills runtime: jv coordinator start|stop|restart|status --project N
    this jv:        jv coordinator start|stop|restart|status --project N | jv coordinator message --project N "text"
    reason: brief section 4: jv coordinator gains message
  ```
- jv --help: lines only in this jv: jv status [--project N] [--watch] | jv task create|show|list|changes|message|answer|stop|resume|override ...  (create: --project N --kind K [--duty D] --title T (--text ... | --file F) [--parent T] [--after T] [--visible]; list: [--project N] [--state S] [--limit N]; changes: T [--stat]) | jv coordinator start|stop|restart|status --project N | jv coordinator message --project N "text" | jv memory add|search|list|archive|export  (add: --scope global|project [--project N] --kind K [--tag t]... "text")
- commands only in this jv (not compared): memory
- version lines (expected to differ): skills runtime "jv 0.1.0

  ```
  store schema 1 (no store yet at /Users/ggomes/.jv-test/m02-20261101t184820z-1190/help-home/store.sqlite)", this jv "jevellan 0.1.0 (store schema 2, skills not installed)"
  ```
- DIFF status --json: "bot" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.alive" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.heartbeatAgeSeconds" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.heartbeatAt" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.limits" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.limits.perProject" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.limits.total" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.pid" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.queued" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.running" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.startedAt" only in this jv; reason: brief section 4: the status header gains the bot line
- DIFF status --json: "bot.tick" only in this jv; reason: brief section 4: the status header gains the bot line
- status --json: arrays empty in both outputs, element keys not compared: lost[]
- DIFF task show --json: "origin" only in this jv; reason: brief section 3: tasks.origin (store schema 2)
- task show --json: arrays empty in both outputs, element keys not compared: children[], landings[]
- after this jv: store schema 2, /Users/ggomes/.jv-test/m02-20261101t184820z-1190/home/store.sqlite.v1.bak schema 1
- skills runtime on the migrated store: exit 2, store schema version 2 does not match this runtime (1); run jv update

## M3 Store compatibility

Status: pass. 11 of 11 checks passed in 20 s; ran 2026-11-01 18:47:31 UTC to 2026-11-01 18:47:51 UTC on Goncalos-MacBook-Pro.local, commit 1e0fbcf, mode: real providers and Jev in a temporary JV_HOME. From an earlier run (not run this time).

Checks:

- PASS temporary home seeded from ~/.jv (providers.json, secrets mode 600, seeds.json) (0.0 s): 3 secret files (claude-main.token, claude-second.token, jev.key), seeds for claude-main, claude-second, disabled codex
- PASS skills runtime bootstraps the temporary home (from a temporary copy) (5.5 s): /Users/ggomes/.jv-test/m03-20261101t184731z-001b/jevellan-skills at bcf93d2, 5 s
- PASS skills runtime: jv project add (the sandbox clone) (0.9 s): PZD9EET jv-mono-sandbox-clone at /Users/ggomes/jevellan-projects/jv-mono-sandbox-clone
- PASS skills runtime: jv task create --kind single --duty answer "Reply with the word ready." (3.1 s): TM1NPT6 running: step 1 of 1 (answer) on claude-haiku-5-5 low on claude-main (llm)
- PASS the task ran to done within 10 minutes (0.0 s): done: step answer done
- PASS the skills runtime left a schema 1 store with the task done and its report (0.0 s): schema 1, TM1NPT6 done, 1 report(s)
- PASS this jv: jv status --json lists the task (0.1 s): TM1NPT6 under recent
- PASS migrated to schema 2 with store.sqlite.v1.bak (schema 1, the task in it) (0.0 s): store schema 2; backup schema 1, task done
- PASS this jv: jv task show T --json shows the same task (0.1 s): TM1NPT6 done, 1 step(s), report done
- PASS the skills runtime on the migrated store: recorded, the store unharmed (0.1 s): refuses, exit 2; store schema 2 afterwards, this jv status exit 0
- PASS no secret in the store, WAL, backup or logs of the temporary home (0.0 s): 3 key files against 4 paths

Notes:

- mode: real providers and Jev in a temporary JV_HOME
- cloned /Users/ggomes/jevellan-projects/jv-mono-sandbox to /Users/ggomes/jevellan-projects/jv-mono-sandbox-clone (push URL /nonexistent/no-push)
- skills runtime on the migrated store: refuses (exit 2: store schema version 2 does not match this runtime (1); run jv update)

## M4 One task end to end

Status: not written yet.

## M5 Queue under the bot

Status: not written yet.

## M6 UI actions

Status: not written yet.

## M7 Coordinator chat

Status: not written yet.

## M8 A2UI

Status: not written yet.

## M9 MCP

Status: not written yet.

## M10 Memory

Status: not written yet.

## M11 Scheduler

Status: not written yet.

## M12 Planner

Status: not written yet.

## M13 Bot recovery

Status: not written yet.

## M14 Service file

Status: not written yet.

## M15 Phone

Status: not written yet.

## M16 No leaks

Status: not written yet.

## M17 Member untouched

Status: not written yet.
