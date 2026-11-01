// A bot process for the SIGTERM tests (run.test.ts spawns the compiled file with JV_HOME set): runBot with sub-steps
// that touch nothing outside the store, the health endpoint on a free port, and the default signal handling. Prints
// "started <pid> <health url>" once it runs and "stopped <reason> <ticks>" when runBot returns. BOT_DRIVER_HANG=1
// makes reconcile never finish (a slow Jev call), so a stop has to wait for its deadline; BOT_DRIVER_DEADLINE_MS
// shortens that deadline.

const { runBot } = await import('../../src/run.js');

const hang = process.env.BOT_DRIVER_HANG === '1';
const deadline = process.env.BOT_DRIVER_DEADLINE_MS ? Number(process.env.BOT_DRIVER_DEADLINE_MS) : undefined;

const result = await runBot({
  healthPort: 0,
  ...(deadline !== undefined ? { stopDeadlineMs: deadline } : {}),
  deps: {
    reconcile: hang
      ? () => new Promise(() => {})
      : async () => ({ lost: [], resumed: [], recovered: [], admitted: [], refused: [], delivered: [], woke: 0, errors: [] }),
    tailCoordinator: () => ({ projects: [] }),
    due: () => [],
    stepJobs: async () => ({ started: [], finished: [], errors: [] }),
    probeProviders: async () => [],
    gc: async () => [],
  },
  onStarted: (info) => process.stdout.write(`started ${info.pid} ${info.health.url}\n`),
  onTick: (s) => process.stdout.write(`tick ${s.tick}\n`),
});
process.stdout.write(`stopped ${result.reason} ${result.ticks}\n`);
