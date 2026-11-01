// The bot's work limits as jevellan-core reads them (brief sections 3 and 8): how many tasks may run at once per
// project and on this machine. `jv task create`, the admission of reconcile() and `jv status` use them. The bot
// package validates bot.json strictly (unknown keys refused); here only `limits` is read, leniently, so a
// half-written bot.json never stops a task: a missing file, an unreadable one or a missing field gives the
// defaults (perProject 2, total 4).
//
// A task holds a slot while one of its step sessions is queued, starting or running (M-013): that is the work
// that costs a model and a process. A task waiting on the owner, between steps, or landing without a verify run holds
// none.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import type { Store } from './store.js';

export interface Limits {
  perProject: number;
  total: number;
}

export const DEFAULT_LIMITS: Limits = { perProject: 2, total: 4 };

/** $JV_HOME/bot.json */
export function botConfigFile(): string {
  return join(paths.home, 'bot.json');
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;
}

/** `limits` of bot.json, with the defaults for anything missing or invalid. */
export function readLimits(file: string = botConfigFile()): Limits {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { limits?: { perProject?: unknown; total?: unknown } };
    return {
      perProject: positiveInt(raw?.limits?.perProject) ?? DEFAULT_LIMITS.perProject,
      total: positiveInt(raw?.limits?.total) ?? DEFAULT_LIMITS.total,
    };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

export interface SlotUse {
  /** Tasks holding a slot on this machine. */
  total: number;
  /** Tasks holding a slot, by project id. */
  byProject: Record<string, number>;
  /** The ids of the tasks holding a slot. */
  tasks: string[];
}

/** The tasks that hold a slot now: one of their step sessions is queued, starting or running. */
export function slotUse(store: Store): SlotUse {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT t.id AS id, t.project_id AS project_id FROM tasks t JOIN sessions s ON s.task_id = t.id
       WHERE s.kind = 'step' AND s.state IN ('queued','starting','running') AND t.state NOT IN ('done','failed','stopped')`,
    )
    .all() as Array<{ id: string; project_id: string }>;
  const byProject: Record<string, number> = {};
  for (const r of rows) byProject[r.project_id] = (byProject[r.project_id] ?? 0) + 1;
  return { total: rows.length, byProject, tasks: rows.map((r) => r.id) };
}

/**
 * Why `taskId` of `projectId` cannot start now, or undefined when a slot is free for it. A task that already holds
 * a slot always may continue.
 */
export function slotRefusal(store: Store, projectId: string, taskId: string, limits: Limits = readLimits()): string | undefined {
  const use = slotUse(store);
  if (use.tasks.includes(taskId)) return undefined;
  if ((use.byProject[projectId] ?? 0) >= limits.perProject) return 'waiting for a slot';
  if (use.total >= limits.total) return 'waiting for a slot';
  return undefined;
}

/** The reason a queued task waits for a slot (brief section 3). */
export const WAITING_FOR_A_SLOT = 'waiting for a slot';
