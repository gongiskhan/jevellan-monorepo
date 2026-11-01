# Working in jevellan-monorepo

This repository is Jevellan as a set of npm workspaces: the `jv` engine as a library, the `jv` command, and (as the
build goes on) the control MCP, cross-agent memory, the web UI, the always-on bot, schedules, the planner and the
improver. The engine was lifted from the runtime of `gongiskhan/jevellan-skills` (the `jv` under
`.apm/skills/jevellan-router/scripts/jv/`, at the commit M-001 names) with its tests, its store schema, its report
contract and its decisions. The skills themselves (`SKILL.md` bodies, workflows, the coordinator agent, the Stop
hook) stay in `jevellan-skills`; `jv bootstrap --skills <checkout>` installs them into `~/.jv/skills/`, the only
place `jv` reads them from. The checkout is the install (M-007): `~/.jv/bin/jv` runs
`<checkout>/packages/cli/dist/bin.js`.

Every choice made while building it is in `docs/decisions.md` and every verified fact in `docs/findings.md`. Read
both before changing behaviour they describe, and add to them when you decide or verify something new.

## Rules that bind every file

- No AI attribution anywhere: no `Co-Authored-By`, no `Claude-Session`, no "Generated with", no model named as an
  author in commit messages, authored text, generated reports or UI copy. Commits use the machine's git identity.
  This holds even when tooling suggests adding a trailer.
- No tracked `CLAUDE.md` and no tracked `.claude/` directory, here or in any project the system touches; both are
  in `.gitignore`. Agent instructions live in `AGENTS.md`.
- Never touch production, never deploy anything, never answer a deploy message.
- Never stop or delete the owner's processes or data. Archive, never delete: nothing deletes a store row, a
  worktree of an unlanded task, a memory or a file the owner keeps; things that go away are moved under
  `~/.jv/archive/`. Worktrees are removed only after their branch has landed or the owner discarded the task.
- Task work happens in git worktrees; nothing edits a project's main checkout except landing. Work on this
  repository the same way: a branch and a worktree (for example `git worktree add ~/.worktrees/jv-mono/<name> -b
  <branch> main`), never edits in `~/dev/jevellan-monorepo` itself.
- Secrets never appear in logs, events, reports, the store, test fixtures, command lines or the UI. Keys and tokens
  live only in `~/.jv/secrets/*` (mode 600, folder mode 700) and reach processes through the environment that
  `jv exec` builds (D-007). Tests use made-up values (`fake-...`) that match no secret shape of
  `scripts/secret-scan.mjs`; a test that needs a token shape builds it from parts at run time.
- The Jevellan member on this machine is never touched: the launchd jobs `dev.jevellan.daemon` and
  `dev.jevellan.playground.daemon`, the folders `~/.jevellan`, `~/.jevellan-member`, `~/.jevellan-playground` and
  `~/jevellan-projects/*` (except a sandbox made for jv), the ports 9771 and 9772, and the `jevellan` command. Never
  run `jevellan`, never write under `~/.jevellan*`, never load or unload a launchd job.
- The owner's own Claude Code and Codex configuration is not modified (`~/.claude`, `~/.claude.json`, `~/.codex`).
  jv writes only into provider homes under `~/.jv/homes/` (D-008, D-015).
- Plain dash "-", never the em dash, in every file. No emoji in UI code. No third-party dependency beyond the
  brief's list (section 2) and M-003's lint packages, at exact versions.

## Node

Node 22.13 or later (`node:sqlite`). On this machine the default `node` may be another version, so every command
uses the 22.22.0 binary by path:

```sh
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
```

`bin/jv.mjs` refuses an older Node and names an installed nvm Node 22 when it finds one.

## Layout

```
package.json            private root: workspaces, scripts build, typecheck, test, lint, scan:secrets, journeys
tsconfig.base.json      strict, noUncheckedIndexedAccess, noImplicitOverride, NodeNext, ES2022, ES2023 lib (M-010)
tsconfig.json           project references: packages/core, packages/ui, packages/cli (tsc -b)
eslint.config.mjs       lint (copied from gongiskhan/jevellan at 8e2788ec, adjusted)
bin/jv.mjs              jv from this checkout: Node check, then packages/cli/dist/bin.js
docs/decisions.md       M-001 onwards, append-only
docs/findings.md        verified facts about this machine and the packages, dated, append-only
acceptance/             acceptance journeys M1 to M17 and their RESULTS.md; baseline/ holds the phase 0 records
scripts/                secret-scan.mjs, bump-version.mjs, sync-from-skills.mjs and their tests in scripts/test/
packages/core/          jevellan-core: the lifted engine (store, tasks, Jev placement, landing, runtimes, coordinator)
packages/cli/           jevellan-cli: the jv command (src/cli.ts command table, src/command.ts, src/commands/*.ts)
packages/ui/            jevellan-ui: for now the lifted read-only viewer: server/ (TypeScript), viewer/ (browser files)
```

Packages that later phases add: `packages/mcp` (jevellan-mcp), `packages/memory` (jevellan-memory), `packages/bot`
(jevellan-bot), `packages/scheduler` (jevellan-scheduler), `packages/planner` (jevellan-planner) and
`packages/improver` (jevellan-improver). A package joins the root `workspaces` list and `tsconfig.json`'s references
when it gets its `package.json`.

Dependency direction, declared in each `package.json` (a package lists only what it imports): `jevellan-core`
depends on nothing in the repository; `jevellan-ui` depends on `jevellan-core`; `jevellan-cli` depends on
`jevellan-core` and `jevellan-ui`, and loads each command module lazily from its command table, so only `jv ui`
loads `jevellan-ui/server`. The brief's section 2 gives the direction for the later packages: memory depends on
nothing here; scheduler, planner, improver and mcp on core (and memory where they use it); bot on core, memory,
scheduler, planner and improver; ui on all of those but bot, which it only observes through the store; cli on
everything, loading ui, bot and mcp lazily. Other packages import core's modules by subpath,
`import { openStore } from 'jevellan-core/store'` (`jevellan-core/<module>` resolves to `dist/<module>.js`, M-008).

Where the lift put the runtime's files (M-008): `src/cli.ts`, `src/command.ts` and `src/commands/*` in
`packages/cli/src`, `src/ui/*` in `packages/ui/server`, `ui/*` in `packages/ui/viewer`, every other `src` module and
`templates/` in `packages/core`, test files with the package whose code they drive. The skills the tests read are a
copy in `packages/core/test/fixtures/skills/`, whose `SOURCE.json` records the jevellan-skills commit it came from;
the checkout at `~/dev/jevellan-skills` stays at that commit (M-001).

## Commands

Run at the repository root unless a folder is named.

```sh
npm ci                                   # install (node_modules at the root; workspace links are relative)
npm run build                            # tsc -b --pretty false: every package's src/ to dist/
npm run typecheck                        # the same command; the compiler is the main lint
npm test                                 # build, then every workspace's npm test
(cd packages/core && npm test)           # one package: tsc -p tsconfig.test.json, then node --test over dist-test/
npm run lint                             # eslint .
npm run scan:secrets                     # node scripts/secret-scan.mjs: tracked files, exit 1 naming file:line
node --test "scripts/test/*.test.mjs"    # the scripts' own tests (Node 22 takes a glob here, not a folder)
```

The cli tests run the built command, so build before them. One suite of a package, after its `tsc -p
tsconfig.test.json`: `node --disable-warning=ExperimentalWarning --test dist-test/test/store.test.js` (core suites
also need `--import ./dist-test/test/setup.js`, see Tests).

Scripts:

- `node scripts/secret-scan.mjs [--untracked] [--history] [--values-from DIR]`: scans the tracked files (and
  untracked, not ignored ones, or every blob in the history, when asked) for key, token and private key shapes, and
  with `--values-from ~/.jv/secrets` for the exact values of the key files; prints file, line and the kind of
  shape, never the value; exit 0 clean, 1 found, 2 could not scan. It installs no git hook.
- `node scripts/bump-version.mjs <version>`: one exact version in the root `package.json`, every
  `packages/*/package.json`, every dependency one workspace package has on another, and `package-lock.json`'s
  workspace entries. `--check [<version>]` changes nothing and exits 1 naming each difference.
- `node scripts/sync-from-skills.mjs [--skills PATH] [--lifted COMMIT] [--json]`: what changed in a jevellan-skills
  checkout (default `~/dev/jevellan-skills`) since the lifted commit of `SOURCE.json`, one line per file with where
  it lives here, plus the skill files whose copy in the fixture needs a refresh. Read-only. Prints `nothing changed
  since <commit>` when so.

## Code conventions (kept from the lifted runtime)

- ESM with explicit `.js` extensions in imports (`import ... from './x.js'`). Node built-ins for everything the
  brief lists no dependency for (`node:sqlite`, `node:http`, `node:child_process`, `node:fs`, `node:crypto`).
- `JV_HOME` (default `~/.jv`) is resolved once in `packages/core/src/paths.ts`; nothing else reads `os.homedir()`
  for jv paths.
- Store: `packages/core/src/store.ts` owns the schema (version 1 as lifted, version 2 of brief section 3), the
  pragmas (WAL, `busy_timeout` 5000, `synchronous=NORMAL`, `foreign_keys=ON`), short `BEGIN IMMEDIATE` write
  transactions and the request id rule (same id and same input returns the row, different input exits 4). Nothing
  is ever deleted from the store.
- Errors: core throws `JvError(message, exitCode)` and never prints; the command layer prints the message (or
  `{"error": ...}` with `--json`) and exits 0, 2 refused, 3 not found, 4 conflict. Every command accepts `--json`.
- Times are ISO 8601 UTC strings (`new Date().toISOString()`); every state change writes a short human
  `state_reason`.
- Placement has one code path (`packages/core/src/route.ts`) and no fallback model.
- Config files (`providers.json`, project files, workflows, `landing.json`) are validated strictly: an unknown key
  exits 2 naming it.
- Every module starts with a header comment saying what it does and which decisions (D- and M-numbers) shape it;
  keep it current when the module changes.
- Lint: `eslint.config.mjs` uses `@eslint/js` and `typescript-eslint` recommended rules. A leading underscore marks
  a deliberately unused name; tests may use `any`.

## Tests

- `node:test` everywhere; the suites are TypeScript compiled to `dist-test/` by each package's `tsconfig.test.json`.
  The scripts' tests are plain ESM in `scripts/test/`.
- Every test file creates its own temporary `JV_HOME` (`mkdtempSync` under `realpathSync(tmpdir())`, since `tmpdir()`
  is a symlink on macOS, M-009) and sets `process.env.JV_HOME` before it imports any jv module: imports are dynamic,
  after that line, because paths resolve `JV_HOME` once. No test reads or writes the real `~/.jv`, `~/.claude`,
  `~/.codex` or anything under `~/.jevellan*`.
- No test reaches a model, Jev, a provider or a real tmux session: effects go through injected dependencies
  (`DoctorDeps`, `CoordinatorDeps`, tmux runners, Jev clients, `fetch`) and the fixtures under `test/fixtures/`.
- Test-only environment hooks, named as such in their modules: `JV_TEST_RUNTIME_MODULE` (a fake runtime for the
  detached `jv run`), `JV_TEST_WORKER_RULES`, `JV_TEST_WORKER` and `JV_TEST_WORKER_ARGS` (the concurrent writer
  child), and `JV_CLI_ENTRY`, the entry detached processes run (M-007): core's tests preload
  `dist-test/test/setup.js`, which points it at core's own test entry, since core has no command layer.
- Temporary git repositories in tests run git without the machine's configuration (`GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`) and with an identity given on the command line.
- A failing or flaky test is fixed, not skipped. `npm test` and `npm run typecheck` pass before every commit.

## Acceptance journeys

`acceptance/` holds the journeys M1 to M17 of the brief (section 14), written in the later phases: plain ESM
scripts that drive the installed `jv` against the sandbox project and assert on the store with `jv ... --json`.
They use real providers and Jev, so they cost quota; they are run deliberately, never from `npm test`, and their
results go to `acceptance/RESULTS.md`. `acceptance/baseline/` holds what phase 0 recorded for M17.

## Decisions and findings

- `docs/decisions.md`: choices the brief left open or that the machine forced, numbered M-001 onwards, append-only.
  Each says what and why. A later decision amends an earlier one by number ("amends M-007"); it never edits it.
  The D-numbers are the skills repository's (`docs/decisions.md` there) and every one holds here unless an
  M-number changes it.
- `docs/findings.md`: what was verified on this machine about the tools, the SDKs, the lifted runtime and the
  packages; dated entries, append-only, each saying how it was checked.

## Commits

One commit per coherent change at least, with a message that says what and why, the machine's git identity, and no
trailers of any kind. Never commit build output (`dist/`, `dist-test/`, `*.tsbuildinfo`, `node_modules/`),
`.jv-evidence/`, store files, `CLAUDE.md` or `.claude/`. Run `npm run scan:secrets` before pushing.

## Releasing

Every package carries the same version: `node scripts/bump-version.mjs <version>`, then `node
scripts/bump-version.mjs --check`, a `CHANGELOG.md` section, a commit, and the tag `v<version>`. Publishing to npm
is not part of this repository's work yet (brief section 15).
