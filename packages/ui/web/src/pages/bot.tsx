// /bot (brief sections 7 and 8): the bot's heartbeat age, pid and uptime, the limits and quiet hours of bot.json,
// the queue (queued tasks with their wait reason), the last 100 lines of ~/.jv/logs/bot.log, and, when no service file
// exists, how to install one (loading it is the owner's step; the UI runs nothing). GET /api/bot.

import { getBot, useResource } from '../api.js';
import { CommandLine, ErrorLine, Fact, Loading, PageHeading, RouteLink, Stamp, useNow } from '../components.js';
import { relativeDuration, secondsText } from '../time.js';
import { botLineText } from './projects.js';

export function BotPage() {
  const now = useNow(1000);
  const bot = useResource('bot', (signal) => getBot(signal));
  const data = bot.data;
  if (!data) return bot.error ? <ErrorLine text={bot.error} /> : <Loading />;
  const state = data.bot;
  const limits = data.config.limits ?? state.limits;
  const quiet = data.config.quietHours;
  return (
    <div className="list-page bot-page">
      <PageHeading title="Bot" intro="The always-on loop: it keeps the queue moving, recovers lost sessions, fires schedules and jobs, and leaves this heartbeat." />
      <ErrorLine text={bot.error} />
      <section className={`card bot-card ${state.alive ? 'alive' : 'down'}`} aria-labelledby="bot-state">
        <h2 id="bot-state" className="bot-headline">
          <i className="bot-dot" aria-hidden="true" />
          {botLineText(state)}
        </h2>
        <dl className="facts">
          <Fact label="Heartbeat">{state.heartbeatAt ? <><Stamp at={state.heartbeatAt} /> ({secondsText(Math.max(0, Math.round((now - Date.parse(state.heartbeatAt)) / 1000)))} ago)</> : 'never'}</Fact>
          <Fact label="Pid">{state.pid ?? '-'}</Fact>
          <Fact label="Uptime">{state.alive && state.startedAt ? relativeDuration(state.startedAt, now) : '-'}</Fact>
          <Fact label="Tick">{state.tick ?? '-'}{data.config.tickSeconds ? ` (every ${data.config.tickSeconds} s)` : ''}</Fact>
          <Fact label="Limits">{`${limits?.perProject ?? state.limits.perProject} per project, ${limits?.total ?? state.limits.total} in total`}</Fact>
          <Fact label="Running">{`${state.running} of ${state.limits.total}`}</Fact>
          <Fact label="Quiet hours">{quiet ? `${quiet.from} to ${quiet.to}` : 'none'}</Fact>
          <Fact label="Health">{data.config.health ? `${data.config.health.bind ?? '127.0.0.1'}:${data.config.health.port ?? ''}` : '-'}</Fact>
        </dl>
      </section>
      {!data.service.installed && (
        <section className="card notice-card" aria-labelledby="bot-service">
          <h2 id="bot-service">Run the bot as a service</h2>
          <p>No service file at {data.service.file}. Write it, then load it yourself; jv never loads a launchd or systemd job.</p>
          <CommandLine command="jv bot install-service" />
          {data.service.file.endsWith('.plist') ? (
            <CommandLine command={`launchctl bootstrap gui/$(id -u) ${data.service.file}`} />
          ) : (
            <CommandLine command="systemctl --user enable --now jevellan-bot" />
          )}
          <p className="muted small-text">Without the service, jv bot start runs it in the foreground.</p>
        </section>
      )}
      <section className="card" aria-labelledby="bot-queue">
        <h2 id="bot-queue">
          Queue <span className="pw-count">{data.queue.length}</span>
        </h2>
        {data.queue.length === 0 ? (
          <p className="empty-inline">Nothing is waiting.</p>
        ) : (
          <ul className="data-list" aria-label="Queued tasks">
            {data.queue.map((task) => (
              <li key={task.id} className="data-row">
                <div className="data-main">
                  <div className="data-title">
                    <RouteLink href={`/t/${encodeURIComponent(task.id)}`} className="mono row-id">
                      {task.id}
                    </RouteLink>
                    <strong>{task.title}</strong>
                    <span className="chip">{task.project}</span>
                  </div>
                  <p className="data-meta">
                    <span>{task.reason ?? task.stateReason ?? task.state_reason ?? (task.after ? `after ${task.after}` : 'waiting')}</span>
                    {task.createdAt && <Stamp at={task.createdAt} />}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="bot-log">
        <h2 id="bot-log">bot.log</h2>
        {data.log.length === 0 ? <p className="empty-inline">The log is empty.</p> : <pre className="log-view">{data.log.slice(-100).join('\n')}</pre>}
      </section>
    </div>
  );
}
