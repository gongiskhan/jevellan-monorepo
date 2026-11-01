# Acceptance results

Written by `acceptance/run-all.mjs` at 2026-11-01 22:23:58 UTC on Goncalos-MacBook-Pro.local, checkout `/Users/ggomes/dev/jevellan-monorepo` at e544bc7. Journeys are the ones of brief section 14; each section below lists the journey's own checks (PASS or FAIL, with the time each took) and notes, from `acceptance/results/<journey>.json`.

| Journey | Title | Status | Elapsed | Ran at | Mode |
| --- | --- | --- | --- | --- | --- |
| M1 | Install | pass | 22 s | 2026-11-01 22:06:51 UTC | real home /Users/ggomes/.jv |
| M2 | Command parity | pass | 9 s | 2026-11-01 22:07:00 UTC | temporary JV_HOME, made-up providers, no model |
| M3 | Store compatibility | pass | 29 s | 2026-11-01 22:07:30 UTC | real providers and Jev in a temporary JV_HOME |
| M4 | One task end to end | pass | 52 s | 2026-11-01 22:08:23 UTC | real providers in a temporary JV_HOME |
| M5 | Queue under the bot | pass | 1 min 58 s | 2026-11-01 22:10:21 UTC | real providers in a temporary JV_HOME, the sandbox clone |
| M6 | UI actions | pass | 1 min 21 s | 2026-11-01 22:23:58 UTC | real providers in a temporary JV_HOME, the sandbox clone, jv ui in headless Chromium |
| M7 | Coordinator chat | pass | 32 s | 2026-11-01 22:22:08 UTC | real coordinator (claude-main) in a temporary JV_HOME, UI on a free port |
| M8 | A2UI | pass | 35 s | 2026-11-01 22:12:54 UTC | real providers in a temporary JV_HOME |
| M9 | MCP | pass | 9 s | 2026-11-01 22:13:03 UTC | Claude Code (owner login) over stdio, HTTP on a free port |
| M10 | Memory | pass | 1 min 11 s | 2026-11-01 22:14:15 UTC | real providers in a temporary JV_HOME, part all |
| M11 | Scheduler | pass | 2 min 00 s | 2026-11-01 22:16:15 UTC | real providers in a temporary JV_HOME |
| M12 | Planner | pass | 2 min 08 s | 2026-11-01 22:18:24 UTC | real providers in a temporary JV_HOME |
| M13 | Bot recovery | pass | 43 s | 2026-11-01 22:19:07 UTC | real providers in a temporary JV_HOME, the sandbox clone |
| M14 | Service file | pass | 1 s | 2026-11-01 22:19:08 UTC | a temporary JV_HOME and owner home |
| M15 | Phone | pass | 18 s | 2026-11-01 22:19:26 UTC | real providers in a temporary JV_HOME, jv ui on 100.108.210.116 |
| M16 | No leaks | pass | 0 s | 2026-11-01 22:19:27 UTC | the real ~/.jv and this checkout |
| M17 | Member untouched | pass | 23 s | 2026-11-01 22:19:49 UTC | this machine |

Totals: 17 pass.

## M1 Install

Status: pass. 11 of 11 checks passed in 22 s; ran 2026-11-01 22:06:29 UTC to 2026-11-01 22:06:51 UTC on Goncalos-MacBook-Pro.local, commit 35f5213, mode: real home /Users/ggomes/.jv. From an earlier run (not run this time).

Checks:

- PASS Node 22.22.0 at /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node (0.0 s): v22.22.0
- PASS npm ci at the checkout (7.2 s): 7 s
- PASS npm run build at the checkout (4.3 s): 4 s
- PASS build output present (0.0 s): /Users/ggomes/dev/jevellan-monorepo/packages/cli/dist/bin.js
- PASS jv bootstrap --skills /Users/ggomes/dev/jevellan-skills (0.2 s): 14 skills unchanged, skills 0.1.0 at bcf93d2, node /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node
- PASS runtime link points at the checkout (M-007) (0.0 s): /Users/ggomes/.jv/runtime -> /Users/ggomes/dev/jevellan-monorepo/packages/core
- PASS jv --version prints the three versions (0.6 s): jevellan 0.1.0 (store schema 2, skills 0.1.0)
- PASS the shim execs Node 22.22.0 on the checkout CLI (D-001, D-024) (0.0 s): exec /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node --disable-warning=ExperimentalWarning /Users/ggomes/dev/jevellan-monorepo/packages/cli/dist/bin.js
- PASS jv doctor --json answers (through the shim) (9.6 s): 38 lines, exit 0
- PASS the shim runs Node 22.22.0 (doctor node line) (0.0 s): OK Node 22.22.0
- PASS jv doctor: every line OK or an allowed WARN (0.0 s): 33 OK; 5 allowed WARN (models:ollama: Ollama without models; key:glm: provider without key file; key:deepseek: provider without key file; key:kimi: provider without key file; login:glm: provider without key file)

Notes:

- mode: real home /Users/ggomes/.jv

## M2 Command parity

Status: pass. 30 of 30 checks passed in 9 s; ran 2026-11-01 22:06:51 UTC to 2026-11-01 22:07:00 UTC on Goncalos-MacBook-Pro.local, commit d720c78, mode: temporary JV_HOME, made-up providers, no model. From an earlier run (not run this time).

Checks:

- PASS skills runtime built in a temporary copy (5.5 s): /Users/ggomes/.jv-test/m02-20261101t220651z-26e6/jevellan-skills at bcf93d2: npm ci 4 s, tsc 1 s
- PASS jv doctor --help (0.2 s): identical
- PASS jv project --help (0.2 s): identical
- PASS jv providers --help (0.2 s): identical
- PASS jv status --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 4: jv status gains --watch
- PASS jv task --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 4: jv task gains list and changes
- PASS jv land --help (0.2 s): identical
- PASS jv report --help (0.2 s): identical
- PASS jv tail --help (0.2 s): identical
- PASS jv attach --help (0.2 s): identical
- PASS jv ui --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 7: jv ui gains --readonly and --password-reset
- PASS jv coordinator --help (0.2 s): differs, every flag and subcommand kept; reason: brief section 4: jv coordinator gains message
- PASS jv handoff --help (0.2 s): identical
- PASS jv notes --help (0.2 s): identical
- PASS jv evals --help (0.2 s): identical
- PASS jv usage --help (0.2 s): identical
- PASS jv gc --help (0.2 s): identical
- PASS jv --help lists every command line of the skills runtime (0.1 s): 22 lines, 4 changed with their command, 11 added
- PASS skills runtime: jv project add (made-up providers, throwaway repository) (0.1 s): PB2KP45 at /Users/ggomes/.jv-test/m02-20261101t220651z-26e6/project
- PASS skills runtime: tasks, runs, report written through its dist modules (0.0 s): T1 TX7N1EK (waiting-owner, report on R9F8713), T2 TG3MXFA (running, R4F7Q3N queued), T3 T7G0D2F (done)
- PASS the store is schema 1 before this jv opens it (0.0 s): schema_version 1
- PASS skills runtime: jv status --json (0.1 s): 4 top-level keys
- PASS skills runtime: jv task show TX7N1EK --json (0.1 s): 23 top-level keys
- PASS skills runtime: jv report R9F8713 --json (0.1 s): 14 top-level keys
- PASS this jv: jv status --json (0.1 s): 5 top-level keys
- PASS this jv: jv task show TX7N1EK --json (0.1 s): 24 top-level keys
- PASS this jv: jv report R9F8713 --json (0.1 s): 14 top-level keys
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
- DIFF jv ui --help

  ```
    skills runtime: jv ui [--port 7071] [--bind ADDRESS]
    this jv:        jv ui [--port 7071] [--bind 127.0.0.1] [--readonly] [--password-reset]
    reason: brief section 7: jv ui gains --readonly and --password-reset
  ```
- DIFF jv coordinator --help

  ```
    skills runtime: jv coordinator start|stop|restart|status --project N
    this jv:        jv coordinator start|stop|restart|status --project N | jv coordinator message --project N "text"
    reason: brief section 4: jv coordinator gains message
  ```
- jv --help: lines only in this jv: jv status [--project N] [--watch] | jv task create|show|list|changes|message|answer|stop|resume|override ...  (create: --project N --kind K [--duty D] --title T (--text ... | --file F) [--parent T] [--after T] [--visible]; list: [--project N] [--state S] [--limit N]; changes: T [--stat]) | jv ui [--port 7071] [--bind 127.0.0.1] [--readonly] [--password-reset] | jv coordinator start|stop|restart|status --project N | jv coordinator message --project N "text" | jv memory add|search|list|archive|export  (add: --scope global|project [--project N] --kind K [--tag t]... "text") | jv goal add|list|show|done|pause ...  (add: --project N --title T --text "..." [--priority 1..5]; list: [--project N] [--state S]) | jv job run <kind> --project N [--force] | jv job list [--project N] | jv job show|cancel J | jv improve memory|docs|skills --project N [--force] | jv mcp [--stdio] [--http [--port 7072] [--bind 127.0.0.1]] [--token-reset] | jv bot start|stop|status|tick|install-service | jv schedule add|list|show|run|pause|resume ...  (add: --project N --name "..." --cron "..." [--tz Z] (--task-kind K [--duty D] --title T --text "..." [--visible] | --job J); list: [--project N]; show|run|pause|resume: S [--project N])
- commands only in this jv (not compared): memory, goal, job, improve, mcp, bot, schedule
- version lines (expected to differ): skills runtime "jv 0.1.0

  ```
  store schema 1 (no store yet at /Users/ggomes/.jv-test/m02-20261101t220651z-26e6/help-home/store.sqlite)", this jv "jevellan 0.1.0 (store schema 2, skills not installed)"
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
- after this jv: store schema 2, /Users/ggomes/.jv-test/m02-20261101t220651z-26e6/home/store.sqlite.v1.bak schema 1
- skills runtime on the migrated store: exit 2, store schema version 2 does not match this runtime (1); run jv update

## M3 Store compatibility

Status: pass. 11 of 11 checks passed in 29 s; ran 2026-11-01 22:07:01 UTC to 2026-11-01 22:07:30 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers and Jev in a temporary JV_HOME. From an earlier run (not run this time).

Checks:

- PASS temporary home seeded from ~/.jv (providers.json, secrets mode 600, seeds.json) (0.0 s): 3 secret files (claude-main.token, claude-second.token, jev.key), seeds for claude-main, claude-second, disabled codex
- PASS skills runtime bootstraps the temporary home (from a temporary copy) (5.3 s): /Users/ggomes/.jv-test/m03-20261101t220701z-4499/jevellan-skills at bcf93d2, 5 s
- PASS skills runtime: jv project add (the sandbox clone) (0.3 s): PBC3E0M jv-mono-sandbox-clone at /Users/ggomes/jevellan-projects/jv-mono-sandbox-clone
- PASS skills runtime: jv task create --kind single --duty answer "Reply with the word ready." (8.0 s): TX3VYKR running: step 1 of 1 (answer) on claude-haiku-5-5 low on claude-main (llm)
- PASS the task ran to done within 10 minutes (0.0 s): done: step answer done
- PASS the skills runtime left a schema 1 store with the task done and its report (0.0 s): schema 1, TX3VYKR done, 1 report(s)
- PASS this jv: jv status --json lists the task (0.1 s): TX3VYKR under recent
- PASS migrated to schema 2 with store.sqlite.v1.bak (schema 1, the task in it) (0.0 s): store schema 2; backup schema 1, task done
- PASS this jv: jv task show T --json shows the same task (0.1 s): TX3VYKR done, 1 step(s), report done
- PASS the skills runtime on the migrated store: recorded, the store unharmed (0.1 s): refuses, exit 2; store schema 2 afterwards, this jv status exit 0
- PASS no secret in the store, WAL, backup or logs of the temporary home (0.0 s): 3 key files against 4 paths

Notes:

- mode: real providers and Jev in a temporary JV_HOME
- skills runtime on the migrated store: refuses (exit 2: store schema version 2 does not match this runtime (1); run jv update)

## M4 One task end to end

Status: pass. 5 of 5 checks passed in 52 s; ran 2026-11-01 22:07:31 UTC to 2026-11-01 22:08:23 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME. From an earlier run (not run this time).

Checks:

- PASS jv task create --kind single --duty investigate on the sandbox (9.4 s): TASQ2SW: started
- PASS Jev placed it: a placement decision row with probabilities (0.0 s): D4EHVM6 by jev-1.14.0: claude-opus-5-5 medium on claude-main
- PASS the step runs to done and its report is in the store with the native session id (40.5 s): TASQ2SW done; RB8HDYM native 0329baba-3b38-47cb-9beb-89a427cd8a5e; report done: **Answer:** `invoiceTotalCents` computes an invoice total. It is in `src/invoices/index.ts:3`.

  ```
  
  **What the code shows:**
  ```
- PASS /t/<id> in the UI shows the report (1.2 s): page shows invoiceTotalCents, computes, invoice, invoiceTotalCents
- PASS no secret in the store, its WAL, the logs or the evidence of the temporary home (0.0 s): 3 key files against 3 paths

Notes:

- worktrees removed from the sandbox: 1

## M5 Queue under the bot

Status: pass. 7 of 7 checks passed in 1 min 58 s; ran 2026-11-01 22:08:23 UTC to 2026-11-01 22:10:21 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME, the sandbox clone. From an earlier run (not run this time).

Checks:

- PASS the coordinator starts for the clone (1.6 s): session RT3VXZB
- PASS the bot starts (0.2 s): pid 9552
- PASS three feature tasks created at once through jv_task_create over the MCP (stdio) (4.5 s): TDJR7VP, TJPWGNC, TQGY0TC
- PASS two are admitted; the third waits with reason "waiting for a slot" (0.0 s): running TDJR7VP, TJPWGNC; queued TQGY0TC: waiting for a slot
- PASS the third starts when a slot frees (60.1 s): TQGY0TC running
- PASS all three land (route land) or are asked with a stated reason (50.1 s): TDJR7VP done, TJPWGNC done, TQGY0TC done
- PASS the coordinator received the wake lines (0.0 s): 5 coordinator events; tasks named in wake lines: TDJR7VP, TJPWGNC

Notes:

- temporary home /Users/ggomes/.jv-test/m05-20261101t220823z-1727/home; limits perProject 2, total 2; codex disabled
- TDJR7VP How to run the unit tests (20261101t220823z-1727): done landed 8f4f1c57c3 (route land, landed: landed 8f4f1c57c33c on main (merge --ff-only); checks passed: test); 47 s
- TJPWGNC Three short contribution rules (20261101t220823z-1727): done landed 9f83d8eeac (route land, landed: landed 9f83d8eeacc1 on main (merge --ff-only); checks passed: test); 59 s
- TQGY0TC Unit test: invoice total of no lines is zero (20261101t220823z-1727): done landed 064cb795a6 (route land, landed: landed 064cb795a615 on main (merge --ff-only); checks passed: test); 101 s
- worktrees removed from the clone: 3

## M6 UI actions

Status: pass. 11 of 11 checks passed in 1 min 21 s; ran 2026-11-01 22:22:38 UTC to 2026-11-01 22:23:58 UTC on Goncalos-MacBook-Pro.local, commit e544bc7, mode: real providers in a temporary JV_HOME, the sandbox clone, jv ui in headless Chromium.

Checks:

- PASS jv task create --kind single --duty implement on the sandbox clone (3.3 s): TK84P3X: started RDSMS3F
- PASS the step reports needs-decision "Which colour?" with the options Blue and Green and the task waits on the owner (9.4 s): TK84P3X waiting-owner: step 1 (implement): needs-decision: Which colour?; run RDSMS3F on claude-sdk (claude-main, claude-sonnet-5-5 medium) native 74b76000-80c6-4de9-9843-3a1038537450; report needs-decision: "Which colour?" ["Blue","Green"]
- PASS /t/<id> shows the question with Blue and Green as buttons (0.1 s): question "Which colour?"; buttons ["Blue","Green"]
- PASS the Changes modal shows the committed diff against the base and the uncommitted file marked (1.7 s): bar "jv/ask-the-owner-which-colour-k84p3x against 064cb795a615 · 2 changed files · 1 uncommitted"; rows "A notes/m06-committed.txt +1 -0" and "A notes/m06-uncommitted.txt uncommitted +1 -0"; diffs ["+committed before the question"] and ["+left uncommitted until the answer"] ("notes/m06-uncommitted.txt (uncommitted)"); git diff base...branch: notes/m06-committed.txt
- PASS clicking Blue records jv task answer and the step continues on the same native session (0.2 s): POST {"answer":"Blue"} -> 200; message MS56B5S answer "Blue"; run RHT76MR (answer:MS56B5S) native 74b76000-80c6-4de9-9843-3a1038537450
- PASS Stop from the action bar stops the running turn; the task says resume continues it (1.5 s): POST {} -> 200; run RHT76MR stopped (stopped by the owner); its process 26008 ended; end event {"status":"stopped","reason":"stopped by the owner","report":null}; task running: RHT76MR stopped by the owner; jv task resume TK84P3X continues
- PASS Override offers the providers.json menu and records the pick on the step (mode keep) (1.3 s): menu claude-main: claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5; claude-second: claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5, claude-haiku-5-5; glm: glm-5.3; deepseek: deepseek-chat; kimi: kimi-k2-turbo-preview; ollama: qwen3:8b (matches providers.json: true); efforts offered As the policy says, low, medium, high, xhigh, max; providers offered Any that serves the model, claude-main, claude-second; POST {"model":"claude-opus-5-5","mode":"keep","effort":"low","provider":"claude-main"} -> 200; decision DWWQCNG override_mode keep {"source":"owner","runtime":"claude-sdk","provider":"claude-main","model":"claude-opus-5-5","effort":"low","effortRequested":"low","at":"2026-11-01T22:22:55.901Z"}; runs 2 -> 2
- PASS Resume from the action bar starts a turn on the same native session (0.1 s): POST -> 200 {"how":"native","session":"R8XRC9F"}; run R8XRC9F (resume:RHT76MR) starting native 74b76000-80c6-4de9-9843-3a1038537450
- PASS the step finishes with notes/colour.txt on the branch saying Blue (61.8 s): TK84P3X done: step implement done; notes/colour.txt on jv/ask-the-owner-which-colour-k84p3x: "Blue"; last report R8XRC9F done: You chose Blue. After the 45-second wait, I created notes/colour.txt containing "Blue". I committed it together with notes/m06-uncommitted.txt as "Record the ch; runs RDSMS3F done, RHT76MR stopped, R8XRC9F done (one native session: true)
- PASS no secret in the store, its WAL, the logs or the evidence of the temporary home (0.0 s): 3 key files against 3 paths
- PASS the sandbox clone is on main with a clean status (0.0 s): main; status clean

Notes:

- temporary home /Users/ggomes/.jv-test/m06-20261101t222238z-54dd/home; codex disabled: codex
- Jev placed the step on claude-sdk (claude-main, claude-sonnet-5-5 medium)
- worktrees removed from the clone: 1

## M7 Coordinator chat

Status: pass. 13 of 13 checks passed in 32 s; ran 2026-11-01 22:21:36 UTC to 2026-11-01 22:22:08 UTC on Goncalos-MacBook-Pro.local, commit 45beced, mode: real coordinator (claude-main) in a temporary JV_HOME, UI on a free port. From an earlier run (not run this time).

Checks:

- PASS jv coordinator start on the sandbox: running in tmux jv-coord-jv-mono-sandbox, screen ready (1.2 s): session RYV7HAP (Claude session 0ad9ce31-781c-48c5-b9c5-5dc6db45a3ca), claude-main claude-opus-5-5 high, screen ready, Remote Control unavailable
- PASS the pane runs this run's jv exec and claude, on the temporary home's prompt (0.0 s): pane pid 24154: jv exec pid 24154, claude pid 24194
- PASS the project page shows the running coordinator and the composer (0.0 s): chip "coordinator running", composer "Message the coordinator"
- PASS the page shows the coordinator's first status reply (to jv coordinator message "status") (14.6 s): 1 text(s), 1 tool call(s), responseMs 7890; page shows "Nothing is open on jv-mono-sandbox. No tasks are waiting on you, none are running, nothing has landed today and nothing has failed. The only"
- PASS the coordinator's Claude runs with HOME the temporary provider home (its transcript is there, not under ~/.claude) (0.0 s): transcript <home>/homes/claude-main/.claude/projects/-Users-ggomes-jevellan-projects-jv-mono-sandbox/0ad9ce31-781c-48c5-b9c5-5dc6db45a3ca.jsonl; ~/.claude/projects copy none
- PASS the composer's "status" reaches the tmux window (capture-pane shows the owner line, Claude Code received it once) (0.2 s): pane shows "[owner]  status" 1 time(s) (was 1); Claude Code's transcript owner entries 1 -> 2; message MBD7J4N typed 0.0 s after Enter (typed); page owner lines 1 -> 2
- PASS the coordinator's reply appears in the page within 10 s of the composer's Enter (12.3 s): reply visible 6.2 s after Enter (first text 6.2 s; 1 text(s), 1 tool call(s)); coordinator responseMs 5289; page overhead 0.9 s; "I just checked again and nothing has changed. There are no tasks: nothing waiting on you, nothing running, nothing landed today and nothing "
- PASS the response time is shown at the end of the turn and matches the store and the measured time (0.0 s): shows "22:21 · 5 s" (store responseMs 5289 = "5 s", reply at 22:21); measured in the page 6.2 s, overhead 0.9 s
- PASS no secret of the home in the store, its WAL or the logs (0.0 s): 3 key files against 3 paths
- PASS the coordinator's tmux session is gone after jv coordinator stop (0.0 s): stop exit 0, ended by /exit; tmux gone
- PASS the owner's ~/.claude.json has the same sha1 before the start and after the stop (0.0 s): sha1 94ad1e8d61f2 unchanged
- PASS the coordinator left no mark in the owner's ~/.claude.json: no Claude Code start counted, the sandbox entry unchanged, its session id absent (0.0 s): numStartups 4516 -> 4516; projects["~/jevellan-projects/jv-mono-sandbox"] unchanged; session id 0ad9ce31-781c-48c5-b9c5-5dc6db45a3ca absent
- PASS the sandbox is left on main with a clean status and no worktree of this run (0.0 s): branch main, clean, 0 worktree(s) of this run

Notes:

- sandbox before: branch main, clean
- temporary home /Users/ggomes/.jv-test/m07-20261101t222136z-68c1/home
- screenshots acceptance/shots/m07-project-chat-1280x800-light.png and -dark.png
- first turn: responseMs 7890, 1 text(s), 1 tool call(s)
- composer turn: reply visible 6.2 s after Enter, first text 6.2 s, coordinator responseMs 5289
- tasks on the sandbox after the turns: 0
- jv coordinator stop: exit 0, stopped with /exit
- worktrees removed from the sandbox: 0

## M8 A2UI

Status: pass. 23 of 23 checks passed in 35 s; ran 2026-11-01 22:12:18 UTC to 2026-11-01 22:12:54 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME. From an earlier run (not run this time).

Checks:

- PASS two read-only single investigate tasks on the sandbox: the fixture one and the one with its own surface (4.4 s): TRTN7SD: started; T0M01W0: started
- PASS fixture: the step asks its question and the task waits on the owner (9.4 s): TRTN7SD waiting-owner: step 1 (investigate): needs-decision: Which fruit should the fixture use?; report needs-decision: Which fruit should the fixture use? [Apple, Pear, Plum], native cc3abb39-2d7c-4ccb-93a3-38813563ac17
- PASS fixture: the report gets the fixture ui (a v0.9 surface and one "1.0" message) in ui_json (0.1 s): EVCCVXS: 4 messages (v0.9 createSurface, v0.9 updateComponents, v0.9 updateDataModel, 1.0 createSurface); the step's own ui_json was empty
- PASS jv ui starts on a free port and a headless page signs in at 1280 by 800 (1.1 s): http://127.0.0.1:50999
- PASS fixture: /t/<id> renders the ChoicePicker and the Button under "From the step" (0.9 s): radios Apple (picked), Pear, Plum; title shown
- PASS fixture: the "1.0" message shows "UI not rendered: unsupported version" and the rest of the report is intact (0.0 s): notice shown; summary 1, question 1, native options [Apple, Pear, Plum], status "needs a decision", v0.9 picker options 3
- PASS fixture: no sideways scroll at 390 by 844 dark (0.0 s): none
- PASS fixture: pressing Send posts the renderer's action to /api/tasks/TRTN7SD/ui-action (0.0 s): HTTP 200, action {"name":"answer","surfaceId":"fruit-choice","sourceComponentId":"send","timestamp":"2026-11-01T22:12:36.833Z","context":{"label":"Pear"}}; server answer Pear, run R5K0Z6K; native answer posts 0
- PASS fixture: a messages row with the raw action in meta_json (0.0 s): MFHD24M answer "Pear", meta_json {"name":"answer","surfaceId":"fruit-choice","sourceComponentId":"send","timestamp":"2026-11-01T22:12:36.833Z","context":{"label":"Pear"}}
- PASS fixture: the surface is dimmed and inert with "Sent to the step at HH:MM" (0.3 s): "Sent to the step at 22:12" (now 22:12), class "jv-a2ui sent", inert true, opacity 0.583875
- PASS fixture: the step's next turn starts with "From the owner: Pear" in its prompt (0.0 s): R5K0Z6K running, resume true, native same; message event: "From the owner: Pear"
- PASS fixture: the message is marked delivered to that run when the turn ends (3.0 s): delivered at 2026-11-01T22:12:40.995Z to R5K0Z6K
- PASS fixture: the step answers it: the task ends done and its final report names Pear (0.1 s): TRTN7SD done: step investigate done; report done: The owner picked Pear.
- PASS fixture: after a reload the surface still shows as sent (from the message's meta), at the message's time, with Pear picked (0.9 s): task done; "Sent to the step at 22:12" (message at 22:12), class "jv-a2ui sent", inert true, opacity 0.55, Pear picked
- PASS real step: it reports needs-decision with its own ui (three v0.9 messages, nothing dropped) (0.1 s): T0M01W0 waiting-owner: step 1 (investigate): needs-decision: Which colour should the sandbox badge use?; report needs-decision, ui 3 messages (as given), options [Teal, Amber, Violet]
- PASS real step: /t/<id> renders the step's ChoicePicker and Button (0.8 s): radios Teal, Amber, Violet; notices none
- PASS real step: pressing Send posts the renderer's action to /api/tasks/T0M01W0/ui-action (0.0 s): HTTP 200, action {"name":"answer","surfaceId":"badge-colour","sourceComponentId":"send","timestamp":"2026-11-01T22:12:45.825Z","context":{"label":"Violet"}}; server answer Violet, run RW6TFCQ; native answer posts 0
- PASS real step: a messages row with the raw action in meta_json (0.0 s): MN8FCVE answer "Violet", meta_json {"name":"answer","surfaceId":"badge-colour","sourceComponentId":"send","timestamp":"2026-11-01T22:12:45.825Z","context":{"label":"Violet"}}
- PASS real step: the surface is dimmed and inert with "Sent to the step at HH:MM" (0.2 s): "Sent to the step at 22:12" (now 22:12), class "jv-a2ui sent", inert true, opacity 0.583859
- PASS real step: the step's next turn starts with "From the owner: Violet" in its prompt (0.0 s): RW6TFCQ running, resume true, native same; message event: "From the owner: Violet"
- PASS real step: the message is marked delivered to that run when the turn ends (6.0 s): delivered at 2026-11-01T22:12:53.082Z to RW6TFCQ
- PASS real step: the step answers it: the task ends done and its final report names Violet (0.1 s): T0M01W0 done: step investigate done; report done: The owner picked Violet.
- PASS no console error on the task pages (0.0 s): none

Notes:

- screenshots in /Users/ggomes/dev/jevellan-monorepo/acceptance/results/m08-shots; m08-fixture-1280x800-light.png and m08-sent-390x844-dark.png copied to acceptance/shots/
- worktrees removed from the sandbox: 2

## M9 MCP

Status: pass. 12 of 12 checks passed in 9 s; ran 2026-11-01 22:12:54 UTC to 2026-11-01 22:13:03 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: Claude Code (owner login) over stdio, HTTP on a free port. From an earlier run (not run this time).

Checks:

- PASS jevellan-mcp serves exactly the tools of section 5 (0.0 s): 34 tools, 16 read-only
- PASS Claude Code over stdio answers "Use jv_status and tell me how many projects there are" with 1 (8.4 s): There is one project: `jv-mono-sandbox`. It's at `/Users/ggomes/jevellan-projects/jv-mono-sandbox`, and its default branch is `main`. `jv_status` doesn't report projects, so I got the count from the p (3 turns, 8 s)
- PASS the stdio calls are in mcp.log: jv_status among them, jv tools only, exit 0 (0.0 s): jv_status 9ms exit=0; jv_project_list 6ms exit=0
- PASS jv mcp --http --json listens on 127.0.0.1:51067 and writes the token (mode 600) without printing it (0.2 s): http://127.0.0.1:51067/mcp, token written, mode 600
- PASS tools/list with the token returns every tool of section 5 (0.0 s): HTTP 200, 34 tools
- PASS without the token (or with a wrong one) 401 and no body (0.0 s): no token: 401 (0 bytes); wrong token: 401 (0 bytes)
- PASS GET /health answers 200 {"ok":true,"version":...} without a token; anything else 404 (0.0 s): 200 {"ok":true,"version":"0.1.0"}; /status 404
- PASS a tool call over HTTP: jv_status lists the projects (stateless: no initialize, no session) (0.0 s): HTTP 200; 1 of 1 projects
- PASS mcp.log: exactly one line for the one HTTP tool call (none for tools/list) (0.0 s): 2026-11-01T22:13:03.552Z jv_status 8ms exit=0
- PASS SIGTERM stopped jv mcp --http and removed its pid file (0.0 s): exit 0, pid file removed
- PASS mcp.log: one line per call, the format of section 5, none of the arguments (0.0 s): 3 lines
- PASS no secret of the home (the MCP token included) in the store, its WAL or the logs (0.0 s): 4 key files against 2 paths

Notes:

- temporary home /Users/ggomes/.jv-test/m09-20261101t221254z-3c03/home; seeded 3 secret files; codex disabled: codex

## M10 Memory

Status: pass. 12 of 12 checks passed in 1 min 11 s; ran 2026-11-01 22:13:03 UTC to 2026-11-01 22:14:15 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME, part all. From an earlier run (not run this time).

Checks:

- PASS a single investigate task asked to remember the setup runs to done (13.0 s): TT11XW0 done: step investigate done
- PASS the memory was written through jv_remember (kind environment, the project scope, source session:<R>) (0.0 s): M70SHS3 (environment, project:jv-mono-sandbox, session:RWCF9CK): The sandbox tests need `npm ci` run first (install dependencies) before the test command `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test`.
- PASS jv memory search "npm ci" finds it (0.1 s): found M70SHS3
- PASS memory.md of the project lists it (0.0 s): /Users/ggomes/.jv-test/m10-20261101t221303z-342e/home/projects/jv-mono-sandbox/memory.md
- PASS the next task's start event carries "What this project remembers:" with that memory (2.6 s): What this project remembers: / - (environment) The sandbox tests need `npm ci` run first (install dependencies) before the test command `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test`. [tests, setup, npm]
- PASS two near-duplicate memories added by hand (0.1 s): M04J4DB, M8XHMZ5
- PASS jv job run improve-memory creates the job (0.1 s): JG9E5KA queued
- PASS the bot ticks the job through its task to done (38.3 s): JG9E5KA done: merged 1, archived 0, added 1, expired 0, skipped 0; task TYAY106
- PASS the work was an improver task: single investigate, origin improver:<J>, done (0.0 s): TYAY106 single investigate improver:JG9E5KA done
- PASS one of the two is archived with superseded_by, none deleted, and result_json lists the merge (0.0 s): rows M04J4DB archived -> M8XHMZ5, M8XHMZ5 active; result {"merged":[{"keep":"M8XHMZ5","archived":["M04J4DB"]}],"archived":[],"added":["M90AXHF"],"expired":[],"skipped":[],"summary":"merged 1, archived 0, added 1, expired 0, skipped 0"}
- PASS jv memory list shows the archived one with --status archived, and nothing was deleted (0.1 s): archived M04J4DB; rows 2
- PASS no secret in the store, its WAL or the logs of the temporary home (0.0 s): 3 key files against 3 paths

Notes:

- temporary home /Users/ggomes/.jv-test/m10-20261101t221303z-342e/home; seeded 3 secret files; codex disabled: codex

## M11 Scheduler

Status: pass. 9 of 9 checks passed in 2 min 00 s; ran 2026-11-01 22:14:15 UTC to 2026-11-01 22:16:15 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME. From an earlier run (not run this time).

Checks:

- PASS jv schedule add: cron "* * * * *", a single answer task (0.2 s): CCWVA2N, next run 2026-11-01T22:15:00.000Z
- PASS jv bot start runs in the background and answers its health endpoint (0.2 s): pid 18168; {"ok":true,"heartbeatAgeSeconds":0,"running":0,"queued":0,"version":"0.1.0"}
- PASS a task with origin schedule:<id> exists within 75 s of the bot's start (48.2 s): TQ1MWNK "M11 scheduled answer 2026-11-01" after 48 s (queued: queued; the bot starts it when a slot is free)
- PASS the schedule's last_result names the task it created (0.2 s): last_result "created TQ1MWNK"; tasks TQ1MWNK
- PASS jv schedule pause, then 70 s with no new task of that origin (70.1 s): 1 task(s) at the pause, 1 after 70 s: TQ1MWNK
- PASS the nextRun unit tests include the 2026-10-25 DST change in Europe/Lisbon (0.0 s): /Users/ggomes/dev/jevellan-monorepo/packages/scheduler/test/cron.test.ts: 25 October (back) and 29 March (forward) in Europe/Lisbon
- PASS the scheduled tasks end (the bot admitted and ran them) (0.1 s): TQ1MWNK done
- PASS jv bot stop ends the bot with exit 0 and releases the lock (0.4 s): stop 0 {"stopped":true,"pid":18168,"reason":"SIGTERM","waitedMs":205}; bot exit 0; lock gone
- PASS the bot log names the firing; no secret in the store, its WAL or the logs (0.0 s): fired in bot.log: true; 3 key files against 2 paths

Notes:

- temporary home /Users/ggomes/.jv-test/m11-20261101t221415z-c5d3/home; codex disabled: codex; tick 15 s; health port 51236
- worktrees removed from the sandbox: 0

## M12 Planner

Status: pass. 10 of 10 checks passed in 2 min 08 s; ran 2026-11-01 22:16:15 UTC to 2026-11-01 22:18:24 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME. From an earlier run (not run this time).

Checks:

- PASS a goal for the sandbox (jv goal add) (0.2 s): G1ZHAKY Search customers by name
- PASS jv job run plan creates the job, queued, with the request id of the project and the day (0.1 s): JMBAZS8 queued plan:jv-mono-sandbox:2026-11-01
- PASS jv bot tick in a loop until the job ends: the plan task runs and the job is done (127.1 s): JMBAZS8 done: created 2, skipped 0; task TBXNSEZ
- PASS the plan task: kind single, duty plan, origin planner:<J>, request id job:<J>, not visible, done (0.0 s): TBXNSEZ single plan planner:JMBAZS8 job:JMBAZS8 visible 0 done
- PASS one to three tasks with origin planner:<J> are queued and not started; result_json lists them (0.0 s): TR19RFB feature queued (0 runs) Add case-insensitive customer name search to the customers module; TPSQ6FF feature queued (0 runs) Customers page: live name search box with 'No customers match' empty state, phone-friendly; result {"created":["TR19RFB","TPSQ6FF"],"skipped":[],"summary":"created 2, skipped 0"}
- PASS after links exactly where the plan proposed them (request id plan:<J>:<index>) (0.0 s): TPSQ6FF after TR19RFB
- PASS a second jv job run plan the same day returns the existing job: exit 0, the same id, nothing created (0.1 s): exit 0, JMBAZS8 created false; jobs 1 -> 1, tasks 4 -> 4
- PASS --force creates a new job (another id), which the journey then cancels (0.3 s): JB3FQ4H plan:jv-mono-sandbox:2026-11-01:force:2026-11-01T22:18:24.163Z; cancel exit 0: failed cancelled by the owner
- PASS the planned tasks are still queued and not started at the end (0.0 s): TR19RFB queued, TPSQ6FF queued; runs 0
- PASS no secret in the store, its WAL or the logs of the temporary home (0.0 s): 3 key files against 3 paths

Notes:

- temporary home /Users/ggomes/.jv-test/m12-20261101t221615z-8ba9/home; seeded 3 secret files; codex disabled: codex
- the plan job ended after 24 ticks in 127 s
- the plan proposed 2 tasks: 0 "Add case-insensitive customer name search to the customers module"; 1 "Customers page: live name search box with 'No customers match' empty state, phone-friendly" after 0

## M13 Bot recovery

Status: pass. 6 of 6 checks passed in 43 s; ran 2026-11-01 22:18:24 UTC to 2026-11-01 22:19:07 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME, the sandbox clone. From an earlier run (not run this time).

Checks:

- PASS a single implement task starts its step, and the run is running with a pid and a native session (7.7 s): TVMG82N run R0JKTRC pid 20786 on claude-sdk (claude-main, claude-sonnet-5-5), native 25a48c02-3944-43e9-b56b-65209f127628
- PASS its process group is killed by hand (12.3 s): SIGKILL to process group 20786; pid 20786 gone
- PASS one jv bot tick marks the run lost and starts a resume turn on the same native session (1.4 s): tick exit 0; lost ["R0JKTRC"]; R0JKTRC lost (process 20786 ended without an end event); recovery {"session":"R0JKTRC","task":"TVMG82N","action":"resumed","run":"RB4A37Z"}; resume run RB4A37Z native 25a48c02-3944-43e9-b56b-65209f127628 (resume:R0JKTRC)
- PASS with the bot running, the step finishes (20.2 s): step done after 2 runs (R0JKTRC lost, RB4A37Z done); task done: step implement done
- PASS jv bot stop ends the bot; the bot log names the lost run and its resume (0.4 s): stop 0; exit 0; last heartbeat 2026-11-01T22:19:01.685Z; bot.log names the resume: true
- PASS no secret in the store, its WAL or the logs of the temporary home (0.0 s): 3 key files against 3 paths

Notes:

- temporary home /Users/ggomes/.jv-test/m13-20261101t221824z-0c32/home; codex disabled: codex
- the step runs on claude-sdk
- worktrees removed from the clone: 1

## M14 Service file

Status: pass. 7 of 7 checks passed in 1 s; ran 2026-11-01 22:19:07 UTC to 2026-11-01 22:19:08 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: a temporary JV_HOME and owner home. From an earlier run (not run this time).

Checks:

- PASS jv bootstrap --skills /Users/ggomes/dev/jevellan-skills into the temporary home records the Node binary (0.2 s): nodePath /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node; cliEntry /Users/ggomes/dev/jevellan-monorepo/packages/cli/dist/bin.js
- PASS jv bot install-service writes the plist and prints the launchctl commands, loading nothing (0.2 s): /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/owner/Library/LaunchAgents/dev.jevellan.bot.plist (written); load: launchctl bootstrap gui/$(id -u) ~/.jv-test/m14-20261101t221907z-74c0/owner/Library/LaunchAgents/dev.jevellan.bot.plist; warnings: none
- PASS plutil -lint passes (0.0 s): /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/owner/Library/LaunchAgents/dev.jevellan.bot.plist: OK
- PASS the program is the Node 22.22.0 binary and the checkout's bin.js with bot start; the label, environment and keep-alive (0.0 s): program /Users/ggomes/.nvm/versions/node/v22.22.0/bin/node --disable-warning=ExperimentalWarning /Users/ggomes/dev/jevellan-monorepo/packages/cli/dist/bin.js bot start; PATH /Users/ggomes/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/bin:/Users/ggomes/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin; HOME /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/owner; JV_HOME /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/home; RunAtLoad true; KeepAlive true; log /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/home/logs/bot.launchd.log
- PASS a second run changes nothing (0.2 s): written false
- PASS a different file already there is archived under $JV_HOME/archive/service/ before the new one is written (0.2 s): archived at /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/home/archive/service/dev.jevellan.bot-20261101T221908Z.plist
- PASS launchctl list does not show dev.jevellan.bot (not loaded by the run) (0.0 s): 516 jobs listed; dev.jevellan.bot is not among them

Notes:

- temporary owner home /Users/ggomes/.jv-test/m14-20261101t221907z-74c0/owner

## M15 Phone

Status: pass. 10 of 10 checks passed in 18 s; ran 2026-11-01 22:19:08 UTC to 2026-11-01 22:19:26 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: real providers in a temporary JV_HOME, jv ui on 100.108.210.116. From an earlier run (not run this time).

Checks:

- PASS a cheap single answer task gives the pages something to show (10.1 s): TK8QGM0 done; session R8STWF4
- PASS jv ui --bind 100.108.210.116 starts on a free port (0.2 s): http://100.108.210.116:51600
- PASS login page at 390 by 844, light: renders its content, no horizontal scroll (0.9 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-login-390x844-light.png
- PASS project page at 390 by 844, light: renders its content, no horizontal scroll (1.1 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-project-390x844-light.png
- PASS task page at 390 by 844, light: renders its content, no horizontal scroll (0.8 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-task-390x844-light.png
- PASS session page at 390 by 844, light: renders its content, no horizontal scroll (0.7 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-session-390x844-light.png
- PASS login page at 390 by 844, dark: renders its content, no horizontal scroll (0.8 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-login-390x844-dark.png
- PASS project page at 390 by 844, dark: renders its content, no horizontal scroll (1.1 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-project-390x844-dark.png
- PASS task page at 390 by 844, dark: renders its content, no horizontal scroll (0.8 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-task-390x844-dark.png
- PASS session page at 390 by 844, dark: renders its content, no horizontal scroll (0.6 s): shows its content; no horizontal scroll; /Users/ggomes/dev/jevellan-monorepo/acceptance/shots/m15-session-390x844-dark.png

Notes:

- screenshots in acceptance/shots/ and /Users/ggomes/.jevellan-build/manager/shots
- worktrees removed from the sandbox: 0

## M16 No leaks

Status: pass. 2 of 2 checks passed in 0 s; ran 2026-11-01 22:19:26 UTC to 2026-11-01 22:19:27 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: the real ~/.jv and this checkout. From an earlier run (not run this time).

Checks:

- PASS no secret file content and no token variable in the store, logs, evidence or acceptance/ (0.2 s): 3 secret files, the UI password (none yet) and 2 token names against 3 paths
- PASS npm run scan:secrets passes on the repository (with the values of ~/.jv/secrets and the UI password) (0.2 s): Secret scan passed.

Notes:

- checked: ~/.jv/store.sqlite, ~/.jv/logs, ~/dev/jevellan-monorepo/acceptance

## M17 Member untouched

Status: pass. 3 of 3 checks passed in 23 s; ran 2026-11-01 22:19:27 UTC to 2026-11-01 22:19:49 UTC on Goncalos-MacBook-Pro.local, commit 560f1c3, mode: this machine. From an earlier run (not run this time).

Checks:

- PASS the member daemons kept their pids (0.0 s): dev.jevellan.daemon 79678 -> 79678, dev.jevellan.playground.daemon 821 -> 821
- PASS no file under the member folders changed since the start, except the daemons' own writes (22.6 s): 12 changed, 12 the daemons' own, 0 counted
- PASS the jevellan command was never run by jv (no jv code, test, script or journey calls it) (0.1 s): no call of the jevellan command in 510 files under :(glob)packages/**, bin, scripts, acceptance

Notes:

- written by the member daemon (listed, not counted): ~/.jevellan-member/locks/activity.json
- written by the member daemon (listed, not counted): ~/.jevellan-member/cleanup/last-run.json
- written by the member daemon (listed, not counted): ~/.jevellan-member/logs/daemon.log
- written by the member daemon (listed, not counted): ~/.jevellan-member/settings-sync.json
- written by the member daemon (listed, not counted): ~/.jevellan-member/rigging/application.json
- written by the member daemon (listed, not counted): ~/.jevellan-playground/locks/activity.json
- written by the member daemon (listed, not counted): ~/.jevellan-playground/cleanup/last-run.json
- written by the member daemon (listed, not counted): ~/.jevellan-playground/logs/daemon.log
- written by the member daemon (listed, not counted): ~/.jevellan-playground/settings-sync.json
- written by the member daemon (listed, not counted): ~/.jevellan-playground/rigging/application.json
- written by the member daemon (listed, not counted): ~/.jevellan-playground/hub/jevellan.db-wal
- written by the member daemon (listed, not counted): ~/.jevellan-playground/hub/jevellan.db
