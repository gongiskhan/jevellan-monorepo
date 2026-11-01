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
