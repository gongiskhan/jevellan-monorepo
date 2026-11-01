# Decisions

Choices the brief left open or that the machine forced, numbered M-001 onwards, append-only. A later decision amends
an earlier one by number; it never edits it. The D-numbers are the skills repository's (`gongiskhan/jevellan-skills`,
`docs/decisions.md`, D-001 to D-075 at the lifted commit) and every one of them holds here unless an M-number below
changes it.

## M-001 The lifted commit is jevellan-skills bcf93d2

The brief names `0716ce1` (390 unit tests, decisions D-001 to D-069). On 1 November the clone's `main` was one commit
further, `bcf93d2` ("Phase 10a: coordinator isolation and Remote Control path, landing wording, docs"), which adds
D-070 to D-075: the coordinator's `--setting-sources user` and AGENTS.md block, its own login and Remote Control, the
landing policy wording, doctor's Stop hook check of registered projects only, the `jv exec` signal race fix and the
takeover import. Each is a fix the monorepo would otherwise have to port later through `sync-from-skills.mjs`, so the
run lifts `bcf93d2`. The checkout at `~/dev/jevellan-skills` stays at that commit for the whole run (it is never
pulled again: the skills run on dev-madrid keeps committing), and the skills fixture test of section 11 pins it.

## M-002 TypeScript 5.9.3

The brief asks for "the same 5.x version the skills runtime's package.json pins; not 7". The skills runtime pins
`typescript` 7.0.2, so there is no 5.x to copy. The intent is a 5.x compiler, and 5.9.3 is both the newest 5.x on npm
and the version `gongiskhan/jevellan` (at 8e2788ec) and the sandbox pin. Phase 1 verifies that the lifted sources
compile with it, with `composite` and `declaration` on for project references.

## M-003 Lint dependencies

The brief lists the third-party dependencies with "nothing else", but also asks for `eslint.config.mjs` copied from
`gongiskhan/jevellan` and a `lint` script; that config imports `@eslint/js` and `typescript-eslint` and needs
`eslint`. The root package therefore has three more dev dependencies, at the exact versions Jevellan's lock file
resolves: `eslint` 9.39.5, `@eslint/js` 9.39.5, `typescript-eslint` 8.70.1. Nothing at run time depends on them.

## M-004 The sandbox's project.json commands

The brief sets `testCommand: npm test` and `devCommand: npm run dev`. The sandbox's bare `npm test` fails by design
in a clean environment ("SANDBOX_DATA_DIR is not set" and a time zone assertion), which D-066 found on dev-madrid and
phase 0 reproduced here, and its `package.json` has no `dev` script (its web server is `npm start`). Landing checks
and verify steps run these commands, so `jv-mono-sandbox` (and its clone) get `testCommand` `TZ=UTC
SANDBOX_DATA_DIR=.sandbox-data npm test` and `devCommand` `npm start`; `pushAfterLanding` stays false.

## M-005 The GitHub repository was created with gh

Section 12 creates the repository with the stored git credential and a raw API call because `gh` was signed out. At
the run `gh` was signed in as `gongiskhan`, so `gh api -X POST /user/repos` made it (HTTP 201, only the status
logged), with the brief's name, visibility and description. Pushes use the HTTPS remote and the git credential, as
the brief says.

## M-006 Playwright browsers for 1.63.0 and 1.64.1

`~/Library/Caches/ms-playwright` had chromium 1223 and 1234 only. The sandbox's `@playwright/test` 1.63.0 needs
chromium 1243 and this repository's `playwright` 1.64.1 needs 1248, so `playwright install --only-shell chromium`
of each version added the two headless shells to that folder (about 400 MB, a regenerable cache). Every test and
worker keeps `PLAYWRIGHT_BROWSERS_PATH` pointing at the folder.

## M-007 The checkout is the install (amends D-005, D-021 and D-024's runtime half)

The brief makes the monorepo checkout the install: `~/.jv/bin/jv` runs `<checkout>/packages/cli/dist/bin.js`. So
there are no versioned runtime folders any more (D-021's `runtimes/<id>`), no copy of the package into `~/.jv`, no
`npm ci` and `npm prune` inside it (D-005). What stays, and why:

- `$JV_HOME/runtime` is a symlink to `<checkout>/packages/core`, switched with one rename(2). D-008's Stop hook
  (`$JV_HOME/runtime/dist/report-guard.mjs`), D-016's `.jv` links, the APM hook's literal `node
  ~/.jv/runtime/dist/report-guard.mjs` and the policy skills' `evals/run.mjs` (`$JV_HOME/runtime/dist/evals.js`) all
  keep resolving, so neither the skills nor the provider homes need a change. A real folder or a link into another
  install there (the skills repository's own `runtimes/<id>`) is moved to `$JV_HOME/archive/runtimes/` first.
- `$JV_HOME/skills` keeps D-021's versioned skill sets (`skill-sets/<jv-version>-<hash>-<time>/`, switched
  atomically, current and previous kept, older ones archived), copied from a jevellan-skills checkout given with
  `--skills` (default `~/dev/jevellan-skills`). An unchanged skills tree (same hash) is not copied again.
- `install.json` records `checkout`, `cliEntry`, `core`, `nodePath`, `skillsSource`, `skillsCommit`,
  `skillsVersion` (the router's `jv-version`) and `skillsHash`.
- Detached processes core starts (`jv run`, `jv exec`) run `jvEntry()`: `JV_CLI_ENTRY` when set (the core tests
  point it at their own entry), else install.json's `cliEntry`, else the jevellan-cli package next to this
  jevellan-core, else the lifted `$JV_HOME/runtime/bin/jv.mjs`. jevellan-core cannot import the command layer, so
  this is a path, not an import.
- The bootstrap is TypeScript in `core/src/bootstrap.ts` (it returns a summary; `jv bootstrap` prints it) and keeps
  the lock, the 700 modes, the shim's `${JV_HOME:-}` rule (D-024) and seed(). `jv update` is the same from the
  recorded checkout, skills source and Node binary, and never opens the store.

## M-008 Package split of the lifted runtime

`packages/core` holds every lifted module except the command layer and the viewer; `packages/cli` holds `cli.ts`,
`command.ts` and `commands/*` (the `run(args, io)` shims that `doctor.ts` and `project.ts` exported moved there,
and the command table names `./commands/doctor.js` and `./commands/project.js`). jevellan-core exports its public
API from `src/index.ts` and every module by subpath (`jevellan-core/store`, `jevellan-core/jev/client`), so the
command modules import what they imported before, by package name. The lifted viewer (`src/ui/*.ts` and `ui/`)
moved to `packages/ui` (`server/` and `viewer/`) as the starting point of section 7; `jv ui` imports it from
`jevellan-ui/server`. Tests moved with their modules; the ones that drive the CLI (`jv tail`, `jv report`, `jv ui`
through `main`) moved to `packages/cli/test`. The skills the tests read come from `core/test/fixtures/skills/`
(section 11), not from a path above the package.

## M-009 macOS: real paths and process facts

The runtime was built and tested on Linux. On this machine the lifted suite failed 30 of 390 tests, for two reasons
that are real defects on any system with symlinked folders or without /proc, not test noise:

- `land-git.ts` `findWorktree` compared paths with `resolve()` only, while git lists worktrees by their real path, so
  every landing and gc refused with "not a registered worktree" when the path had a symlink in it (macOS's
  `/var -> /private/var`, or the owner's `~/dev` that links to `~/Projects`). It now compares with symlinks
  resolved as far as the path exists, as `git.ts` already did.
- `launcher.ts` and `coordinator.ts` read `/proc/<pid>/cmdline` and `/proc/<pid>/stat` for the command line, the
  zombie state and the process group. Without /proc a reused pid kept a dead run alive and no process group was
  known. `src/proc.ts` reads /proc on Linux and asks `ps -ww -o args=|stat=|pgid= -p <pid>` elsewhere.

The tests that built expected paths from `tmpdir()` (a symlink on macOS) now start from its real path, so they test
the code's own resolution, as on Linux.

## M-010 TypeScript target and lib

The brief's base config says ES2022. The lifted code uses `Array.prototype.findLast` (ES2023 lib), which Node 22
has, so `tsconfig.base.json` sets `target` ES2022 and `lib` ES2023, with `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, NodeNext, `declaration` and `composite` (project references, `tsc -b`). The lifted sources
compiled with TypeScript 5.9.3 under these settings without a change (M-002 verified).

## M-011 Store schema 2 and schema extensions

`SCHEMA_SQL` stays the skills repository's schema 1 byte for byte (a test compares `sqlite_master` with a store
that runtime created, `test/fixtures/schema-v1-master.json`). Schema 2 is `SCHEMA_V2_SQL`, the brief's section 3
statements without the version update. A version 1 store is copied once to `store.sqlite.v1.bak` with `VACUUM INTO`
(a consistent copy that includes the WAL; mode 600) and migrated in one `BEGIN IMMEDIATE` transaction that rechecks
the version inside. A store newer than this jv is refused with exit 2 "store schema <n> is newer than this jv (2);
update jv". jevellan-core depends on nothing in the repository, so the memory tables are a schema extension
(`registerSchemaExtension({name, present, ensure})`) that the jv CLI registers at process start (M-015): applied
inside the migration, on a new store, and on any open where `present` reads false. An up-to-date store is opened
without a write lock, as before.

## M-012 The coordinator conversation task is one per project, keyed by request id

The brief puts owner messages to the coordinator on "the sentinel task T000000 that migrate() creates once per
project", but `tasks.id` is the primary key, so one id cannot serve two projects. Each project gets its own task
(kind single, no steps, state done, origin coordinator, title "Coordinator conversation") with request id
`coordinator-conversation:<project id>` and a normal random id; the migration creates one per existing project,
`createProject` one per new project, and `store.coordinatorTask(projectId)` finds or creates it. `listTasks` leaves
these tasks out unless asked (`include_coordinator_tasks`), and the viewer's project query does too, so they never
show as work, never land, and are never counted.

## M-013 What holds a slot

`limits.ts` reads `limits` of bot.json leniently (defaults perProject 2, total 4; the bot validates the file). A task
holds a slot while it is in state running (a step runs, or its next step is being placed between two runs) or while
one of its step sessions is queued, starting or running (a verify-then-land run of a landing task). Counting the
running state closes the window between a step's end and the next step's run, in which the bot could admit one task
too many. A task waiting on the owner, queued, or landing without a run holds none.

## M-014 jevellan-memory keeps a log of archives and supersedes

`archive(db, id, reason, by)` takes a reason, but the memories row of section 6 has no column for it. A
`memory_log` table (memory id, time, action archive, supersede, reword or expire, reason, by) is created by
`ensureSchema` next to `memories` and `memories_fts`, so every removal says why and who. `memories_fts` is an
external-content FTS5 table over `memories`; its `tags` column is fed by the triggers from `tags_json` joined by
spaces (`json_each`), so the index is never read back as a column and never rebuilt.

## M-015 The memory port and the worker MCP server

jevellan-core declares a `MemoryApi` (remember, recall, buildBrief, writeProjectMemoryFile, the scopes) and
`registerMemory(api)`. `packages/cli/src/setup.ts`, imported by the CLI before any command, registers
jevellan-memory there and as the store's schema extension, so every jv process has it: `jv run`, the bot, the UI and
MCP servers. The stdio worker server is started as `<node> <jv entry> worker-mcp --session R` (an internal command)
instead of `node <runtime>/dist/report-mcp.js`, so the memory tools work in claude-tmux and Codex sessions too; the
package's `jv-worker-mcp` and `jv-report-mcp` bins run the same server directly, where memory answers that it is not
available. Read-only duties pre-approve `mcp__jv__jv_report`, `jv_remember` and `jv_recall` (D-026). The worker
prompt carries the block "What this project remembers:" after the project instructions and before the task block,
recomputed every turn (so `uses` counts the turns a memory was shown in); the run's `start` event records the block
and the memory ids. The coordinator prompt gets the same block at start and restart.

## M-016 Cron and daylight saving time

nextRun follows Vixie cron: a local time that the clock jumps over fires once at the first instant after the jump
when the hour field is fixed, and does not exist for a wildcard hour; a local time that happens twice fires once (the
first instant) for a fixed hour and on both passes for a wildcard hour. A day field that starts with `*` (such as
`*/2`) counts as unrestricted for the two-day-field rule, and then both day fields must match, as in Vixie cron.
`cron.ts` has no Node or jv import, so the web app's "next three runs" helper uses the same code; its CronError carries
exit code 2 and the scheduler turns it into a JvError.

## M-017 The jobs machinery lives in jevellan-core

Section 10 puts the jobs machinery in `improver/src/jobs.ts` "used by the planner", but section 2 lets the planner
depend on core and memory only. It is `core/src/jobs.ts`: kinds register handlers (duty, origin prefix, request id,
work task, finish); `createJob` returns the job of the same request id (exit 0) and refuses another of a kind queued
or running for the project ("already running: J..."); `stepJobs` gives a queued job its single work task (request id
`job:<J>`, origin `improver:<J>` or `planner:<J>`, not visible) and finishes a job when its task is done, fails it with
the task's reason when the task failed or stopped, and waits while the task waits on the owner. The improver's and the
planner's packages hold their kinds and templates; the bot calls `stepJobs` with each package's handlers. Schedules
queue job rows through the store directly.

## M-018 Planner and improver templates and their inputs

The templates are `packages/planner/templates/plan.md` (verbatim from the brief) and
`packages/improver/templates/improve-{memory,docs,skills}.md` (the brief's bodies, then the inputs and the closing
instruction), candidates to become duty skills later. `finishPlan` validates the block's shape, size and goals and
fails the job otherwise; a proposal whose title repeats an earlier one or an open task's (case-insensitive), or whose
after task was skipped, is skipped with its reason; created tasks are queued and not started (`createTask({start:
false})`). improve-skills always runs on the registered project `jevellan-skills` and asks its worker to export the
cases into the worktree itself with `~/.jv/bin/jv evals route|landing --since <last job> --out <the skill's
evals/cases.json>` (the worktree does not exist when the job builds its task), and to end with a JSON block of the
agreements before and after.

## M-019 jevellan-mcp may depend on the job and schedule packages

Section 2 says mcp depends on core (and memory); section 5 says every tool "is a thin call into core, memory,
scheduler, planner or improver" and lists schedule, goal and job tools. The dependency test allows mcp core, memory,
scheduler, planner and improver; ui keeps everything but bot and cli.

## M-020 jv doctor: models of openai-compatible providers, the service line

`models:<provider>` also covers openai-compatible providers that have their key (or need none): `GET
<baseUrl>/models` with the key as a bearer header, never printed. A local Ollama with nothing pulled is the brief's
WARN "no models" (fix `ollama pull <model>`), an unreachable endpoint a WARN. A bot service file that is not installed
is an informational OK line (`jv bot install-service writes it`): the bot runs in the foreground without it, loading
it is the owner's step, and M1 allows WARN only for missing key files, Ollama without models and a Codex login.

## M-021 Workers and landing checks find the owner's Playwright browsers on macOS (amends D-004)

`env.playwrightBrowsersPath(ownerHome, platform)` looks for `~/Library/Caches/ms-playwright` and `~/.cache/ms-playwright`,
the platform's own first, and uses the first that exists (or sets nothing). Workers (D-004) and landing checks (D-045)
both use it; the owner's home still comes from the user database, never from HOME.

## M-022 jv doctor's monorepo checks

Groups in the lifted `--check` handling (D-013): `skills` (lines `skills`, `skills:checkout`, `skills:version`),
`ports` (`ports:ui` 7071, `ports:mcp` 7072, `ports:bot`, bot.json's health port), `memory` (FTS5), `service` and
`member`. The skills are compared live with install.json's checkout by `skillsTreeHash`, so a checkout that moved on
is noticed; the per-skill line compares every installed skill with the installed router's jv-version (jv and the
skills have separate versions). Listeners come from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc -w` (also from
/usr/sbin/lsof, where macOS keeps it); a port is jv's when its pid is the one in `$JV_HOME/run/ui.pid`,
`run/mcp.pid` or `run/bot.lock`. FTS5 is tried in process; only when that fails are other Nodes searched for one that
works. The member line reads `launchctl list` and nothing else.

## M-023 jv status text

The brief's block: the bot line, then per project "name (path)", "waiting on you", "running" and "queued", and one
"landed today ... failed ..." line. Choices: a landing task is listed under running; a queued line shows "after T..."
or the queue reason where the step would be; a waiting line names the open landing ask ("ask-owner", with "options:
Land now | Leave it") or the latest report's needs-decision or blocked status; running lines use providers.json's
label (never a hard-coded model name), effort, "via <provider>", the run id and its start time; "landed today" is
tasks done whose ended_at is today in local time, "failed" is failed or stopped in the last 24 hours; columns align
per group and the title narrows first when a line would pass 100 characters. `--json` keeps every lifted key and adds
`bot`. `--watch` repaints every 2 s and is refused with `--json`. The bot is alive when the pid in `bot:pid` lives and
the heartbeat is younger than max(60 s, 3 ticks). `jv status` marks lost runs through reconcile's read-only step
(`markLostRuns`).

## M-024 The bot resumes lost runs (amends D-040)

reconcile marks lost every starting or running step session whose process is gone and that has no end event, and a
starting row with no pid for more than 60 s (its spawner died). For the newest lost run of each task's current step: a
run that had reported advances the task by its report, as afterRun would (a verify with failing tests applies
on_fail); one that had not is continued as `jv task resume` does (a new run on the same native session with
"Continue.", request id `resume:<R>`, or the step placed again without a native session). The step is resumed while
at most 3 runs in a row were lost; the fourth is a failure of the step, so a run that crashes on every start cannot
loop. Lost recovery comes before admission and is not limited by slots.

## M-025 Queued tasks start only in a free slot

The check is in `advance.startStep` for a task in state queued: `jv task create`, released `--after` dependents,
`jv task resume` of a queued task and reconcile's admission. It runs before the Jev call and again inside the
transaction that creates the run, because concurrent creators (three `jv_task_create` calls at once in M5) would all
pass the first check. Otherwise the task stays queued with reason exactly "waiting for a slot" and `jv task create`
exits 0. A task that already runs is never held back (next step, on_fail retry, continue, message, answer), nor is the
owner's own placement (`jv task override --undo`).

## M-026 Admission refusals and their wake

Meta `admit_attempt:<T>` holds `{at, reason}`: written on every Jev refusal of a start, cleared when a start goes
through. reconcile retries a refused task at most once a minute; slot waits make no Jev call and are rechecked every
tick. A retry's wake is forwarded only when its reason differs from the stored one: one wake per refusal.

## M-027 Message delivery by reconcile

Undelivered messages of a task whose newest live run is a running claude-tmux session with a tmux target are typed
into its window ("From the owner:" or "From the coordinator:") and marked delivered to that run, except the ids its
start `message` event already carried and messages younger than 10 s (`jv task message` may be typing them).
Messages of the coordinator conversation task are always delivered when written and are never typed again.

## M-028 Task origin and unstarted tasks

`tasks.origin` is the given origin (checked against `TASK_ORIGIN_PATTERN` before anything is written), else
coordinator when JV_SESSION names a coordinator session, else owner. `jv task create --origin` is internal (not in
`--help`). Origin is not part of the request id: a repeat from another origin returns the first task.
`createTask({start: false})` leaves the start to the bot. `jv task show --json` carries `origin`; the text shows it
only when it is not owner.

## M-029 jv task changes

The committed part is `git diff <base_commit>...refs/heads/<branch>` with rename detection, read in the project
checkout (the worktree may be archived, D-051); the uncommitted part (`git diff HEAD` and untracked files that are not
ignored, so `.jv-evidence/` and `plan.md` never count) is read from the worktree while it exists, each file marked
uncommitted. git runs without a shell and with `GIT_OPTIONAL_LOCKS=0`; the diff is capped at 4,000,000 characters and
200 untracked files and passes through the redactor.

## M-030 The coordinator conversation

`coordinator-chat.ts` tails each coordinator's native transcript from meta `coordinator_tail:<session>` (JSON: byte
offset, file, matched owner message ids, the usage of the last API messages), complete lines only, each chunk's events
and new offset in one transaction that first checks the stored offset has not moved (the bot and the UI tail at the
same time). It records text, tool calls and results, one usage event per read and the user lines; thinking is left
out. `messageCoordinator` types ` [owner]  <text>` (send-keys for one line, a pasted buffer for text with a newline
or a tab), records a messages row on the conversation task (M-012) with delivered_at set and a message event; the
transcript's own copy of that line is matched to the row and not recorded twice. Typing into a coordinator window
holds a per-window lock (`$JV_HOME/run/typing-<tmux name>.lock`) from the first key to Enter, for wake lines, owner
lines, `/exit` and the handoff alike, so a wake line never lands inside an owner's line. Owner text is masked for
known secrets and stripped of control characters before it is typed and stored. Transcript entries have the roles
owner, jv (wake lines and the handoff), coordinator and tool; a turn starts at an owner or jv line.

## M-031 Lint rules that keep the lifted style legal

`eslint.config.mjs` is Jevellan's with this repository's ignores (build and test output, evidence, agent folders,
`packages/ui/viewer`). A leading underscore marks a deliberately unused name and an object rest sibling may drop a key;
tests may use `any` for parsed JSON and literal spaces in regular expressions. Every other recommended rule is an
error. Node globals are listed by hand (no `globals` package). The compiler stays the main lint (M-010).

## M-032 The secret scan, bump-version and sync-from-skills

`scripts/secret-scan.mjs` scans the tracked files as they are on disk and reports file, line and the kind of shape,
never the value (exit 0 clean, 1 found, 2 could not scan); history is opt-in (`--history`), there is no pre-push mode
(no hooks are installed), and `--values-from DIR` adds the values of key files (M16 runs it with `~/.jv/secrets`).
`scripts/bump-version.mjs <version>` sets one version in every package.json, every cross-workspace dependency and the
lock file's workspace entries; `--check` reports a mismatch. `scripts/sync-from-skills.mjs` lists every file of the
lifted runtime (src, test, templates, ui, bin, package.json) and of the skills fixture that changed in
jevellan-skills since the lifted commit, with where each lives in the monorepo now. The scripts' tests run with
`node --test "scripts/test/*.test.mjs"` (Node 22 does not take a folder), as part of the root `npm test`.

## M-033 The public index of jevellan-core

`src/index.ts` exports the lifted modules' own names, the brief's names as aliases (`land` = `landTask`, `override`
= `overrideTask`, `doctor` = `runChecks`, `assemblePrompt` = `buildSystemAppend`, `startSession` = `startStep`,
`resumeSession` and `retry` = `resumeTask`, `stopSession` = `stopRun`), `coordinator` with `tail`, `message` and
`transcript`, and namespaces where names clash (advance, providers, wake, workflows, coordinatorChat). `migrate(db)` is
not exported: the migration is a method of the Store on its own connection, and `openStore` migrates. The CLI keeps
importing by subpath, so `jv status` loads only what it uses.

## M-034 Contract schemas

Where the lifted runtime has a zod schema (report fields, providers.json, landing state, Jev's questions and answers),
`contracts/` re-exports it. Shapes that were only TypeScript types (placement and workflow state, the decisions row
and its JSON, the events row, `jv status --json`, `jv task show --json`) are strict schemas tested against objects the
lifted code produces, with compile-time checks that each matches its type; adding a key to one of these outputs means
updating its schema and fixture in the same change. The A2UI envelope of a report's `ui` lives in
`contracts/a2ui.ts` (no Node imports): version, exactly one of the four messages, a non-empty surfaceId, at most 65536
characters; the report write path and the contracts use the same check. The request id forms jv writes (auto:, the
coordinator conversation, `schedule:<C>:<slot>`, `plan:<J>:<i>`, `job:<J>`, the session forms) are part of the
contract.

## M-035 Acceptance journeys

Every journey that could leave state runs in a JV_HOME under `~/.jv-test/<run id>/` and removes it; `lib.mjs`'s `jv()`
needs the home given and refuses the real `~/.jv` unless the journey runs with `--real`. M2 calls the skills runtime
through its `main()` (its `dist/cli.js` exports `main` and `COMMANDS` and prints nothing when run), built in a temporary
copy of the skills checkout; a key the skills runtime prints and this jv drops is a failure (the coordinator reads
those outputs), a key or flag only this jv has is listed with its reason. M3's temporary home copies the providers,
secrets and seeds but disables Codex: every copy of the member's Codex login shares one refresh token (D-022), and an
answer task never runs on Codex.

## M-036 What M17 counts as the member daemons' own writes

M17 says no file under `~/.jevellan`, `~/.jevellan-member` or `~/.jevellan-playground` may change after the start
"except files the member daemon itself writes under its logs/ and cache/". On this machine the two daemons also
rewrite their own state while they run: `hub/jevellan.db` and its WAL, `locks/activity.json`, `cleanup/last-run.json`,
`rigging/application.json` and `settings-sync.json` changed within the first two hours with jv doing nothing there
(checked with `find -newer` against the phase 0 marker). jv never writes into those folders (D-011 refuses any home
inside them; seeds.json is only read), so the journey lists those top-level state locations as the daemons' own and
counts anything else, and always counts anything under `homes/` or `projects/` (the account homes and checkouts jv
reads). The daemons' pids must also be the phase 0 ones.

## M-037 How M16 looks for the token variable names

M16 greps for the brief's two token variable names, but the journey file itself lives in `acceptance/`, one of the
places it greps, and its result file is written there. The journey builds the two names from parts, labels them
"literal 1" and "literal 2" in its output, and never prints them, so a match can only come from a real leak.

## M-038 Standing preferences: a preference memory is the better home (asked of the skills, not done)

The coordinator skill tells the coordinator to keep the owner's standing preferences in `notes.md`, which only the
coordinator reads. The monorepo would like them as `preference` memories (`jv memory add --scope global --kind
preference "..."`, or `--scope project`), because every worker and coordinator prompt carries the memory brief, so
the preference reaches every step. This repository changes no skill body (brief section 11); the README and this
entry record the request, and the skills run decides when to adopt it. The planner and improver templates
(`packages/planner/templates`, `packages/improver/templates`) are likewise candidates to become duty skills
(`jevellan-duty-planner`, `jevellan-duty-improve-memory`, and so on) once the owner has seen them work (M-018).
