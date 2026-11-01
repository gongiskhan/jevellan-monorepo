// jevellan-improver (brief section 10): jobs that look at what the system did and propose improvements, as proposals
// the owner can see, never as silent changes. Each kind is a handler of jevellan-core's jobs machinery (jobs.ts):
//
// - improve-memory: duty investigate on the project; the memories of global, the project and this machine plus the
//   reports since the last memory job; finish() applies at most 50 merge/archive/add/expire operations in one
//   transaction with source improver:<J> (nothing is deleted: merges supersede, archives archive).
// - improve-docs: duty document in the task worktree; finish() records the changed files and lands them through the
//   project's normal landing (landing policy, Jev route); a change outside the documentation files is not landed.
// - improve-skills: duty implement on the registered project jevellan-skills (its landing.json has riskyPaths ["**"],
//   so every landing asks the owner); finish() records the changed files, the evals agreements the report states
//   and lands them, which leaves the proposal in front of the owner.
// A single task ends without landing (advance.finishSteps), so these two post-processors start the landing of a work
// task that changed files (landTask with auto: a refusal, a Jev failure or an ask comes back as the result and the
// job is still done; the task waits on the owner then). The bot's tick waits for the landing's checks, as it does when
// reconcile advances a lost run's report (M-024); a verify-then-land route records the landing as checking and the
// verify step finishes it outside the job.
// No job edits providers.json, bot.json, the owner's notes or project code outside documentation, and no job creates
// further jobs. The inputs leave out the jobs' own work tasks (request id job:<J>) but keep the tasks a plan created.
// improveProject names the project a job of a kind runs on (improve-skills: always jevellan-skills, refused until it
// is registered); jv job run, jv improve, the MCP's jv_job_run and the UI all go through it. The templates are
// templates/*.md, candidates to become duty skills later (M-018).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { notFound, refused } from 'jevellan-core/errors';
import { isoWeek, lastJsonBlock, localDay, type JobHandler } from 'jevellan-core/jobs';
import { landTask, type LandResult } from 'jevellan-core/land';
import { paths } from 'jevellan-core/paths';
import type { ReportView } from 'jevellan-core/report';
import type { Store } from 'jevellan-core/store';
import type { JobRow, ProjectRow, TaskRow } from 'jevellan-core/types';
import * as memory from 'jevellan-memory';

/** The jevellan-improver package folder (its templates/), from dist/ or dist-test/src/. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'templates')) && existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}
const PACKAGE_ROOT = packageRoot();
const template = (name: string) => readFileSync(join(PACKAGE_ROOT, 'templates', `${name}.md`), 'utf8');
const DAY = 86_400_000;

export const SKILLS_PROJECT = 'jevellan-skills';
export const MAX_MEMORY_OPERATIONS = 50;

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/<([a-z]+)>/g, (m, k: string) => values[k] ?? m).trimEnd();
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** When the last job of a kind for a project ended (done), or undefined. */
export function lastJobEnd(store: Store, projectId: string, kind: JobRow['kind'], except?: string): string | undefined {
  return store
    .listJobs({ project_id: projectId, kind, states: ['done'] })
    .filter((j) => j.id !== except && j.ended_at)
    .map((j) => j.ended_at!)
    .sort()
    .at(-1);
}

/**
 * The project's done tasks since a time, without the jobs' own work tasks (request id job:<J>). Tasks a plan created
 * (origin planner:<J>, request id plan:<J>:<i>) are project work and count.
 */
function doneTasksSince(store: Store, projectId: string, since: string | undefined): TaskRow[] {
  return store
    .listTasks({ project_id: projectId, states: ['done'] })
    .filter((t) => !t.request_id.startsWith('job:'))
    .filter((t) => since === undefined || (t.ended_at ?? t.created_at) > since);
}

function lastReport(store: Store, taskId: string) {
  return store.listReports({ task_id: taskId }).at(-1);
}

// ---- improve-memory ---------------------------------------------------------------------------------------------

const MemoryPlan = z.strictObject({
  // "text": "<optional better wording>": null or an empty string means the kept wording stays.
  merge: z.array(z.strictObject({ keep: z.string(), archive: z.array(z.string()).default([]), text: z.string().nullable().optional() })).default([]),
  archive: z.array(z.strictObject({ id: z.string(), reason: z.string().min(1) })).default([]),
  add: z
    .array(z.strictObject({ scope: z.enum(['project', 'global', 'machine']), kind: z.enum(memory.MEMORY_KINDS), text: z.string().min(1).max(2000), tags: z.array(z.string()).max(8).default([]) }))
    .max(10)
    .default([]),
  expire: z.array(z.strictObject({ id: z.string(), expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).default([]),
});

export function memoryJobInput(store: Store, project: ProjectRow, job: JobRow, now: Date = new Date()): { memories: unknown[]; reports: Array<{ task: string; title: string; summary: string }> } {
  const scopes = memory.readScopes(project.name);
  const rows = memory
    .list(store.db, { scopes, status: 'active', limit: 10_000 })
    .sort((a, b) => b.uses - a.uses || b.created_at.localeCompare(a.created_at))
    .slice(0, 400);
  const memories = rows.map((m) => ({ id: m.id, scope: m.scope, kind: m.kind, text: m.text, tags: m.tags, uses: m.uses, ageDays: Math.floor((now.getTime() - Date.parse(m.created_at)) / DAY) }));
  const since = lastJobEnd(store, project.id, 'improve-memory', job.id);
  const reports = doneTasksSince(store, project.id, since)
    .slice(-40)
    .map((t) => ({ task: t.id, title: t.title, summary: cut(lastReport(store, t.id)?.summary ?? '', 600) }))
    .filter((r) => r.summary !== '');
  return { memories, reports };
}

/**
 * Applies an improve-memory plan (at most 50 operations, one transaction). An operation that names an unknown or
 * archived id, or that jevellan-memory refuses (a text too long, a tag it does not take), is skipped with the reason
 * and undone on its own (jevellan-memory nests a savepoint per write), so one bad operation never loses the others.
 * Exported for tests.
 */
export function applyMemoryPlan(store: Store, project: ProjectRow, job: JobRow, raw: unknown): Record<string, unknown> {
  const parsed = MemoryPlan.safeParse(raw);
  if (!parsed.success) throw refused(`the memory plan does not validate: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`).join('; ')}`);
  const plan = parsed.data;
  const by = `improver:${job.id}`;
  const merged: Array<{ keep: string; archived: string[] }> = [];
  const archived: string[] = [];
  const added: string[] = [];
  const expired: string[] = [];
  const skipped: Array<{ op: string; reason: string }> = [];
  let ops = 0;
  const budget = (label: string): boolean => {
    if (ops >= MAX_MEMORY_OPERATIONS) {
      skipped.push({ op: label, reason: `over ${MAX_MEMORY_OPERATIONS} operations` });
      return false;
    }
    ops++;
    return true;
  };
  const active = (id: string) => {
    const m = memory.get(store.db, id);
    return m !== undefined && m.status === 'active';
  };
  /** Runs one operation; a refusal of jevellan-memory skips it with its message. */
  const attempt = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof memory.MemoryError)) throw e;
      skipped.push({ op: label, reason: e.message });
    }
  };
  const scopeOf = (s: 'project' | 'global' | 'machine') => (s === 'global' ? memory.GLOBAL_SCOPE : s === 'machine' ? memory.machineScope() : memory.projectScope(project.name));
  store.tx(() => {
    for (const m of plan.merge) {
      const label = `merge ${m.keep}`;
      if (!budget(label)) continue;
      const archiveIds = [...new Set(m.archive)].filter((id) => id !== m.keep);
      const bad = [m.keep, ...archiveIds].find((id) => !active(id));
      if (bad) {
        skipped.push({ op: label, reason: `${bad} is unknown or archived` });
        continue;
      }
      if (archiveIds.length === 0 && !m.text) {
        skipped.push({ op: label, reason: 'nothing to merge' });
        continue;
      }
      attempt(label, () => {
        const r = memory.supersede(store.db, { keepId: m.keep, archiveIds, ...(m.text ? { newText: m.text } : {}), by, reason: `merged by ${by}` });
        merged.push({ keep: m.keep, archived: r.archived });
      });
    }
    for (const a of plan.archive) {
      const label = `archive ${a.id}`;
      if (!budget(label)) continue;
      if (!active(a.id)) {
        skipped.push({ op: label, reason: `${a.id} is unknown or archived` });
        continue;
      }
      attempt(label, () => {
        memory.archive(store.db, a.id, a.reason, by);
        archived.push(a.id);
      });
    }
    for (const a of plan.add) {
      const label = `add ${cut(a.text, 40)}`;
      if (!budget(label)) continue;
      attempt(label, () => {
        const r = memory.remember(store.db, { scope: scopeOf(a.scope), kind: a.kind, text: a.text, tags: a.tags, source: by });
        if (r.created) added.push(r.id);
        else skipped.push({ op: label, reason: `already known (${r.id})` });
      });
    }
    for (const e of plan.expire) {
      const label = `expire ${e.id}`;
      if (!budget(label)) continue;
      if (!active(e.id)) {
        skipped.push({ op: label, reason: `${e.id} is unknown or archived` });
        continue;
      }
      attempt(label, () => {
        memory.expire(store.db, e.id, e.expiresAt, by);
        expired.push(e.id);
      });
    }
  });
  memory.writeProjectMemoryFile(store.db, project.name, join(paths.projectDir(project.name), 'memory.md'));
  return { merged, archived, added, expired, skipped, summary: `merged ${merged.length}, archived ${archived.length}, added ${added.length}, expired ${expired.length}, skipped ${skipped.length}` };
}

function parseBlock(report: ReportView | undefined, what: string): unknown {
  if (!report) throw refused(`the ${what} task ended without a report`);
  const block = lastJsonBlock(report.summary);
  if (block === undefined) throw refused(`the ${what} report has no fenced json block`);
  try {
    return JSON.parse(block);
  } catch {
    throw refused(`the ${what} report's json block is not valid JSON`);
  }
}

export const improveMemoryHandler: JobHandler = {
  kind: 'improve-memory',
  duty: 'investigate',
  origin: 'improver',
  requestId: (project, now) => `improve-memory:${project.name}:${localDay(now)}`,
  workTask: (store, job, project) => {
    const input = memoryJobInput(store, project, job);
    return {
      title: `Tidy what ${project.name} remembers (${localDay(new Date())})`,
      text: fill(template('improve-memory'), {
        project: project.name,
        path: project.path,
        memories: JSON.stringify(input.memories, null, 1),
        reports: input.reports.length ? input.reports.map((r) => `- ${r.task} ${r.title}: ${r.summary}`).join('\n') : '(none)',
      }),
      input: { memories: input.memories.length, reports: input.reports.map((r) => r.task) },
    };
  },
  finish: (store, job, report) => {
    const project = store.getProject(job.project_id)!;
    return applyMemoryPlan(store, project, job, parseBlock(report, 'memory'));
  },
};

// ---- improve-docs -----------------------------------------------------------------------------------------------

/** README.md, AGENTS.md, docs/** and CHANGELOG.md of a checkout, when present. */
export function documentationFiles(root: string): string[] {
  const out: string[] = [];
  for (const f of ['README.md', 'AGENTS.md', 'CHANGELOG.md']) if (existsSync(join(root, f))) out.push(f);
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(join(root, 'docs'));
  return out;
}

interface LandingRecord {
  route: string;
  state: string;
  commit: string | null;
  reason: string;
}

function landingOf(store: Store, taskId: string): LandingRecord | null {
  const l = store.listLandings({ task_id: taskId }).at(-1);
  return l ? { route: l.route, state: l.state, commit: l.commit_sha, reason: l.reason } : null;
}

export interface ImproverDeps {
  /** Lands a done work task: jevellan-core's landTask, always with auto (tests give a fake). */
  land: (store: Store, taskId: string, options: { auto: true }) => Promise<LandResult>;
}

/**
 * Lands the work of a done improve-docs or improve-skills task when it changed files and has not landed or started a
 * landing yet; returns the task's landing as recorded (null when nothing was landed). An error of the landing itself
 * is recorded as the landing's state, not thrown: the job's work is done, and the task says why it did not land.
 */
async function landWork(store: Store, task: TaskRow, files: readonly string[], deps: ImproverDeps): Promise<LandingRecord | null> {
  const existing = landingOf(store, task.id);
  if (existing || task.landed_commit || files.length === 0) return existing;
  try {
    const r = await deps.land(store, task.id, { auto: true });
    return landingOf(store, task.id) ?? { route: r.route, state: r.state, commit: r.commit ?? null, reason: r.reason };
  } catch (e) {
    return landingOf(store, task.id) ?? { route: 'none', state: 'error', commit: null, reason: cut(e instanceof Error ? e.message : String(e), 1000) };
  }
}

/** A documentation file of a project: README.md, AGENTS.md, CHANGELOG.md or anything under docs/ (documentationFiles). */
export function isDocumentationFile(path: string): boolean {
  return ['README.md', 'AGENTS.md', 'CHANGELOG.md'].includes(path) || path.startsWith('docs/');
}

function changedFiles(store: Store, taskId: string): string[] {
  const files = new Set<string>();
  for (const r of store.listReports({ task_id: taskId })) for (const f of JSON.parse(r.changed_files_json) as string[]) files.add(f);
  return [...files];
}

const DEFAULT_DEPS: ImproverDeps = { land: (store, taskId, options) => landTask(store, taskId, options) };

const docsHandler = (deps: ImproverDeps): JobHandler => ({
  kind: 'improve-docs',
  duty: 'document',
  origin: 'improver',
  requestId: (project, now) => `improve-docs:${project.name}:${isoWeek(now)}`,
  workTask: (store, job, project) => {
    const since = lastJobEnd(store, project.id, 'improve-docs', job.id);
    const landed = doneTasksSince(store, project.id, since).filter((t) => t.landed_commit);
    const env = memory.list(store.db, { scope: memory.projectScope(project.name), kind: 'environment', limit: 100 });
    return {
      title: `Bring the documentation up to date (${isoWeek(new Date())})`,
      text: fill(template('improve-docs'), {
        project: project.name,
        landed: landed.length
          ? landed.map((t) => `- ${t.id} ${t.title}: ${cut(lastReport(store, t.id)?.summary ?? '', 400)}${changedFiles(store, t.id).length ? ` (files: ${changedFiles(store, t.id).slice(0, 20).join(', ')})` : ''}`).join('\n')
          : '(nothing landed)',
        environment: env.length ? env.map((m) => `- ${m.text}`).join('\n') : '(none)',
        files: documentationFiles(project.path).map((f) => `- ${f}`).join('\n') || '(none yet)',
      }),
      input: { landed: landed.map((t) => t.id) },
    };
  },
  finish: async (store, _job, report, task) => {
    const files = changedFiles(store, task.id);
    const current = report?.summary.trim().startsWith('Documentation is current') ?? false;
    const outside = files.filter((f) => !isDocumentationFile(f));
    if (outside.length) {
      return {
        changedFiles: files,
        landing: landingOf(store, task.id),
        current,
        notLanded: `changed files outside the documentation: ${outside.slice(0, 20).join(', ')}`,
        summary: `${files.length} files changed, ${outside.length} outside the documentation; not landed`,
      };
    }
    const landing = await landWork(store, task, files, deps);
    return {
      changedFiles: files,
      landing,
      current,
      summary: files.length ? `${files.length} documentation files changed${landing ? `; landing ${landing.route} (${landing.state})` : ''}` : 'Documentation is current',
    };
  },
});

export const improveDocsHandler: JobHandler = docsHandler(DEFAULT_DEPS);

// ---- improve-skills ---------------------------------------------------------------------------------------------

/** Where the Skillio instructions are on this machine, when they are. */
export function skillioPath(): string | undefined {
  const candidates = [join(homedir(), '.claude', 'skills', 'improving-skills', 'SKILL.md'), join(homedir(), 'dev', 'skillio')];
  return candidates.find((p) => existsSync(p));
}

function decisionsSince(store: Store, since: string | undefined): string {
  const rows = store.listDecisions({}).filter((d) => d.kind === 'placement' && (since === undefined || d.created_at > since));
  const lines: string[] = [];
  for (const d of rows) {
    const outcome = d.outcome_json ? (JSON.parse(d.outcome_json) as { status?: string; attempts?: number }) : undefined;
    const overridden = d.override_json !== null;
    const failed = outcome !== undefined && outcome.status !== 'done';
    if (!overridden && !failed) continue;
    lines.push(`- ${d.id} ${d.kind} chose ${cut(d.chosen_json, 200)}${overridden ? `; owner override ${cut(d.override_json!, 120)} (${d.override_mode})` : ''}${outcome ? `; outcome ${outcome.status} after ${outcome.attempts ?? '?'} attempts` : ''}`);
  }
  return lines.length ? lines.slice(-60).join('\n') : '(none)';
}

const skillsHandler = (deps: ImproverDeps): JobHandler => ({
  kind: 'improve-skills',
  duty: 'implement',
  origin: 'improver',
  requestId: (_project, now) => `improve-skills:${isoWeek(now)}`,
  check: (_store, project) => {
    if (project.name !== SKILLS_PROJECT) throw refused(`improve-skills runs on the project ${SKILLS_PROJECT}, not ${project.name}`);
  },
  workTask: (store, job, project) => {
    const since = lastJobEnd(store, project.id, 'improve-skills', job.id) ?? new Date(Date.now() - 28 * DAY).toISOString();
    const skillio = skillioPath();
    return {
      title: `Improve the policy skills from the evidence (${isoWeek(new Date())})`,
      text: fill(template('improve-skills'), {
        jv: paths.shim,
        since: since.slice(0, 10),
        decisions: decisionsSince(store, since),
        skillio: skillio ? `Skillio's instructions for improving skills are at ${skillio}; follow them where they apply.` : '',
      }),
      input: { since, ...(skillio ? { skillio } : {}) },
    };
  },
  finish: async (store, _job, report, task) => {
    let agreement: unknown = null;
    try {
      agreement = parseBlock(report, 'skills');
    } catch {
      agreement = null;
    }
    const files = changedFiles(store, task.id);
    const landing = await landWork(store, task, files, deps);
    return { changedFiles: files, agreement, landing, summary: `${files.length} skill files changed${landing ? `; landing ${landing.route} (${landing.state})` : ''}` };
  },
});

export const improveSkillsHandler: JobHandler = skillsHandler(DEFAULT_DEPS);

/** The improver's job kinds with their dependencies given (tests); improverHandlers is this with jevellan-core's. */
export function makeImproverHandlers(deps: Partial<ImproverDeps> = {}): readonly JobHandler[] {
  const d: ImproverDeps = { ...DEFAULT_DEPS, ...deps };
  return [improveMemoryHandler, docsHandler(d), skillsHandler(d)];
}

export const improverHandlers: readonly JobHandler[] = [improveMemoryHandler, improveDocsHandler, improveSkillsHandler];

/** The project an improve job runs on: improve-skills always on jevellan-skills, refused when it is not registered. */
export function improveProject(store: Store, kind: string, project: string | undefined): string {
  if (kind === 'improve-skills') {
    if (!store.getProjectByName(SKILLS_PROJECT)) throw refused(`register ${SKILLS_PROJECT} first: jv project add ~/dev/jevellan-skills --name ${SKILLS_PROJECT}`);
    return SKILLS_PROJECT;
  }
  if (!project) throw refused('--project is required');
  if (!store.getProjectByName(project)) throw notFound(`no project ${project}`);
  return project;
}
