# Findings

What the run verified on this machine (Goncalos-MacBook-Pro) about the tools, the SDKs, the lifted runtime and the
packages. Append-only; each entry is dated and says how it was checked. The skills repository's own findings
(dev-madrid) stay in `gongiskhan/jevellan-skills` at `docs/findings.md`.

## 2026-11-01 Phase 0: the machine (brief section 12, re-verified)

Checked with `sw_vers`, `uname -m`, `df -h /`, `--version` of each tool, `lsof -nP -iTCP:<port> -sTCP:LISTEN`,
`launchctl list` and `tailscale ip -4`.

- `Goncalos-MacBook-Pro.local`, macOS 15.7.4 (24G517), arm64, 460 GB disk with 36 GB free, Tailscale address
  `100.108.210.116`.
- Node: the shell's default `node` here is v22.22.0 from nvm (`~/.nvm/versions/node/v22.22.0/bin/node`, npm 10.9.4);
  v20.19.4 and v24.22.0 are installed too. Every command of the run uses the 22.22.0 binary by path.
- tmux 3.5a (`/opt/homebrew/bin/tmux`), git 2.56.0 (`/opt/homebrew/bin/git`), Codex CLI 0.154.0
  (`~/.local/bin/codex`), APM at `/usr/local/bin/apm` (not used), Python 3.14.6, sqlite3 3.43.2.
- Claude Code is 2.1.316 (`~/.local/bin/claude --version`), not 2.1.312 as the brief recorded: it updated itself
  between the brief and the run.
- `gh` is logged in as `gongiskhan` (keyring) at the time of the run, unlike the brief's note; the repository
  `gongiskhan/jevellan-monorepo` was created with `gh api -X POST /user/repos` (HTTP 201) and the HTTPS remote added.
  Git identity `goncalo.gomes <goncalo.p.gomes@gmail.com>`, credential helper `store`.
- Ports 7071, 7072 and 7073 are free. 3006 is held by a `node` process (pid 4849), 9771 by the member daemon (pid
  79678), 9772 by the playground daemon (pid 821).
- launchd: `dev.jevellan.daemon` pid 79678 and `dev.jevellan.playground.daemon` pid 821, recorded with the start
  time in `acceptance/baseline/` for M17. Newest file mtimes at the start: `~/.jevellan/hub/jevellan.db-shm`,
  `~/.jevellan-member/settings-sync.json`, `~/.jevellan-playground/hub/jevellan.db-wal` (the files and epochs are in
  `acceptance/baseline/newest-*.txt`).
- Ollama answers on 11434 with no models (`GET /api/tags` returns `{"models":[]}`).
- Playwright browsers under `~/Library/Caches/ms-playwright`: chromium 1223 and 1234, their headless shells, firefox
  1511, webkit 2287, 2336 and 2368. Neither the sandbox's `@playwright/test` 1.63.0 (chromium 1243) nor the brief's
  `playwright` 1.64.1 (chromium 1248) had its browser there; `playwright install --only-shell chromium` of each added
  `chromium_headless_shell-1243` (195 MB) and `chromium_headless_shell-1248` (203 MB) to the same cache folder (M-006).
- `~/dev/skillio` exists; `~/.claude/skills/improving-skills/SKILL.md` does not.

## 2026-11-01 Phase 0: the sources

- `gongiskhan/jevellan-skills` cloned to `~/dev/jevellan-skills` over HTTPS. Its `main` is at `bcf93d2` ("Phase
  10a: coordinator isolation and Remote Control path, landing wording, docs"), one commit after the `0716ce1` the
  brief names; its `docs/decisions.md` runs to D-075 (the brief names D-001 to D-069). The run lifts `bcf93d2`
  (M-001).
- The runtime is `.apm/skills/jevellan-router/scripts/jv/`: 20,699 lines of TypeScript under `src/` and 10,914 under
  `test/`, `package.json` dependencies `@anthropic-ai/claude-agent-sdk` 0.3.316, `@openai/codex-sdk` 0.166.0,
  `zod` 4.6.7, dev `@types/node` 22.20.5 and `typescript` 7.0.2. The brief assumed a 5.x TypeScript there (M-002).
- `gongiskhan/jevellan` at `8e2788ecf356cd0010bce71230fe72f2bf75fe2f` ("Release 0.7.15") fetched shallow to
  `~/dev/scratch/jevellan-ref` (`~/dev/jevellan` is at `2e3f4fd`, and a full clone was too slow). Its root pins
  `typescript` 5.9.3 and lints with `eslint` 9.39.5, `@eslint/js` 9.39.5 and `typescript-eslint` 8.70.1 (resolved in
  its lock file); `apps/web/vite.config.ts` uses no React plugin.
- npm registry on 1 November: every version the brief pins exists (`@anthropic-ai/claude-agent-sdk` 0.3.316,
  `@openai/codex-sdk` 0.166.0, `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7 and 3.25.76, `react` and `react-dom`
  19.3.1, `react-markdown` 10.1.0, `remark-gfm` 4.0.1, `@a2ui/react` and `@a2ui/web_core` 0.14.0, `vite` 8.3.5,
  `playwright` 1.64.1); `@vitejs/plugin-react` is 6.1.2, `@types/react` and `@types/react-dom` 19.3.0, `@types/node`
  22.x is 22.20.5, `typescript` latest is 7.0.2 and the newest 5.x is 5.9.3.

## 2026-11-01 Phase 0: secrets, seeds, Jev and providers

- `jev.key`, `claude-main.token`, `claude-second.token` and `providers.json` were read once from dev-madrid over ssh
  (BatchMode, read-only) straight into `~/.jv/secrets/` and `~/.jv/providers.json`, mode 600, folder modes 700;
  nothing was printed. `providers.json` contains no `/home/ggomes` path (every path in it is `~/.jv/...`), so the
  replacement changed nothing. It lists `claude-main`, `claude-second` (token files), `codex`, `glm`, `deepseek`,
  `kimi` and `ollama`; the last four have no key file or no model here.
- `auth.json` of the member's Codex home copied to `~/.jv/homes/codex/.codex/auth.json` (mode 600).
  `~/.jv/seeds.json` maps `claude-main` and `claude-second` to the member's two Claude homes and `codex` to the
  member's Codex home (D-009).
- Jev: `GET https://api.typesafe.ai/v1/models` with the key answers 200 and lists `jev-latest` and `jev-preview`.
- `claude -p --max-turns 1 --model claude-haiku-5-5` under a fresh HOME with only `CLAUDE_CODE_OAUTH_TOKEN` set from
  each token file answered "OK" for `claude-main` and `claude-second`. `codex login status` with
  `CODEX_HOME=~/.jv/homes/codex/.codex` prints "Logged in using ChatGPT"; the server-side check
  (`account/rateLimits/read`) runs in phase 1 with `jv providers check`.

## 2026-11-01 Phase 0: the sandbox

- `rsync -a --exclude node_modules --exclude .jv-evidence dev-madrid:jevellan-projects/jevellan-live-sandbox/
  ~/jevellan-projects/jv-mono-sandbox/` (read-only on the source); `main` at `61fc71a`; `origin` removed. The copy
  carries dev-madrid's untracked `.claude/`, `CLAUDE.md -> AGENTS.md`, `apm.yml`, `apm.lock.yaml` and `apm_modules/`
  (all excluded by `.git/info/exclude`, none tracked) and worktree records of 40 `jv/*` branches whose folders exist
  only on dev-madrid (`git worktree list` shows them as prunable; nothing was pruned).
- `npm ci` passes. Bare `npm test` fails by design ("SANDBOX_DATA_DIR is not set", "date mismatch: expected undefined
  to be 'UTC'"), as the skills run found (D-066); `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test` passes (3 tests).
  `npm run test:browser` passes (2 tests) once chromium headless shell 1243 is installed. The package has no `dev`
  script; its dev server is `npm start` (M-004).
- Codex server-side: `codex app-server` (0.154.0 on PATH) under `CODEX_HOME=~/.jv/homes/codex/.codex` answers
  `account/read` (`refreshToken: false`) with a ChatGPT `pro` login and `account/rateLimits/read` without error, so
  the copied login is ready (D-013's probe, run by hand).

## 2026-11-01 Phase 1: the lift on macOS

- The skills runtime at `bcf93d2`, built in a scratch copy of the whole repository with its own TypeScript 7.0.2,
  runs 390 tests here: 360 pass, 30 fail. Every failure is macOS: `/var` is a symlink to `/private/var` (paths
  compared without resolving, in the code and in the tests), and `/proc` does not exist (process command lines,
  zombie state and process groups). M-009 records the code fixes.
- The same sources compile with TypeScript 5.9.3 unchanged, also with `composite` and `declaration` on
  (`tsc -p` with a config that sets both, no TS2742 errors), with `target` ES2022 and `lib` ES2023 (M-010).
- After the split and the fixes: core 298, cli 84, ui 16 tests pass (`npm test` in each package).
- A store created by the skills runtime's `openStore()` dumps 28 `sqlite_master` rows; the fixture
  `packages/core/test/fixtures/schema-v1-master.json` holds them and `store-v2.test.ts` compares a schema 1
  store of this jv with it.

## 2026-11-01 Phase 1: the real ~/.jv

- `node bin/jv.mjs bootstrap --skills ~/dev/jevellan-skills` (Node 22.22.0) linked `~/.jv/runtime` to
  `packages/core`, installed the 14 skills into `~/.jv/skill-sets/0.1.0-0ccc6e1c-20261101T175809Z`, wrote the shim,
  seeded `.claude.json` of `claude-main` and `claude-second` from the member homes (one file each, read only) and
  left the Codex home alone ("target home has a login already", the `auth.json` copied in phase 0), and added the Stop
  hook to the three Claude homes.
- `jv providers check` (6.7 s): `claude-main` ready (week 66%), `claude-second` ready (week 44%), `codex` ready
  (ChatGPT pro, week 1%, model `gpt-6-astra`), `glm`, `deepseek` and `kimi` "needs login" (no key file), `ollama`
  ready (it answers; it has no model), Jev reachable with `jev-latest` listed. Five-hour usage is unknown for all,
  as on dev-madrid.
- `jv project add ~/jevellan-projects/jv-mono-sandbox --name jv-mono-sandbox` registered P0485KS; its project.json
  then got M-004's commands. `jv doctor` in the sandbox: every line OK except WARN for the three providers without
  key files; `store: schema 2`.

## 2026-11-01 Phase 1: journeys M1 to M3 and what they showed

- M1 (`node acceptance/m01-install.mjs --real`, 10 s): `npm ci` (5 s from npm's cache) and `npm run build` at the
  checkout, `jv bootstrap --skills ~/dev/jevellan-skills` on the real `~/.jv` (nothing copied: unchanged), `jv
  --version` prints `jevellan 0.1.0 (store schema 2, skills 0.1.0)`, the shim execs
  `~/.nvm/versions/node/v22.22.0/bin/node --disable-warning=ExperimentalWarning <checkout>/packages/cli/dist/bin.js`,
  `jv doctor` has 33 OK and 5 WARN lines, every WARN an allowed one (the key files of glm, deepseek and kimi, glm's
  login, and `models:ollama: ollama has no models (qwen3:8b not installed)`).
- M2 (9 s): the `--help` of all 16 commands of the skills runtime's own table compared with this jv's: identical
  except `jv status` (`--watch`), `jv task` (list, changes) and `jv coordinator` (message), each keeping every flag
  and subcommand of the skills runtime. On one store, every key of `jv status --json` (51), `jv task show --json` (95)
  and `jv report --json` (24) of the skills runtime is in this jv's output; this jv adds `bot` to status and `origin`
  to task show.
- M3 (`--real`, 20 s): the skills runtime, bootstrapped in a temporary JV_HOME, ran a `single` answer task to done
  (Jev placed it on `claude-haiku-5-5` low, claude-main, llm); this jv opened that store, migrated it to schema 2 with
  `store.sqlite.v1.bak` (schema 1, the task in it) and lists the same task. The skills runtime then refuses the
  migrated store with exit 2 "store schema version 2 does not match this runtime (1); run jv update", and the store
  is unharmed. So the skills repository's jv and this jv cannot share one `~/.jv` until the reconciliation of brief
  section 15 (the README says so). No key file value appeared in the store, its WAL, the backup or the logs.
- In a temporary home with no token file and no `.credentials.json`, `models:claude-main` still answered OK ("4
  offered") while `login:claude-main` said "needs login": the agent SDK's `supportedModels()` lists models without a
  jv login (either its built-in list or the macOS Keychain login of the owner's own Claude Code). The login line is
  the one that tells whether a provider can run.
- `npm audit` reports 11 moderate findings, all in the lint toolchain's dependencies (`minimatch` under
  `@eslint/eslintrc` and `@typescript-eslint/typescript-estree`); nothing that ships at run time.
- A2UI: `@a2ui/web_core` 0.14.0's `MessageProcessor` accepts v0.8, v0.9 and v1.0 messages through version adapters
  (`ProcessableMessage = V08ServerToClientMessage | V09A2uiMessage | V10AgentToRendererMessage`), so `version: "1.0"`
  messages are expected to render; phase 4 checks it in the browser. `@a2ui/react` 0.14.0 peer-depends on
  `zod@^3.25.76`, `@a2ui/web_core` depends on it.
- The MCP SDK 1.32.2 declares `zod` `^3.25 || ^4.0` as a peer and its `registerTool` takes zod 4 object schemas
  (`AnySchema` in `server/zod-compat`); phase 3 verifies it with a client.

## 2026-11-01 Phase 2: memory

- `node:sqlite` of Node 22.22.0 creates an external-content FTS5 table with `tokenize='unicode61 remove_diacritics 2'`;
  "automação" and "automacao" match each other both ways (packages/memory tests). `DatabaseSync.isTransaction`
  exists in 22.22.0, which lets jevellan-memory use a savepoint inside a caller's transaction.
- M10 part one (`node acceptance/m10-memory.mjs --part one`, 28 s, real providers in a temporary home): Jev placed the
  investigate step on `claude-opus-5-5` medium (claude-sdk); the worker called `mcp__jv__jv_remember` once and the
  memory was stored with kind environment, scope `project:jv-mono-sandbox`, source `session:<R>` (the worker reworded
  the instruction into a fuller sentence and added tags); `jv memory search "npm ci"` finds it; the next task's start
  event carries "What this project remembers:" with that line and the memory id. No key file value in the store, its
  WAL or the logs.

## 2026-11-01 The coordinator conversation with a real coordinator

Checked in a temporary home on the sandbox (claude-main, `claude-opus-5-5` high, Claude Code 2.1.316 in tmux):
`jv coordinator start` then, 25 s later, `jv coordinator message --project jv-mono-sandbox "status"`.

- The pane shows the typed line as `❯  [owner]  status` (the prefix kept as typed). The transcript's own user entry
  for it was matched to the messages row: `coordinatorTranscript` lists the owner line once.
- The coordinator ran `jv status --json --project jv-mono-sandbox` (one `tool` entry, shown as "ran ... jv status
  --json ...") and its reply was recorded 9.6 s after the owner line, with `responseMs` 9597 on the reply and on the
  turn.
- A coordinator says nothing before its first message: on start it waits for the owner (the skill has no greeting).
- The coordinator skill predates the bot: reading the `bot` key of `jv status --json` it called the bot "Jev's
  scheduler" and said new tasks "probably won't start until it's running", which is not so (`jv task create` starts
  a task itself when a slot is free). The skill bodies are the skills run's (brief section 11); the README's bot
  section says what the bot does, and a skills change that names the bot in the coordinator's status guidance is a
  request recorded here.

## 2026-11-01 Phase 3: the control MCP

- `@modelcontextprotocol/sdk` 1.32.2 takes zod 4.6.7 object schemas in `registerTool` directly (no `zod/v3`
  import); `tools/list` shows them as draft-07 JSON Schema with `required`, `enum`, `minLength` and descriptions.
- M9 (`node acceptance/m09-mcp.mjs`, 9 s): 34 tools served over stdio and HTTP; a Claude Code 2.1.316 session (`-p`,
  `--mcp-config` on `bin/jv.mjs mcp`, `--strict-mcp-config`, `--permission-mode dontAsk`, the read tools allowed,
  `--max-turns 3`) answered "There is 1 project: jv-mono-sandbox ..."; HTTP `tools/list` with the token 200, without
  or with a wrong token 401 with an empty body, `GET /health` 200 `{"ok":true,"version":"0.1.0"}`; `mcp.log` holds
  one line per call and no argument; no secret in the store or logs.
- Claude Code 2.1.316 defers MCP tools behind its ToolSearch tool by default: with `--max-turns 3` the first run
  spent its turns finding the tool and stopped on `tool_use` (exit 1). With `ENABLE_TOOL_SEARCH=false` in the
  session's environment the jv tools load up front and the question is answered in 3 turns. The README's
  registration command needs nothing of this for an ordinary interactive session.
- The session ran with HOME a folder of the run and the temporary home's claude-main token; `~/.claude.json` of the
  owner had the same sha1 before and after.
- 2026-11-01 M14 temporary mode: `jv bot install-service` wrote the plist under a temporary owner home; `plutil -lint`
  OK; the program is the 22.22.0 node and the checkout's bin.js with `bot start`; a second run left it unchanged; a
  different file was archived first; `launchctl list` shows no `dev.jevellan.bot`. 7/7.
- 2026-11-01 After the bot merge, the MCP transport test "a stale pid file is taken over" failed every run: the child
  died by SIGINT (exit code null) instead of exiting 0. `jv mcp --http` printed its URL line before it installed its
  signal handlers, and the redacted warning line printed in between had become slow enough (more secret sources) for
  the test's SIGINT to arrive first. A 300 ms delay made it pass, which confirmed the race. Fixed at the source: the
  server and `jv ui` now arm SIGTERM and SIGINT before the ready line (M-059); `jv bot start` already did.
- 2026-11-01 zod: both majors install side by side, as the brief expects. `npm ls zod` exits 0; the root and core,
  mcp, memory, planner and improver resolve zod 4.6.7; `packages/ui/node_modules/zod` is 3.25.76, and npm nests
  further 3.25.76 copies under `@a2ui/react` and `@a2ui/web_core`. The web bundle came out byte-identical with and
  without the Vite alias that points bare `zod` at the ui copy.
- 2026-11-01 A2UI `version: "1.0"` with @a2ui 0.14.0: not rendered. In Node with the processor and the report fixture,
  `version: "1.0"` fails validation (the v1.0 adapter's schema expects the literal "v1.0"); "v1.0" with the v0.9
  basic catalog is refused (catalog spec 0.9 does not match message version v1.0); "v1.0" with
  `@a2ui/web_core/catalogs/basic/v1` gets as far as component validation and refuses v0.9 component shapes (Text
  variant `h3`). So 1.0 surfaces would need "v1.0", the v1 catalog and 1.0 component shapes. The page shows
  "UI not rendered: unsupported version" and the rest of the report, as the brief specifies; core's contract keeps
  accepting "1.0".
- 2026-11-01 `@a2ui/react/styles/structural.css`, which the brief names, does not exist in 0.14.0: the export points
  at a file the package does not ship, and its `styles` entry holds the v0.8 renderer's `.a2ui-surface` rules. The v0.9
  basic catalog adopts its own element styles, and `a2ui-theme.css` maps them to the app's tokens (M-062).
- 2026-11-01 npm audit after the uiweb merge: dompurify 3.4.11 (critical, under @a2ui/markdown-it) and zod 3.25.76
  (high, nested under @a2ui). dompurify raised to 3.4.17 by an override (M-070); zod 3 left to the owner.
- 2026-11-01 Real UI server and web app, smoke on a temporary home with a project, a schedule, a goal, a memory and a
  queued job: the projects, project, memory, schedules, goals, jobs, decisions, usage, bot, doctor and not-found pages
  at 1280 by 800 light and 390 by 844 dark, with no console error, no failed API call and no sideways scroll.
- 2026-11-01 M6 UI actions: 11/11 in 1 min 35 s. In three runs out of three Jev placed the step on claude-sdk
  (claude-main, Sonnet medium); the first turn took 13 to 19 s, the answer turn with its 45 s sleep about 60 s. The
  needs-decision report, the answer turn (`answer:<message>`), the Stop and the Resume turn (`resume:<run>`) all stayed
  on one Claude native session.
- 2026-11-01 M6 found that the task page's Resume stayed disabled after Stop from the same action bar (core keeps the
  task running and marks only the run stopped) and that a discarded task offered Resume, which core refuses; both
  fixed with a web check (M-074). Also fixed: a path cut beside the "uncommitted" chip in Changes, the datalist
  indicator and a 6 px legend offset in the Override dialog.
- 2026-11-01 M7 Coordinator chat: 13/13 in 35 s. The coordinator (claude-main, Opus high, token login) was ready 1.8 s
  after `jv coordinator start`; its first status reply had responseMs 4255. The composer's "status" was typed into the
  pane 0.2 s after Enter and the reply was visible 5.1 s after Enter with responseMs 3983, so the page path (POST,
  typing, the 1 s tail, the change event, refetch) added 1.1 s. Two earlier runs: 4.4 s and 5.3 s.
- 2026-11-01 The owner's `~/.claude.json` changes during a journey without jv touching it: over one coordinator's 25 s
  life its sha1 changed in `cachedGrowthBookFeaturesAt` and `promptQueueUseCount`, written by the owner's own live
  sessions, while `numStartups` and the sandbox's `projects` entry stayed the same (M-079).
- 2026-11-01 Claude Code 2.1.316 in the coordinator pane shows each owner line as "[owner]  status" in the scrollback,
  "esc to interrupt" while working and a "done" line after each turn. Before M-078 the chat's tool lines read
  "ran /Users/ggomes/.jv-test/<run>/home/bin/jv stat..." cut at the column width.
- 2026-11-01 M8 A2UI: 23/23 in 37 s. Jev placed both read-only steps on claude-haiku-5-5 low via claude-main; each
  reported needs-decision within 10 to 15 s and each resumed turn ended within 3 to 6 s. A real step copied a v0.9
  surface given as JSON in its task text into `jv_report`'s `ui` exactly. Pressing its Button named answer posted
  `{name, surfaceId, sourceComponentId, timestamp, context: {label}}`; the server made it `jv task answer` with a
  messages row whose `meta_json` equals the action; the resumed turn's prompt was exactly "From the owner: <label>" and
  the final report named the option.
- 2026-11-01 A2UI "1.0" in the browser: a "1.0" createSurface next to a v0.9 surface in one report shows "UI not
  rendered: unsupported version" above the v0.9 surface, which still renders and posts; the summary, question, option
  buttons and status are unaffected. This confirms the Node finding on the real task page.
- 2026-11-01 Before M-081, reloading the task page after an A2UI post brought the surface back active with the step's
  first value, and pressing it again was refused ("task T is done, not waiting on an answer").
- 2026-11-01 M13 Bot recovery: the first run failed because the implement step (claude-sdk, Sonnet medium) finished
  in under 15 s, before the journey's kill. The task text now starts the first turn with a 90 s sleep and tells a
  resumed turn not to sleep again. Then 6/6 in 42 s: SIGKILL to the run's process group, one `jv bot tick` marked the
  run lost ("process ended without an end event") and resumed it on the same native session, the resumed turn ended
  done in 20 s, and bot.log names the lost run and its resume.
- 2026-11-01 M10 12/12 (part two: improve-memory merged the near-duplicates, one archived with superseded_by, none
  deleted), M11 9/9 (the scheduled task 33 s after the bot's start; pause held for 70 s), M12 10/10 (the plan job
  proposed 2 tasks with an after link; a second run the same day returned the same job), M14 7/7 (temporary owner
  home, M-071).
- 2026-11-01 Before the secrets fixes, a made-up 97-character value in secrets/ starting at character 3950 of a tool
  text kept its first 50 characters unmasked in the stored event, because the text was cut to 4000 and masked after;
  starting at 3990, 10 characters. The same order of cut, then mask, held for the 300-character error messages of both
  SDK runtimes, the synthesized llm summary and the UI action context. The worktree setup log and the agent SDK stderr
  were masked chunk by chunk. Checked with unit tests on the unchanged source.
- 2026-11-01 Before the fix, codex runs put project MCP env and header values on the Codex command line: a fake codex
  binary under @openai/codex-sdk 0.166.0 recorded '--config mcp_servers.tracker.env.TRACKER_REGION="..."' and
  '--config mcp_servers.docs.http_headers.X-Project="..."'. The Agent SDK 0.3.316 passed non-sdk servers as inline
  '--mcp-config {"mcpServers":{...}}' with their env and headers. Values listed in Options.extraArgs become '--<key>
  <value>'. Servers of type sdk with an instance stay in-process and trigger no inline --mcp-config.
- 2026-11-01 Claude Code as bundled with the Agent SDK 0.3.316 loads servers from a --mcp-config file passed through
  extraArgs beside the SDK's in-process server: system/init listed tracker with source 'dynamic' and jv with source
  'sdk', both connected, and the stdio server received the env written in the file. Temp HOME and CLAUDE_CONFIG_DIR,
  ANTHROPIC_BASE_URL a dead loopback port, no model reached.
- 2026-11-01 Codex 0.166.0 forwards the variables named in a stdio server's env_vars from its own environment and
  sends env_http_headers values from its environment as request headers. Checked with codex exec against a temp
  CODEX_HOME, a fake model provider on a dead port, a recording stdio server and a local HTTP server. `codex mcp list
  --json` shows both fields parsed. codex exec waits on stdin ('Reading additional input from stdin...') unless stdin
  is closed.
- 2026-11-01 The Agent SDK calls the stderr option with decoded pipe chunks (sdk.mjs: child.stderr on data through a
  StringDecoder), not lines, so a value can be split between two calls.
- 2026-11-01 Before the fix, caller text was stored and typed as given: with a made-up value in secrets/, createTask
  stored it in title, task_text and task.md; messageTask stored it and typed 'From the owner: ...<value>'; answerTask,
  jv memory add, jv_memory_add, addGoal and addSchedule stored it; jv_memory_search and the jv://tasks/{id} resource
  returned rows holding it. Checked with unit tests in scratch homes.
- 2026-11-01 Before the fix, scripts/secret-scan.mjs --values-from <home>/ui-password exited 2 with ENOTDIR, and a
  UI-password value in a tracked docs file passed M16's scan arguments (--values-from ~/.jv/secrets) with exit 0.
  Checked in a scratch repository and home.
- 2026-11-01 Process signalling: jv attach leaves a waiting row with the pid and pgid of a jv run that has ended, and
  stopTask passed every waiting row to stopRun. The verifier's script, rerun in a scratch JV_HOME (fake tmux attach,
  then the recorded pid pointed at a detached `sleep 300` that leads its own group): on main stopTask --discard killed
  the sleep with SIGTERM; on the fixed branch it stopped the row in 304 ms and left the sleep alive.
- 2026-11-01 On this machine `ps -ww -A -o pid=,pgid=,args=` lists the whole process table (657 rows, about 225 KB) in
  about 60 ms. `LC_ALL=C ps -o lstart= -p <pid>` prints a date like `Sun Nov 1 21:34:26 2026`, which Date.parse reads.
- 2026-11-01 `node -e <code> --session R` is refused by Node ('bad option: --session'); `node -e <code> -- --session
  R` passes the words through to the script.
- 2026-11-01 runWorktreeSetup on main left its abort listener on the run's AbortController after an `echo setup` had
  finished (getEventListeners(signal, 'abort') was 1), and a later abort called process.kill on the old setup group;
  with the fix the count is 0 and no call is made.
- 2026-11-01 jv bot stop against a stale bot.lock that names `node <dir>/owner-telegram-bot/index.mjs` (built CLI,
  scratch JV_HOME). On main the process got SIGTERM and acquireBotLock refused 'bot already running'. With the fix, a
  lock whose startedAt is older than the process start gives exit 0 'bot not running' and the lock is taken over; a
  plain '<pid>' lock gives exit 2 'could not verify that pid N is the bot'. The process was untouched both times.
- 2026-11-01 doctor.ts reads no process start times; before this change only packages/ui/server/pidfile.ts did (ps -o
  lstart, LC_ALL=C). jevellan-core/proc now has processStartedAt.
- 2026-11-01 codex-cli 0.154.0 creates `$CODEX_HOME/tmp/arg0/codex-arg0XXXX/` (.lock plus the symlinks apply_patch,
  applypatch and codex-execve-wrapper) on every start, `--version` included, and the folder stays after exit. With
  CODEX_HOME unset it uses `$HOME/.codex` (created if missing). With CODEX_HOME pointing at a missing folder it writes
  nothing but prints "WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to ... but
  that path does not exist" on stderr. Repeated runs in one home leave one arg0 folder, because each run removes the
  unlocked ones. Checked with env -i and scratch HOME, CODEX_HOME and TMPDIR.
- 2026-11-01 With a scratch HOME and TMPDIR, `claude --version` (2.1.316), `git --version` (2.56.0) and `tmux -V`
  (3.5a) write nothing under HOME or TMPDIR.
- 2026-11-01 Before the probe-home change, jv doctor's `codex --version` ran with the owner's HOME (execCommand's
  process.env default), so every `jv doctor`, MCP `jv_doctor` call and M1 run wrote into ~/.codex/tmp/arg0. After it,
  a real `jv doctor --check codex --check claude --json` with a temporary JV_HOME was OK for both, the arg0 folder
  appeared under `$JV_HOME/run/probe-home/.codex`, and `ls -la ~/.codex/tmp/arg0` was identical before and after.
- 2026-11-01 Claude Code 2.1.316 with both HOME and CLAUDE_CONFIG_DIR set keeps its user config under
  CLAUDE_CONFIG_DIR: `claude mcp add --scope user` wrote `$CLAUDE_CONFIG_DIR/.claude.json` and
  `$CLAUDE_CONFIG_DIR/backups/` and nothing under HOME (scratch folders, nonessential traffic disabled, no model
  reached). A tool shell of a Claude Code session carries `CLAUDECODE=1`, so variables a session is launched with
  reach the journeys it runs.
- 2026-11-01 git 2.56.0 pathspecs: `git ls-files -- 'packages/*/src'` lists 0 files, while
  `':(glob)packages/*/src/**'` lists 132 and `'packages/*/src/*'` many. A wildcard pathspec without :(glob) has to
  match the whole path. M17's old grep therefore searched only packages/ui/server and passed with a committed spawn of
  jevellan in packages/core/src (scratch clone of main). The new check finds that call, a call wrapped across lines,
  an absolute-path execFileSync, a shell string, cp.spawnSync, and untracked files under acceptance/ and
  packages/core/src, and passes on the clean tree with 508 files searched.
- 2026-11-01 VACUUM INTO through a second connection opened readOnly succeeds while another connection on the same
  file holds BEGIN IMMEDIATE. It writes a rollback-journal database (header bytes 18-19 are 1), not a WAL one, accepts
  an existing empty target file, and keeps that file's mode. Node 22.22.0, SQLite 3.50.4. Checked with a scratch
  script on a temporary store and through store-v2.test.ts, which asserts the backup is mode 600 with no side files.
- 2026-11-01 Before the migration fix, six child processes opening one 20 MB version 1 store behind a file barrier had
  at least one opener fail with 'table projects already exists' in 5 of 5 runs (store-v2.test.ts '6 processes open a
  version 1 store at once' run against main's store.ts). With the copy under the write lock: 8 runs of 3 rounds each,
  and 3 runs of 6 worker threads (the reviewers' race-threads.mjs), all ended with every opener at schema 2 and one
  backup.
- 2026-11-01 Before the migration fix, the 1-to-2 migration took an empty, random-bytes or interrupted (hot -journal)
  store.sqlite.v1.bak as its backup, as well as a complete but stale or foreign version 1 copy. An opener with an
  extension registered that waited while a host without it migrated or created the store opened it without the
  extension's tables. All checked with store-v2.test.ts against main's store.ts.
- 2026-11-01 A 154 MB version 1 store (15000 events of 10 KB) migrates on first open in 0.63 s, copy, check and
  migration included. SIGINT to the opener during its copy left the store at version 1 with store.sqlite.v1.bak.tmp
  (3.4 MB, mode 600) and a 1 KB journal. The next open set both aside as .v1.bak.partial-<time> and took a complete
  backup (15000 events, quick_check ok). A copy that fails on a write (ulimit -f with SIGXFSZ ignored, standing in for
  a full disk) throws 'could not copy ... before migrating it (disk I/O error); the store is unchanged' and leaves no
  partial file, and the next open migrates. Checked with scratch scripts on temporary stores, plus the
  store-v2.test.ts write-error test.
- 2026-11-01 Phase 7 review of what is crucial (brief section 13, phase 7): four reviewers (secrets handling, the
  never-delete rules, the member and the owner's configuration untouched, schema migration) and two independent
  verifiers per finding. 18 findings, some reported twice; 12 confirmed by both verifiers and fixed with reproducing tests (M-083 to
  M-095); 2 disputed (journey children inheriting CLAUDE_CONFIG_DIR, extensions skipped after another process
  migrated) reproduced as real and fixed; 3 refuted by both verifiers and left: improve-memory rewording a memory in
  place (the reword is logged in memory_log with the job, and the old wording stays in the store with the job's
  task), M17's file check not seeing moves, symlinks or chmod (real, but no jv path writes there: providerHomeProblem
  refuses any provider home inside ~/.jevellan*, symlinks resolved, at load, before seeding and at run time), and
  M17's exclusions of the member's hub/, locks/ and cleanup/ (recorded in M-036). Known and left: landing check tails are cut before
  masking (same class as M-083, lower likelihood), event rows written before M-083 are not rewritten (the MCP and UI
  mask on the way out), and `jv bot start` in a terminal ignores SIGHUP's default (its lock is now harmless).
