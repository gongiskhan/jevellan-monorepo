# jevellan-monorepo

Autonomous development, coordinated. Jevellan runs software tasks for a project's owner: a coordinator session you
talk to turns work into tasks, every step of a task is placed by Jev (which model, effort and account), runs in its
own git worktree, reports what it did, and lands on the default branch or waits for you. This repository holds every
package of it except the skills:

| Package | What it is |
| --- | --- |
| `jevellan-core` | the engine as a library: the store, tasks, Jev placement, landing, the runtimes, reconcile, the coordinator, jobs, worker tools |
| `jevellan-cli` | the `jv` command |
| `jevellan-mcp` | the control MCP: operate Jevellan from Claude Code, the Claude app or Codex |
| `jevellan-memory` | what every agent remembers between sessions |
| `jevellan-ui` | the web app over the store, from the phone too |
| `jevellan-bot` | the always-on loop: the queue, recovery, schedules and jobs |
| `jevellan-scheduler` | schedules: five-field cron in a time zone |
| `jevellan-planner` | goals, turned into queued tasks |
| `jevellan-improver` | jobs that tidy memory, update documentation and propose skill changes |

`docs/architecture.md` is the one-page picture; `docs/decisions.md` records every choice (M-numbers; the D-numbers
are the skills repository's) and `docs/findings.md` every verified fact. `AGENTS.md` is how to work in this
repository.

The skills (the placement and landing policies, the duties, the workflows and the coordinator) live in
[gongiskhan/jevellan-skills](https://github.com/gongiskhan/jevellan-skills) and are installed from a checkout of it.

## Requirements

- macOS or Linux, with git and tmux.
- Node 22.13 or later (the store uses the built-in `node:sqlite` with FTS5).
- Claude Code (`claude` on PATH) and at least one Claude account (a long-lived token from `claude setup-token`, or a
  login), or an Anthropic-compatible endpoint. Optional: Codex for a ChatGPT account.
- A Jev API key.
- A checkout of `gongiskhan/jevellan-skills`.
- Optional: Tailscale, to reach the UI and the MCP from a phone or the Claude app.

## Install from the checkout

The checkout is the install: `~/.jv/bin/jv` runs this checkout's `packages/cli/dist/bin.js`.

```sh
git clone https://github.com/gongiskhan/jevellan-monorepo.git ~/dev/jevellan-monorepo
git clone https://github.com/gongiskhan/jevellan-skills.git ~/dev/jevellan-skills
cd ~/dev/jevellan-monorepo
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"     # a Node 22.13 or later first on PATH
npm ci && npm run build
node bin/jv.mjs bootstrap --skills ~/dev/jevellan-skills
export PATH="$HOME/.jv/bin:$PATH"                              # the line the bootstrap prints; put it in ~/.zprofile
jv --version                                                   # jevellan 0.1.0 (store schema 2, skills 0.1.0)
```

`jv bootstrap` writes `~/.jv` (`JV_HOME` overrides it): the shim, `install.json`, a link `~/.jv/runtime` to
`packages/core`, the fourteen `jevellan-*` skills from the skills checkout into `~/.jv/skills/` (a versioned skill set
behind a link), `providers.json` from the template when it is missing, one home per provider with the Stop hook, the
skills and the coordinator agent. `jv update` does the same again from the recorded checkout and skills (after a `git
pull` and `npm run build` here, or a pull of the skills) and never touches the store.

The skills repository's own `jv` and this one cannot share a `~/.jv`: this `jv` migrates the store to schema 2 on
first open (keeping `store.sqlite.v1.bak`), and the skills runtime refuses a schema 2 store.

## First run

1. `jv doctor` inside a project checkout. Each line is OK, WARN or FAIL with the fix; it exits 2 while anything fails.
2. Write the keys without putting them on a command line, one file each, mode 600:

   ```sh
   (umask 077 && cat > ~/.jv/secrets/jev.key)              # paste, Enter, Ctrl-D
   (umask 077 && cat > ~/.jv/secrets/claude-main.token)    # from claude setup-token
   ```

   and name them in `~/.jv/providers.json` (`jev.keyFile`, a provider's `tokenFile` or `keyFile`).
3. `jv providers check`: every enabled provider's login and usage, and whether Jev answers.
4. `jv project add <path> [--name N]`, then check `testCommand` and `devCommand` in `~/.jv/projects/<name>/project.json`.
5. `jv coordinator start --project <name>` and talk to it in the UI's project page, or `tmux attach -t '=jv-coord-<name>'`.
6. `jv ui` and open http://127.0.0.1:7071 (the password is in `~/.jv/ui-password`, shown once at the first start).
7. `jv bot start` (or install it as a service, below) so the queue, schedules and jobs keep moving.

## jevellan-cli: the jv command

Every command accepts `--json` (the shape the coordinator, the MCP and the UI read). Exit codes: 0 ok, 2 refused with
the reason, 3 not found, 4 conflict.

```
jv bootstrap [--skills PATH] [--node PATH]      install this checkout as ~/.jv's jv (the shim, skills, provider homes)
jv update                                       the same from the recorded checkout and skills; never touches the store
jv --version                                    jevellan 0.1.0 (store schema 2, skills <jv-version>)
jv doctor [--check NAME]                        preflights, one line each with the fix
jv project add <path> [--name N] | jv project list
jv providers check | jv providers login <name>
jv status [--project N] [--watch]               what is not done, waiting on you first; the bot line on top
jv task create --project N --kind feature|bug|automation|single [--duty D] --title T (--text "..." | --file F)
               [--parent T] [--after T] [--visible] [--request-id ID]
jv task list [--project N] [--state S] [--limit N]
jv task show|resume T
jv task changes T [--stat]                      the branch against its base, plus the worktree's uncommitted changes
jv task message T "text" | jv task answer T "<option or text>"
jv task stop T [--discard] | jv task override T --model M [--effort E] [--provider P] --undo|--keep
jv land T [--force]
jv report R | jv tail R [--follow] | jv attach R
jv coordinator start|stop|restart|status --project N
jv coordinator message --project N "text"       types a line into the coordinator
jv handoff --project N | jv notes write --project N < text | jv notes show --project N
jv evals route|landing [--since DATE] [--out FILE]
jv usage [--week W] | jv gc [--project N] [--dry-run]
jv memory ...  jv schedule ...  jv goal ...  jv job ...  jv improve ...  jv bot ...  jv mcp ...  jv ui ...   (below)
```

A task created by `jv task create` starts its first step at once when a slot is free (the bot's limits, below), and
waits `queued` with the reason "waiting for a slot" otherwise; the bot starts it when one frees.

## jevellan-memory

What every agent remembers between sessions, whatever runtime it runs on. Workers remember through the `jv_remember`
tool and search through `jv_recall`; every worker and coordinator prompt carries "What this project remembers:"
(environment and preference memories first, then what the task recalls). Scopes: `global`, `project:<name>` and
`machine:<hostname>`. Nothing deletes a memory: archive is the only removal, and the improver merges duplicates.

```
jv memory add --scope global|project [--project N] --kind fact|preference|lesson|environment|decision [--tag t]... "text"
jv memory search [--project N] "query"
jv memory list [--project N] [--kind K] [--status active|archived]
jv memory archive M --reason "..."
jv memory export [--project N]                  Markdown to stdout
```

`~/.jv/projects/<name>/memory.md` is regenerated after every write to the project's scope, for people and for agents
that only read files.

The coordinator skill tells the coordinator to keep the owner's standing preferences in `notes.md`. A `preference`
memory (`jv memory add --scope global --kind preference "..."`) is the better home: then every worker sees it too.
The skills decide when to adopt that (M-number in docs/decisions.md).

## jevellan-mcp: the control MCP

One MCP server that lets any MCP client operate Jevellan the way you do with `jv`: `jv_status`, `jv_task_create`,
`jv_task_answer`, `jv_land`, `jv_coordinator_message`, `jv_memory_search`, `jv_schedule_add`, `jv_job_run` and the rest
of section 5 of the brief, each returning the same JSON as the matching `jv ... --json`. No tool deletes anything or
touches providers, secrets or your configuration.

```
jv mcp [--stdio]                                 stdio (what an MCP client starts)
jv mcp --http [--port 7072] [--bind 127.0.0.1] [--token-reset]
```

Register it in your own Claude Code (one command, run it yourself):

```sh
claude mcp add jv -- ~/.jv/bin/jv mcp
```

and in Codex:

```sh
codex mcp add jv -- ~/.jv/bin/jv mcp
```

Over HTTP every request needs `Authorization: Bearer <token>`; the token is written once to `~/.jv/secrets/mcp.token`
at the first start (shown once) and `--token-reset` rotates it. `GET /health` answers without it. For the Claude app,
reach it over Tailscale with HTTPS from Tailscale itself:

```sh
jv mcp --http &
tailscale serve --https=443 http://127.0.0.1:7072
```

then add `https://<this machine>.<tailnet>.ts.net/mcp` as a connector with the token. Each call is one line in
`~/.jv/logs/mcp.log` (tool, ids, duration, exit code; never arguments).

## jevellan-ui: the web app

```
jv ui [--port 7071] [--bind 127.0.0.1] [--readonly] [--password-reset]
```

Projects, the conversation with each project's coordinator, tasks (steps, sessions, reports with their A2UI surfaces,
the landing, Message, Answer, Stop, Resume, Override, Changes), sessions, decisions, usage, memory, schedules, goals,
jobs, the bot and doctor. Sign in with the password in `~/.jv/ui-password` (written at the first start and shown once;
`--password-reset` makes a new one). `--readonly` offers and accepts no action. On the phone, bind it to this
machine's tailnet address and add it to the home screen:

```sh
jv ui --bind "$(tailscale ip -4)"
```

## jevellan-bot: the always-on loop

```
jv bot start                                     foreground (what the service runs)
jv bot stop | jv bot status | jv bot tick        tick runs exactly one tick
jv bot install-service                           writes the launchd or systemd file; you load it
```

Every tick (15 s by default): heartbeat, reconcile (lost runs resumed, queued tasks admitted under the limits,
messages and wake lines delivered), the coordinators' conversations tailed, due schedules fired, jobs stepped, and
once an hour the provider probes, `jv gc` and trimming `~/.jv/logs/bot.log`. Health: `GET
http://127.0.0.1:7073/health`. The configuration is `~/.jv/bot.json`, written with the defaults at the first start:

```json
{ "tickSeconds": 15, "limits": { "perProject": 2, "total": 4 }, "quietHours": null,
  "health": { "bind": "127.0.0.1", "port": 7073 }, "logLines": 20000 }
```

`quietHours` (`{ "from": "23:00", "to": "07:00" }`, local time) stops admissions and schedules in that window while
lost sessions are still recovered and messages delivered.

Install it as a service, then load it yourself:

```sh
jv bot install-service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.jevellan.bot.plist     # macOS; stop: launchctl bootout gui/$(id -u)/dev.jevellan.bot
systemctl --user enable --now jevellan-bot                                         # Linux
```

## jevellan-scheduler: schedules

```
jv schedule add --project N --name "..." --cron "M H DoM Mon DoW" [--tz Zone]
                (--task-kind K [--duty D] --title T --text "..." [--visible] | --job plan|improve-memory|improve-docs|improve-skills)
jv schedule list [--project N] | jv schedule show S | jv schedule run S | jv schedule pause S | jv schedule resume S
```

Cron is five fields (numbers, ranges, lists and steps; no names; day of week 0 to 6, 0 Sunday) in the schedule's time
zone (this machine's by default), daylight saving as Vixie cron handles it. The bot fires due schedules; a slot
missed while the bot was down fires once, late. Examples you may add:

```sh
jv schedule add --project my-app --name "Nightly tests" --cron "0 3 * * *" --task-kind single --duty verify \
  --title "Nightly tests" --text "Run the project's test command and the browser journeys. Report testsRun."
jv schedule add --project my-app --name "Plan" --cron "30 3 * * *" --job plan
jv schedule add --project my-app --name "Tidy memory" --cron "0 2 * * *" --job improve-memory
jv schedule add --project my-app --name "Docs" --cron "0 4 * * 1" --job improve-docs
jv schedule add --project jevellan-skills --name "Skills" --cron "0 5 * * 1" --job improve-skills
```

## jevellan-planner: goals

```
jv goal add --project N --title T --text "..." [--priority 1..5]
jv goal list [--project N] | jv goal show G | jv goal done G | jv goal pause G
jv job run plan --project N [--force]
```

A plan job asks one planning task (read-only) for the next few tasks that move the open goals forward; it creates
them `queued`, with `--after` links where proposed, and the bot starts them under its limits. One plan job per
project and day unless `--force`.

## jevellan-improver: jobs

```
jv job run plan|improve-memory|improve-docs|improve-skills --project N [--force]
jv job list [--project N] | jv job show J | jv job cancel J
jv improve memory|docs|skills --project N        shorthand for jv job run improve-<x>
```

`improve-memory` merges, archives, adds and dates memories from the recent reports (nothing deleted);
`improve-docs` brings the documentation up to date with what landed, through the normal landing; `improve-skills`
improves the placement and landing policies from the evidence on the registered project `jevellan-skills` (`jv
project add ~/dev/jevellan-skills --name jevellan-skills`), and every such change waits for you to land or leave it.

## How the skills are installed

`jv bootstrap --skills <checkout>` (and `jv update`) copy the fourteen `jevellan-*` skill folders of the skills
checkout's `.apm/skills/` (the router without its `scripts/`) into `~/.jv/skills/`, and the coordinator agent and the
Stop hook into every Claude provider home. `jv` reads skills from `~/.jv/skills/` only. `jv doctor` says when the
installed skills differ from the checkout (`jv update`).

## After this release: reconciliation with jevellan-skills

`scripts/sync-from-skills.mjs` lists what changed in the skills repository's runtime since it was lifted here, so
those changes land here as one task; then `jevellan-skills` moves into `packages/skills` with its `scripts/jv/` removed
and its bootstrap becoming `jv bootstrap --skills <that folder>`.

## Development

```sh
npm run build          # tsc -b and the web app
npm test               # every package's tests and the scripts' tests
npm run typecheck      # tsc -b --pretty false
npm run lint           # eslint
npm run scan:secrets   # the secret scan of the tracked files
npm run journeys       # the acceptance journeys M1 to M17 (real providers; they cost quota)
```

## License

MIT
