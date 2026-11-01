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
