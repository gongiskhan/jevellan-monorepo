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
