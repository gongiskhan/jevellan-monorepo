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

## M-039 jevellan-skills lands only through the owner (amends D-047)

`jv project add` of a project named jevellan-skills writes landing.json with `riskyPaths: ["**"]` (`pathMatches` now
reads `**` as every file and a trailing `/**` as everything under a folder) and a rules.json whose one rule, with an
empty `when`, sets `landingRoute: ask-owner` (D-032 applies it after Jev). Risky paths alone leave the route to Jev's
judgement; the rule makes a skill change a proposal the owner lands or leaves, every time, as section 10 says.

## M-040 Job work tasks start through the bot's admission (amends M-017)

`stepJobs` creates a job's work task with `start: false`, so reconcile admits it on the next tick under the limits and
quiet hours, and a Jev refusal is retried at reconcile's pace (M-026). A work task that cannot be created leaves the
job queued with "work task not created: ..." and the next pass tries the same request id `job:<J>`. createJob checks
"already running" and inserts in one transaction; a new job's reason is "waiting for the bot's next tick". `finish()`
reads the newest report of the task's work step (the kind's duty), never a later verify step's.

## M-041 improve-docs and improve-skills land their work

A single task ends without landing, so their post-processors call `landTask(store, task, {auto: true})` when the work
task changed files and has neither landed nor started a landing; the job is done either way and `result_json.landing`
records `{route, state, commit, reason}` (an error of the landing itself is state `error`). An improve-docs task that
changed a file outside the documentation (README.md, AGENTS.md, CHANGELOG.md, docs/) is not landed and
`result_json.notLanded` names the files.

## M-042 Goals, model nulls, and what counts as project work

A goal moves from open or paused to done, and done is final; pause takes an open goal; a done goal refuses pause with
exit 2; no command reopens a paused goal (the brief names none). Goal titles are one line. The plan's `duty` and a
merge's `text` accept null as none; an improve-memory operation jevellan-memory refuses is skipped with its reason on
its own savepoint, so one bad operation never loses the others. The plan task's recent and open lists and the
improver's inputs leave out the jobs' own work tasks (request id `job:`) but keep the tasks a plan created. jevellan-cli
depends on jevellan-planner and jevellan-improver for `jv job run` and `jv improve`; a job cancelled today keeps its
request id, so `jv job run` of that kind returns it with exit 0 until `--force`.

## M-043 The control MCP

- Tools: the 34 of section 5 in `packages/mcp/src/tools.ts`, each with a zod 4 input (SDK 1.32.2 takes them as they
  are) and data equal to the matching `jv ... --json`. Where a lifted command built its JSON in the command module,
  the building moved into core (`createdTaskView`, `landView`, `sessionReport`, `eventView`/`tailPage`,
  `usageReport`) and both call it; where it lives in a cli module (doctor, memory, bot status) `views.ts` copies it and
  the tests compare both on one store. `jv_goal_done` and `jv_job_run` call the same functions as `jv goal done` and
  `jv job run` (M-042). `jv_job_run` also takes `force`.
- Structured content is always one object (`jv_project_list` is `{projects}`; `jv_tail` a bounded page of at most 200
  events after `sinceSeq`, payload strings cut to 2000 characters with `truncated: true`, plus `nextSeq` and `more`).
  A command that exits non-zero while it prints JSON (`jv land` refused, `jv doctor` with a FAIL) is an error result
  that keeps the JSON as structured content; a thrown refusal is `{error, exitCode}`; arguments the schema refuses
  get the SDK's own InvalidParams result before the tool runs.
- `mutates` marks what `jv ui --readonly` refuses; `jv_status` (marks lost runs) and `jv_coordinator_transcript`
  (tails first) count as reads.
- stdio keeps no pid file (every client starts its own server); only `jv mcp --http` holds `$JV_HOME/run/mcp.pid`.
  HTTP is stateless with JSON responses (a new server and transport per POST /mcp; GET and DELETE /mcp answer 405), a
  missing or wrong bearer token is 401 with an empty body, GET /health is open, everything else 404. The token is
  written before the port is bound, printed once in text mode only, and `--token-reset` is refused while an HTTP
  server runs.
- M9's Claude Code session runs with HOME a folder of the run and claude-main's token of the temporary home in its
  environment: with the owner's own login it would record the run's folder in the owner's `~/.claude.json`, which
  brief section 1 says jv never writes.

## M-044 The UI server

- jevellan-ui takes its control-plane routes from jevellan-mcp's operations table, injected by `jv ui` (the server
  sees a structural `UiOperation`, which keeps it off any zod major), with `nextRuns` from jevellan-scheduler and the
  memory list from jevellan-memory; a route whose operation or helper is missing answers exit 2 "not available".
- `--readonly` refuses every POST with 403 except sign-in and sign-out, and never tails the coordinators (tailing
  writes events).
- Tokens: valid while `last_seen_at` is under 30 days old, the window sliding with use, refreshed at most every 5
  minutes (every write moves `PRAGMA data_version` and makes every open page refetch); sign-out and
  `--password-reset` set `last_seen_at` to the epoch instead of deleting the row. The wrong-password limit is per
  socket address; forwarded headers are not trusted. Every POST must be `application/json` (with SameSite=Lax and no
  CORS preflight answered, the CSRF defence).
- The page's CSP allows inline style attributes only (`style-src-attr 'unsafe-inline'`), because the A2UI basic
  catalog's Text sets `style="flex: N"`; inline style elements and scripts stay refused.
- `run/ui.pid` is JSON `{pid, startedAt, url, readonly}`; a file whose pid is gone, or whose pid was reused by a
  later process, is taken over. `ui.log` gets one line per request (method, path with query keys and no values,
  status, ms). `/evidence/` needs the cookie too.
- The redactor also masks the content of `$JV_HOME/ui-password`, which lives next to the store rather than in
  `secrets/`, and M16 searches for it.

## M-045 The bot's lock and its pid row

`$JV_HOME/run/bot.lock` is created with O_EXCL and holds JSON `{pid, command, startedAt}` (command `start` or `tick`);
`doctor.readPidFile` reads the pid from it. A second taker gets exit 2 "bot already running (pid N)". A lock is stale
when its pid is gone, is a zombie, or is a live process whose command line does not mention `bot` (a reused pid). A
lock file without a readable pid counts as being written for 10 s, and as stale after that. A stale lock is taken over
with a log line. Two takeovers at once are serialised by a second O_EXCL file, `bot.lock.takeover`, held only for the
takeover itself. A holder removes the lock only while it still holds its own pid. When `jv bot start` or `jv bot tick`
ends, it clears meta `bot:pid` (if that row still names its pid) and keeps the heartbeat time, so the store says at
once that no bot runs, even when the host process goes on living.

## M-046 Everything the bot creates starts through its admission (extends M-040 to schedules)

The bot fires schedules and steps jobs with a task creator that passes `start: false`. A schedule's task is created
queued, and reconcile admits it at the next tick under the limits, quiet hours and M-026's retry rules. A Jev refusal
therefore never turns a created task into a schedule error. M11's 75 s allows up to 60 s to the minute boundary plus
one 15 s tick.

## M-047 jv bot tick is one tick of the bot, under its lock

`jv bot tick` takes the bot lock (command `tick`) and refuses with exit 2 while a bot runs, so it never runs beside
the loop or overwrites its heartbeat. It writes bot.json's defaults when the file is missing, as a first start does.
Its exit is 0 whatever the sub-steps did; their errors are in the summary and in `bot:last_error`.

## M-048 Housekeeping

Housekeeping runs when meta `bot:housekeeping_at` is missing (the first tick of a home) or an hour old; the time is
recorded first, so a failing housekeeping retries in an hour, not every tick. Its probe covers only the enabled
providers whose last recorded probe (`provider_auth`) was ready, through `jevellan-core/providers-check`'s
`probeProviders`. It records login state and probe or local usage rows as `jv providers check` does, but reads no model
list, asks Jev nothing and never writes providers.json: changing the menu stays the owner's command. There is no probe
at all without a providers.json. Then `gc(store)` (each project's retention, D-051), then the log trim. The three parts
are isolated from each other.

## M-049 The bot's health endpoint

Only GET (and HEAD) `/health` is served. The body has exactly the keys ok, heartbeatAgeSeconds, running, queued,
version, in that order. `ok` is M-023's alive rule (heartbeat younger than max(60 s, 3 ticks)); the status is 200 when
ok and 503 otherwise, so a hung tick loop is visible. Everything else is 404 with an empty body. A taken port refuses
the start with exit 2 and doctor's fix text. A first heartbeat (tick 0) is written before the endpoint listens, so it
never answers without one.

## M-050 Stopping the bot within 10 s

SIGTERM and SIGINT let the running sub-step finish and skip the rest of the tick, then release the lock, close the
endpoint and the store, and exit 0. If the sub-step has not finished 9 s after the signal (a slow Jev call during an
admission), the lock is released and the endpoint closed anyway, and the process exits 0. The abandoned sub-step loses
nothing: every write is its own transaction, and M-024 recovers a run whose spawner died. `jv bot stop` sends SIGTERM
to the pid in the lock, waits up to 10 s, and exits 2 if the bot did not go. When a service file exists it adds a hint
that launchd's KeepAlive will restart the bot.

## M-051 bot.json

The file is validated with zod, strict at every depth (an unknown key exits 2 naming its dotted path). A key left out
takes its default. Refused: `tickSeconds` outside 1..3600; limits outside 1..100; `quietHours` times that are not
HH:MM, or `from` equal to `to`; a `health.bind` that is a wildcard or is not an IP address or localhost; `logLines`
under 100. A quiet window whose `from` is later than its `to` runs past midnight, with `from` in and `to` out, in the
process's local time. The running bot rereads bot.json when its modification time changes: limits, quiet hours, tick
and log size apply from the next tick, an invalid edit is logged (and recorded in `bot:last_error`) while the running
configuration is kept, and a new health bind or port needs a restart.

## M-052 The bot's log

`$JV_HOME/logs/bot.log` gets one `<ISO time> <text>` line per notable thing: start and stop, a lock taken over, lost
runs and what was done with them, admissions and refusals, deliveries, wakes, quiet hours beginning and ending (meta
`bot:quiet`), schedules fired, jobs started or ended, housekeeping, errors. Lines are redacted, stripped of control
characters and capped at 2000 characters. A tick that did nothing writes nothing. A repeated identical error or refusal
is written once per 10 minutes; `bot:last_error` keeps the newest. Only the start line goes to stdout, so the launchd
log does not grow without bound.

## M-053 The service files

PATH is the folders of the recorded Node, git, tmux, claude and codex as found on the installing process's PATH, in
that order, then launchd's default /usr/bin:/bin:/usr/sbin:/sbin. A tool not found becomes a warning. HOME is
`env.ownerHome()`; the program is install.json's nodePath and cliEntry (falling back to this process's Node and this
checkout's bin.js). The `$JV_HOME/logs` folder is created before launchd needs it. An identical file is left alone. A
different file is moved to `$JV_HOME/archive/service/<name>-<UTC stamp><ext>` first. macOS prints `launchctl bootstrap
gui/$(id -u) <plist>` and `launchctl bootout gui/$(id -u)/dev.jevellan.bot`, the form the README uses. Linux prints
`systemctl --user daemon-reload` before `systemctl --user enable --now jevellan-bot`, and `disable --now` to undo it;
systemd words are quoted with `%` and `$` doubled. Other platforms refuse with exit 2. Nothing in this repository
loads or unloads a launchd job or a systemd unit: the owner runs the printed commands.

## M-054 jevellan-bot registers jevellan-memory

`runBot` and `tickOnce` call `ensureMemory()`, which registers jevellan-memory as core's memory port and as the store's
schema extension, as the jv command's setup does; both registrations are idempotent. The improver's and the planner's
work tasks read the project's memories, and a store first created by a host other than the jv command would otherwise
lack the memory tables ("no such table: memories"). This import is why jevellan-bot lists jevellan-memory, as section 2
allows.

## M-055 A schedule's run-now keeps a task whose start Jev refused

`jv schedule run` and `jv_schedule_run` create a task schedule's task as `jv task create` does, starting step 1 at once
when a slot is free. When Jev refuses that start (JvError with `details.taskId`), the task exists and stays queued with
Jev's reason, which the bot's admission retries. The run then records "created T.. (run now)", and `jv schedule run`
prints the refusal as a warning, rather than recording an error for a task that was made. The tolerant creator is the
scheduler's own `runNowCreator`, the default of `runNow`, so the command, the MCP tool and the UI route give the same
result. Any other error is still the run's result ("error: ...").

## M-056 jv bot status

The JSON is `{bot, config, service}`: `bot` is `readBotState(store)`; `config` is bot.json validated with defaults
filled, or the defaults when the file is missing or invalid (the text names the problem; with `--json` the problem goes
to stderr); `service` is `{file: botServiceFile(platform, ownerHome()) ?? null, installed}`. The text adds the health
URL and the last error. When the bot is down it reads "bot not running; last heartbeat 2 h ago" (or "no heartbeat
yet").

## M-057 The bot's configuration and status view live in core

bot.json's schema and defaults, `serviceState` and `botStatusView` are in `jevellan-core/bot-config`, and jevellan-bot
re-exports them under its old names. `jv bot status --json`, the MCP's `jv_bot_status` and the UI's bot route all
build the one view of M-056 from there: the MCP and the UI may not import jevellan-bot (section 2), and a copy of the
view in jevellan-mcp would have drifted from the bot's strict validation (a lenient copy showed an invalid bot.json as
if it were valid). The probes of `jv providers check` moved to `jevellan-core/providers-check` for the same reason
(housekeeping, M-048, runs them); the command re-exports them, so its output and tests are unchanged.

## M-058 M13 runs on the sandbox clone

M13's implement task may land when its step finishes, so the journey uses `jv-mono-sandbox-clone`, following M5's rule
that a journey never dirties the main sandbox. It kills the process group of the run's detached `jv run` (SIGKILL to
the group), then runs exactly one `jv bot tick` with no bot running, so the recovery is that one tick. It then starts
the bot until the step finishes. The runtime Jev placed the step on is noted: a claude-tmux model lives in its tmux
window, outside that process group.

## M-059 Servers arm their stop signals before their ready line

`jv mcp --http`, `jv ui` and `jv bot start` install their SIGTERM and SIGINT handlers before they print the line that
says they are listening. A supervisor (or a test) that signals as soon as it reads that line stops the server cleanly,
closing it and removing its pid file, instead of killing the process by the default action and leaving a stale pid
file behind.

## M-060 The web app's build and tests

`packages/ui/web` (React 19, TypeScript, Vite 8) builds to `packages/ui/dist/web` through `build:web`, which
typechecks with `tsconfig.web.json` (noEmit, Bundler resolution, DOM lib) and then runs `vite build`. The root
`npm run build` is `tsc -b` and then `build:web`, so `npm ci && npm run build` leaves the app `jv ui` serves; the web
app is not a `tsc -b` project reference. `test:web` builds and runs the Playwright checks in `packages/ui/test-web/`
with `node --test` against `test-web/mock-server.mjs`, which serves the app under a CSP stricter than the real
server's (no inline style attributes), so anything inline fails a check; a console error fails a check too. The ui
package's `build` and `test` run both. Markdown loads with the app (a lazy chunk showed "Rendering..." on every page);
the A2UI renderer is a lazy chunk loaded only by reports with a `ui` array.

## M-061 zod 3 beside zod 4

`@a2ui/react` 0.14.0 needs zod ^3.25.76 as a peer and as its own dependency, so `packages/ui` lists zod 3.25.76
(brief section 2). npm installs it at `packages/ui/node_modules/zod` and nests copies under `@a2ui/react` and
`@a2ui/web_core`; the root and every other package keep zod 4.6.7 (`npm ls zod`). The Vite config aliases every bare
`zod` import of the web bundle to the ui copy. Server code under `packages/ui/server` imports no zod at all (it would
get zod 3 there): it sees operations through the structural `UiOperation` type (M-044).

## M-062 A2UI rendering with @a2ui 0.14.0

One `MessageProcessor([basicCatalog])` per report, keyed by the report id and its messages, so a refetch never drops
what the owner picked or typed; messages are fed one at a time, as they are. A refused message whose version is not
"v0.9" shows "UI not rendered: unsupported version"; any other refusal shows "UI not rendered: <reason>"; the rest of
the report renders either way. Surfaces render with `A2uiSurface` under "From the step". A Button action posts
`{action}` to `POST /api/tasks/:id/ui-action`; the surface is then dimmed and inert with "Sent to the step at HH:MM".
In read-only mode the surface is inert. The v0.9 basic catalog renders custom elements in light DOM and adopts each
element's styles into the document; `a2ui-theme.css` maps the renderer's `--a2ui-*` properties and class names onto
the app's tokens. The brief's `structural.css` is not imported: 0.14.0's export `@a2ui/react/styles/structural.css`
names a file the package does not contain, and its `styles` entry holds the v0.8 renderer's `.a2ui-surface` rules,
which the v0.9 surface never uses (findings). core's `contracts/a2ui.ts` keeps accepting `"1.0"` as the brief states.

## M-063 The project page layout

The project page is a size container with two columns (the coordinator chat and the work) from 760 px of page width,
about 1100 px of window beside the 292 px sidebar; below that the columns are the tabs "Chat" and "Work". From 1100 px
of page width the Work column grows. The chat follows its end on first load and afterwards only while the reader is
near the end.

## M-064 Land now and Leave it go through the answer route

core's `answerTask` takes exactly "Land now" and "Leave it" for an open landing ask, so the landing block posts
`POST /api/tasks/:id/answer` with `{answer: "Land now"}` or `{answer: "Leave it"}`: the same path as `jv task answer`,
the MCP and the coordinator, and no landing logic in the UI.

## M-065 Screenshot URLs

A report screenshot uses the `url` the server gives. Otherwise the page builds `/evidence/<task>/<path under
.jv-evidence>` for an image path that is relative under `.jv-evidence/` or absolute under the task's worktree, and
nothing for anything else. The server applies D-064's checks again; the page never reads a path the server refuses.

## M-066 The live stream and drafts

One EventSource on `/api/events`. Each resource refetches on `change`, with one fetch in flight and at most one
queued, and keeps the last answer on screen meanwhile. Drafts (the composer, forms, A2UI inputs) live in component
state, never in fetched data, so a refetch never clears what the owner is typing.

## M-067 Small UI choices

localStorage keys `jv.sidebar.collapsed` and `jv.theme` (a per-browser convenience; the server keeps no UI state).
Side gutters of 16 px at 760 px and below; Jevellan's desktop gutters above that. Times are local HH:MM, 24-hour, with
the date when not today. Headings balance their lines and paragraphs avoid a one-word last line (`text-wrap`). The
collapsed sidebar is hidden by visibility and width 0, not `display: none`, so its state survives a reload without a
jump.

## M-068 Override offers the providers.json menu

The Override dialog's model, effort and provider come from `providers.json` (brief section 7): `GET /api/providers`
returns, per enabled provider, its name, kind, label and models (id, label, efforts), and nothing else (never a key
file, token file, home or URL). The task's own placements and Jev's effort options are listed first as the likely
choices. The model stays a free-text field with these suggestions, since core's override validates it against the same
file.

## M-069 The landing block's checks

`jv task show --json` gives each landing its `checks`: the landing's own record of the checks it ran (name or
command, passed, outcome), from the landing row, so the task page shows "checks with their outcome" (brief section 7)
without a second request. A landing that ran none has an empty list.

## M-070 dompurify is raised by an override

`@a2ui/markdown-it` 0.2.2 (under `@a2ui/react` 0.14.0) pins dompurify 3.4.11, which has critical XSS advisories (GHSA
55q2-fjhq-7xh7, c2j3-45gr-mqc4, 6688-9rhm-gjv2, cg2g-xh64-v4q7, mrv2-3pqr-j5jr, c6gr-qvv4-5v3f), all fixed by 3.4.17.
The root `package.json` has `overrides: {dompurify: "3.4.17"}` and the lock names 3.4.17: a patch release of the same
package, no new dependency. The web checks (A2UI surfaces included) pass unchanged. The page's CSP (no inline scripts)
already blocked the event-handler payloads; the override closes the rest. The nested zod 3 advisory has no fixed zod 3
and is the owner's choice (status file, NEEDS-OWNER).

## M-071 M14 runs with a temporary owner home

M14 runs `jv bot install-service` with a temporary owner home and JV_HOME (`--owner-home`), not into the owner's
real `~/Library/LaunchAgents`. macOS loads every plist in `~/Library/LaunchAgents` at the next login, and the bot's
plist has `RunAtLoad` and `KeepAlive`, so writing the real file would start the bot at the owner's next login without
his action, which section 8 reserves to him ("never loaded by the run; the owner runs the printed command"). The
temporary file is the same file the real run writes (the same program, Node binary, checkout `bin.js`, PATH rule and
keys; only HOME and JV_HOME differ), `plutil -lint` checks it, and `launchctl list` shows no `dev.jevellan.bot`.
`node acceptance/m14-service-file.mjs --real` writes the real file for an owner who wants it; the README gives the
two commands.

## M-072 M6 runs one single task on the sandbox clone

M6 uses one `single` implement task on `jv-mono-sandbox-clone`, because its step commits on the task branch and a
journey never dirties the main sandbox (M-058). A single task never lands: after its last step it is done, so the
clone's main stays as it was and only the task's `jv/...` branch is left. The task text tells the step, in order, to
commit `notes/m06-committed.txt`, leave `notes/m06-uncommitted.txt` uncommitted, and report needs-decision "Which
colour?" with Blue and Green; after the answer it runs `sleep 45` before writing `notes/colour.txt`, so the answer
turn has a live run for the action bar's Stop. The actions run on that task in the order Stop, Override, Resume, so the
override is recorded while the step still has work. The Changes modal is checked while the task waits on the owner.

## M-073 M6 exercises Override in mode keep

The journey picks a model, effort and provider from the providers.json menu (M-068) and posts the override in mode
keep, then checks `override_json` and `override_mode` keep on the step's newest placement decision and that no run was
started. Mode undo stops the session and starts the step again in a new native session that rereads the task and could
ask the question again, which would make the later checks depend on the model rather than the UI; undo's rows are
covered by core's unit tests.

## M-074 Resume in the task page follows core's resumeTask

The action bar offers Resume when no run is live and the task is neither done nor discarded, and the task waits on the
owner, is queued, or has a newest run that is stopped, lost or waiting: the brief's "Resume (when stopped, lost or
waiting)" read as run states. A Stop without discard keeps the task's own state (core `stopTask`), so the earlier gate
on task state `stopped` left Resume disabled after the bar's own Stop. Task state `stopped` means discarded, which core
refuses to resume, so it no longer offers Resume. A failed task whose newest run is stopped, lost or waiting is offered
Resume, because core accepts it.

## M-075 The Changes file column

The Changes modal's file column is `minmax(220px, min(400px, 36%))` instead of Jevellan's 340 px: an uncommitted row
carries its "uncommitted" chip beside the path, which Jevellan never had, and at 340 px a 25-character path was cut.

## M-076 Journey screenshots are committed under acceptance/shots

The brief puts the journeys' screenshots under `acceptance/shots/`, so the ones that show a journey's result are
tracked (M6, M7, M8 and M15; viewport size, or M15's full-page phone pages; tens to hundreds of KB each) and M15 also
copies its own to `~/.jevellan-build/manager/shots/`. Every other screenshot a journey takes goes to its run folder or
`acceptance/results/` (gitignored).

## M-077 M7 measures the turn-ending reply in the page

The 10 s check runs from the composer's Enter to the moment the page shows the coordinator text that ends the turn
(the reply that carries the response time, not a preamble). A MutationObserver in the page stamps each new reply;
after the turn settles, the transcript names the reply that ended it and its stamp is used. Nothing calls the
transcript route during the timed turn, because that route tails the transcript and would make the page faster than
what the owner sees through the server's 1 s tail. The limit stays the brief's 10 s.

## M-078 Chat tool lines write the installed jv as jv

The coordinator's prompt fills `{{jv}}` with the shim's absolute path, so it runs jv by that path in every Bash call.
`coordinatorTranscript`'s tool summary replaces that exact path (`paths.shim`, as a whole word) with `jv`, so the line
reads "ran jv status --json --project P". Other paths and tools are left as they are, and the tool's input keeps the
full command for the expanded view.

## M-079 M7 checks the marks a coordinator would leave in ~/.claude.json

The owner's live Claude Code sessions write `~/.claude.json` on their own schedule, so a sha1 comparison over the
coordinator's life can change for reasons unrelated to jv. The sha1 check stays strict and names the top-level keys
that changed (by hash, never content). A second check covers what a Claude Code process with HOME set to the owner's
home would leave: `numStartups`, the sha1 of the sandbox's `projects` entry, and the coordinator's native session id.
The transcript under `<home>/homes/claude-main/.claude/projects/` is the direct evidence of the coordinator's HOME.

## M-080 M8 uses a real waiting step for the report fixture

Part one of M8 creates a real read-only investigate task whose step reports needs-decision; once the task waits on the
owner, the journey writes the fixture's `ui` (a v0.9 surface and one "1.0" createSurface) into that report's
`ui_json`. Pressing the surface then goes through `answerTask` into a real resumed turn of the same native session,
whose `message` event, `delivered_at` and final report show that the step received "From the owner: <label>"; a fake
runtime could not show that. Both M8 tasks are read-only, so they run on the main sandbox.

## M-081 A surface's sent state comes from the store

`jv task show --json` gives each message whose `meta_json` holds an object a `meta` key with that object (the raw A2UI
action of a UI action); no other message has the key, so existing outputs are unchanged. The task and session pages
give such a message to the newest report of the task that names its surfaceId and is not newer than the message; that
surface shows dimmed and inert with "Sent to the step at HH:MM" at the message's time, with the sent values written
back into its data model. The sent state so survives a reload and shows on every device while the server keeps no UI
state (M-066). A surface on a done or stopped task is inert with "Task <state>: the surface takes no input.".

## M-082 The nested zod 3 stays (owner's decision)

The owner decided on the npm audit item of M-070: `@a2ui/react` and `@a2ui/web_core` stay at 0.14.0 with zod 3.25.76
nested under them and in `packages/ui`. The zod advisory (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized
constrained collections) does not apply here: zod 3 runs only in the browser on A2UI messages, which `jv_report` caps
at 65536 characters (brief section 3) and which come from jv's own workers. The dompurify override of M-070 stays.
`npm audit` will keep listing the zod 3 copies; that is known and accepted.

## M-083 Every cut masks first, and piped output is masked as a stream

The redactor matches whole values only, so a secret that crosses a cut leaves its first part unmasked if the cut comes
first. Every bounded copy of a text that may hold a secret is now masked before it is cut: tool inputs and outputs
(events.redactedTrim with the one TOOL_TEXT_MAX, used by transcriptEvents, claude-sdk and codex), the 300-character
error messages of both SDK runtimes, the synthesized summary (report.synthesizeReport; llm.ts no longer cuts first),
and the UI action context. transcriptEvents takes the redactor as a required argument rather than defaulting to the
process redactor. Callers state which redactor they use, and tests that import the module without a JV_HOME never read
the real ~/.jv. Output that arrives in pieces (the worktree setup command's stdout and stderr, the agent SDK's stderr
hook, which receives decoded pipe chunks rather than lines) goes through redact.redactingWriter. It holds back the
last (longest known value - 1) characters of the masked text until the next piece or end(). A value not yet complete
always fits in what is held back, so it is masked whole, including values that span lines; no buffer cap is needed,
and with no values known nothing is held. This was chosen over line buffering because a line buffer needs a cap for
progress output without newlines, and flushing at the cap would bring the split back. Redactor.longest exposes a
length only. The cost is that a log can lag by up to that many characters until the stream ends.

## M-084 Caller text is masked on the way in, at core's choke points, and the control MCP masks on the way out

Text that callers supply (task title and text, task messages and answers, the UI action's text and meta_json, goals,
task schedules, jv memory add and jv_memory_add) is passed through the process redactor before anything is stored,
derived from it (request id, branch slug, task.md) or typed into a pane, as M-030 already did for owner messages to
the coordinator. The redactor masks only the exact values of jv's secret files (D-014), so text with none reaches the
step byte for byte, and a known value is replaced by [redacted] rather than refused, matching M-030. The masking sits
where every surface converges: createTask, messageTask and answerTask in core, addGoal in the planner, checkTaskSpec
in the scheduler. Memory is masked in its two callers, because jevellan-memory may not depend on core. createTask
masks before autoRequestId, so a repeated command is the same task. Write-time masking cannot cover rows written
before this change, or before a secret file existed. So the control MCP passes every tool result (text and structured
content) and every resource through redactValue, the same second pass the UI's sendJson makes (D-063).

## M-085 Secrets of project MCP servers live in ~/.jv/secrets and never reach a command line (amends the project.json mcpServers format)

project.json holds no secret. A server that needs one names a file: envFiles {NAME: file} for a stdio server's
environment, headerFiles {Header: file} and bearerTokenFile (sent as Authorization: Bearer <content>) for an http or
sse server. Paths resolve like other config paths (~/.jv onto JV_HOME). projectMcpServers refuses with exit 2, naming
the field and file but never the content, any file whose real path (symlinks resolved) is outside ~/.jv/secrets, and
any file that is missing, empty, not a file or not mode 600, by the same keyFileStatus rule jv doctor applies. Because
the files live in secrets/, the redactor learns their values with no change of its own. A literal env or header value
under a credential's name (a word key, apikey, token, secret, password, passwd, credential(s), auth, authorization,
cookie or bearer) is refused and the owner is pointed to the file keys. Other literals are declared non-secret and the
redactor does not learn them. This narrows 'the redactor must learn them' on purpose: teaching it every literal would
mask ordinary values such as 'production' or a project path in every event, and, now that caller text is masked on the
way in, in every task text and typed message too. Delivery: the codex runtime puts every project-server env value and
header value into the Codex process environment. Config names them only (env_vars; env_http_headers with
JV_MCP_<SERVER>_<HEADER>), because the SDK turns config into --config arguments. Codex has one environment for all
servers, so a name that two servers or the worker set to different values is refused. The agent SDK runtime writes the
project servers to <task dir>/<R>.mcp.json (mode 600) and passes it as extraArgs --mcp-config. Only the in-process
report server stays in Options.mcpServers, so the SDK adds no inline JSON. claude-tmux keeps its existing mode 600
file. The two files hold resolved values: copies outside secrets/, allowed as a mode 600 file and kept after the turn.
${VAR} references with the values in the environment would avoid the copies, but expansion inside a --mcp-config file
was not verified here, so values are written resolved.

## M-086 secret-scan --values-from takes a file as well as a folder (amends M-032)

--values-from PATH reads one file or every file of a folder, using the redactor's line rule (whole, per line, the
value of NAME=value lines with a leading export and one pair of matching quotes stripped, at least 6 characters).
M16's repository-wide check can then include ~/.jv/ui-password, which lives next to the store rather than in secrets/
(M-044). M16 check 2 passes it once the file exists, so the UI password pasted into any tracked file is found, not
only under acceptance/. The script still adds no shapes, does not parse providers.json and imports nothing from
packages/core, so it keeps running without a build.

## M-087 stopRun signals only a process group it can show is the run's (amends M-009)

stopRun used to send SIGTERM, then SIGKILL after 10 s, to a run's recorded pgid whenever kill(-pgid, 0) succeeded. A
waiting row (jv attach, a takeover) keeps the pid and pgid of a jv run that ended long ago, and macOS hands pids out
in order and wraps them within hours to days. So jv task stop, --discard, MCP jv_task_stop, the UI stop and 'Leave it'
could reach any group that now holds the number: a shell job, the tmux server, a launchd agent. runGroupToSignal now
decides. Only starting and running rows have a process of their own. The recorded pid must lead the recorded group.
While the leader lives, it must not be a zombie, ps must put it at the head of that group, and its command line must
name the run. That is M-009's check, except that an unreadable command line now counts as not shown: isRunAlive keeps
counting it as alive for markLost, because 'alive when in doubt' is the safe default for liveness and the unsafe one
for a kill. When the leader is gone but the group lives on, the group is signalled only if one of its members names
the run. Both verifiers' positions were rejected here. 'Never signal' leaves every crashed run's leftovers running.
'Always signal' rests on the rule that a number is not reused while its group has members, but that only protects the
current holder of the number: if an earlier holder's group outlived its own leader, the group is someone else's.
Before the SIGKILL the group is still signalled unless its leader is alive and runs something else, because the
SIGTERM went to a group already shown to be the run's, and the number cannot change hands within the 10 s grace while
the group has members. When no signal is sent, the row is still stopped with one end event, and
StopRunResult.notSignalled says why. The cost: leftovers of a crashed run that carry no run id stay running after a
stop. They usually end when their parent's pipes close, and leaving them is the safe failure under 'never stop the
owner's processes'. attach.ts is unchanged: waiting rows keep their old pid and pgid as history, and the state rule
makes them impossible to signal.

## M-088 The worktree setup's kill ends at close

The setup command runs as a detached sh (pgid = its pid). It is killed on its timeout and on the run's
AbortController, which lives for the whole turn. Its abort listener was never removed, so a jv task stop hours into a
first turn sent SIGKILL to the setup's old group number, which could belong to anything by then. The kill now lives
only until the child's close (or error): finish() sets a settled flag and removes the listener. Beyond the verifiers'
fix, the kill also does nothing once the shell has exited and a process with its pid is alive (or answers EPERM),
since that pid now belongs to another process. It is deliberately not gated on the shell's exit. Between exit and
close, a member of its group (a backgrounded child holding the pipes) can still be running, and the number cannot be
reused while that member lives, so the timeout still ends a setup like `sleep 6 & echo started`. codex-control.ts
close() is left as it is: its window between the child's exit and the signal is milliseconds.

## M-089 The bot lock checks its holder's start time; jv bot stop signals only a checked holder (amends M-045 and M-050)

A stale bot.lock (the bot killed, a closed terminal, a reboot) whose pid was later reused by any process with a word
'bot' in its argv, such as a path like ~/dev/telegram-bot/index.js, counted as a live bot. jv bot start then refused
with 'bot already running (pid N)' and pointed the owner at jv bot stop, which sent that process SIGTERM. The lock
already records startedAt. A holder must now also have started no later than that, read with ps -o lstart through
jevellan-core/proc's new processStartedAt. This is the rule run/ui.pid has had since M-044, plus 2 s of slack, because
Linux's procps works lstart out from the boot time and can land a second late, while a pid is not handed out again
within seconds of its holder's start. checkLockHolder answers holder, stale, or unverified (alive, but its command
line or start time cannot be read, or the lock has no startedAt). A taker treats unverified as held, so two bots never
run. jv bot stop signals only a holder. For an unverified one it exits 2, naming the pid and why, instead of the exit
0 'bot not running' both verifiers suggested: the same holder makes jv bot start refuse with 'bot already running', so
saying 'not running' would contradict it. The argv match was not tightened to the jv entry plus 'bot start'. The bot
also runs from ~/.jv/bin/jv, bin/jv.mjs, the plist and in-process hosts, and a match that tight would make a live bot
look stale and let a second bot take its lock. ui/server/pidfile.ts still has its own processStartedAt.

## M-090 The agent CLIs' version probes run in $JV_HOME/run/probe-home

jv doctor's `claude --version` and `codex --version` run with the base variables only (PATH, USER, LANG, TERM, SHELL,
TMPDIR), HOME = `$JV_HOME/run/probe-home` and CODEX_HOME = its `.codex`. Both are created first with mode 700, and the
probe's cwd is that folder. CLAUDE_CONFIG_DIR is never set, as for workers (env.ts). Codex 0.154 creates
`$CODEX_HOME/tmp/arg0/` on every start, `--version` included, so the probe with the owner's HOME wrote into `~/.codex`
on every `jv doctor`, MCP `jv_doctor` call and M1 run, which brief section 1 forbids. The folder is jv's own under
`$JV_HOME/run`, not a provider home, so the check also works when providers.json is broken or has no
codex-subscription provider. Codex rotates its unlocked arg0 folders, so the probe home holds one at a time.
CODEX_HOME must exist, or Codex prints a warning on stderr. Run before bootstrap, the probe creates `~/.jv` with mode
700, which bootstrap would set anyway (opening the store already creates the folder). The claude probe shares the
folder although Claude Code 2.1.316 writes nothing on `--version`, so a later version cannot write into `~/.claude`
either. git and tmux keep the process environment, because they read no agent configuration. When the folder cannot be
created, the line is WARN and the CLI is not run. execCommand keeps its process.env default for lsof, launchctl and
the node probes.

## M-091 M17 reads jv's files for calls of the jevellan command

M17's third check no longer uses `git grep -E`. The old pathspec `packages/*/src` matched no file without `:(glob)`,
so only `packages/ui/server` was searched, and the check could pass while searching nothing. macOS git grep -E also
has no `\b` or `\s`, and no line-based grep sees a call wrapped after its parenthesis, which is how this code base
wraps long calls. The check lists files with `git ls-files --cached --others --exclude-standard` for each of
`:(glob)packages/**`, `bin`, `scripts` and `acceptance`. It fails when any of them lists no file or git fails. It
reads every text file and looks for spawn, spawnSync, exec, execSync, execFile, execFileSync, doctor's execCommand or
lib.mjs's run whose first string argument names jevellan: bare, by path, or as a word of a shell command, also across
line breaks. The scope covers all of packages/, tests included, plus scripts and the journeys, because the brief says
the run never runs `jevellan`, and journeys and tests are part of the run. The regex is call-shaped, so the names
'jevellan' in the MCP server and the version line do not match, and neither does the regex's own source. A call found
is reported by file, line and function, never by its argument: the detail goes into the tracked acceptance/RESULTS.md,
which the check also reads, and a quoted call there would fail every later run (the M16 trap, M-037). The check stays
a heuristic: a call through a variable holding the name is not seen. The pid and mtime checks remain the live
enforcement.

## M-092 Journey children get none of the caller's Claude or Codex configuration or Anthropic login

acceptance/lib.mjs childEnv drops CLAUDE_CONFIG_DIR, CODEX_HOME and every ANTHROPIC_ variable from the caller's
environment, as it already dropped CLAUDECODE and CLAUDE_CODE_*. A caller can still set them through `extra`. Claude
Code 2.1.316 keeps `.claude.json` and `projects/` under CLAUDE_CONFIG_DIR whatever HOME is (checked with `claude mcp
add --scope user` in scratch folders). A journey run from a session launched with
`CLAUDE_CONFIG_DIR=~/.claude-jevellan-build` (brief section 16) would therefore have M9's `claude -p` record the run's
folder in that live config instead of the run's own HOME, which M-043 relies on. An inherited ANTHROPIC_API_KEY,
ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL would win over the claude-main token M9 sets and run M9 on the caller's
login or endpoint. CODEX_HOME is dropped for the same reason in case a journey ever runs Codex itself. jv's own
children were never affected, because env.ts and the doctor build their environments from an allowlist.

## M-093 The version 1 backup is copied under the migration's write lock (amends M-011)

M-011 copied a version 1 store to store.sqlite.v1.bak before the migration transaction, and only if no file of that
name existed. The copy now runs inside that transaction. migrateV1ToV2 takes BEGIN IMMEDIATE, rechecks the version,
and only then copies the store, before the transaction's first write. VACUUM INTO cannot run inside a transaction, so
the copy goes through a second, read-only connection: VACUUM INTO works there while the first connection holds the
write lock. Because no write can land between the copy and the migration, the backup is exactly the version 1 store
that was migrated. A second opener that arrives meanwhile waits for the lock (busy_timeout 5000, six tries with
backoff, about 31 s, then exit 2 'the store is busy (...); try again') and then finds version 2. It no longer copies
into the same file and fails with 'table projects already exists'. The copy is written to store.sqlite.v1.bak.tmp,
which is created empty with mode 600 so it is never readable by others. It is then fsynced (VACUUM INTO does not
sync), checked the same way as an existing backup, and renamed into place. A crash or a write error midway leaves the
store at version 1. This process's own unpublished copy is removed: a full disk is the likely cause, and it is not
owner data, since the store it copies is intact. A staging file left by an opener that died is set aside as
.v1.bak.partial-<UTC time> with its journal. Lock-free staging was rejected, where each opener writes its own uniquely
named copy and publishes it with link(2): every concurrent opener would copy the whole store, and it needs an ordering
rule so that a loser does not shelve the winner's good backup. The lock is held for the copy, about 0.6 s for a 154 MB
store, once per store.

## M-094 An existing .v1.bak is kept only when it holds what the store holds

Before a migration copies the store, any existing store.sqlite.v1.bak is checked against the store as it is under the
lock. To be kept, it must pass all of these: no -journal, -wal or -shm beside it (an interrupted write leaves a hot
journal, and SQLite would roll it back into the file on open, so such a file is never opened); it opens read-only;
PRAGMA quick_check is ok; schema_version is 1; its sqlite_master SQL is the same; and every table has the same rows,
compared one row at a time in primary key order. A file that passes is kept as it is, so a migration that failed after
its copy reuses it on the next open, and repeated failures do not pile up copies. Any other file is renamed, side
files first so a journal never pairs with the next file of that name, to .v1.bak.invalid-<UTC time> when it is not a
complete version 1 store (empty, not a database, damaged, a journal beside it) or to .v1.bak.prev-<UTC time> when it
is a complete version 1 store with other contents (an older copy, or another store's). Then a fresh copy is taken.
Nothing is overwritten or deleted. The only file the migration ever removes is this process's own unpublished staging
copy. A row comparison was chosen over a fingerprint (row counts, max ids) because a stale copy can differ only in
updated rows or meta values.

## M-095 Registered extensions are ensured after every open of a schema 2 store (amends M-011)

migrate() now ends every successful open at schema 2 with ensureExtensions(). Before, when another process created or
migrated the store while this one waited for the write lock, the early returns inside the create and migration
transactions skipped it. A host that registers no extension, such as the Stop hook or the bare jv-worker-mcp, could
then leave a memory-registered process with no memory tables until some later open. The cost is one present() read per
extension, and the write lock is taken only when something is missing, so opening an up-to-date store stays lock-free.
