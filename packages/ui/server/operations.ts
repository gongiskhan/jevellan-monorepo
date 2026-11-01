// The JSON routes that are operations of the control plane (brief section 7: "one route per MCP tool of section 5
// with the same input and output"). The operations themselves live in jevellan-mcp (packages/mcp/src/tools.ts) and
// are injected into startUiServer by whoever starts it, so this package does not depend on jevellan-mcp or on its
// zod major: an operation only has to look like UiOperation, which jevellan-mcp's Operation does.
//
// A route's input is built from the path (its ids), the query (declared keys only, typed: whole numbers and
// booleans are converted, anything else stays a string so the schema can refuse it) and, for a POST, the JSON body
// (every key; the path's ids win). The operation's own schema validates it (400 naming the first problem), then it
// runs with origin 'ui' (tasks it creates get tasks.origin = 'ui'), and its `data` is the response body: the
// object `jv ... --json` prints for the same command.

/** An operation's result: text for people (unused here) and the JSON body. */
export interface OpResultLike {
  text: string;
  data: Record<string, unknown>;
}

/** One problem a schema found (zod's issue has these two fields). */
export interface SchemaIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/**
 * What the server needs of an operation (jevellan-mcp's Operation has this shape). `run` is a method, so an operation
 * whose input type is narrower than unknown still fits (method parameters are compared both ways).
 */
export interface UiOperation {
  name: string;
  /** Changes something; refused in --readonly mode like every POST. */
  mutates: boolean;
  input: {
    safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: ReadonlyArray<SchemaIssue> } };
  };
  run(input: unknown, ctx: { origin: 'ui' }): OpResultLike | Promise<OpResultLike>;
}

export type QueryType = 'string' | 'int' | 'bool';

export interface OperationRoute {
  method: 'GET' | 'POST';
  /** /api/tasks/:id/message; a :name segment matches one path segment. */
  path: string;
  operation: string;
  /** Path parameter -> input key (':id' of /api/tasks/:id -> 'task'). */
  params?: Readonly<Record<string, string>>;
  /** Query key -> its type (GET routes). */
  query?: Readonly<Record<string, QueryType>>;
  /** The JSON body's keys go into the input (POST routes). */
  body?: boolean;
}

/** Every operation-backed route of the UI route contract (brief section 7, the tool names of section 5). */
export const OPERATION_ROUTES: readonly OperationRoute[] = [
  { method: 'GET', path: '/api/status', operation: 'jv_status', query: { project: 'string' } },
  { method: 'GET', path: '/api/projects', operation: 'jv_project_list' },
  { method: 'POST', path: '/api/projects', operation: 'jv_project_add', body: true },
  { method: 'GET', path: '/api/tasks', operation: 'jv_task_list', query: { project: 'string', state: 'string', limit: 'int' } },
  { method: 'POST', path: '/api/tasks', operation: 'jv_task_create', body: true },
  { method: 'GET', path: '/api/tasks/:id', operation: 'jv_task_show', params: { id: 'task' } },
  { method: 'POST', path: '/api/tasks/:id/message', operation: 'jv_task_message', params: { id: 'task' }, body: true },
  { method: 'POST', path: '/api/tasks/:id/answer', operation: 'jv_task_answer', params: { id: 'task' }, body: true },
  { method: 'POST', path: '/api/tasks/:id/stop', operation: 'jv_task_stop', params: { id: 'task' }, body: true },
  { method: 'POST', path: '/api/tasks/:id/resume', operation: 'jv_task_resume', params: { id: 'task' }, body: true },
  { method: 'POST', path: '/api/tasks/:id/override', operation: 'jv_task_override', params: { id: 'task' }, body: true },
  { method: 'GET', path: '/api/tasks/:id/changes', operation: 'jv_task_changes', params: { id: 'task' }, query: { stat: 'bool' } },
  { method: 'POST', path: '/api/tasks/:id/land', operation: 'jv_land', params: { id: 'task' }, body: true },
  { method: 'GET', path: '/api/sessions/:id/report', operation: 'jv_report_get', params: { id: 'session' } },
  { method: 'GET', path: '/api/sessions/:id/events', operation: 'jv_tail', params: { id: 'session' }, query: { sinceSeq: 'int', limit: 'int' } },
  { method: 'GET', path: '/api/projects/:name/coordinator', operation: 'jv_coordinator_status', params: { name: 'project' } },
  { method: 'POST', path: '/api/projects/:name/coordinator/message', operation: 'jv_coordinator_message', params: { name: 'project' }, body: true },
  { method: 'GET', path: '/api/projects/:name/coordinator/transcript', operation: 'jv_coordinator_transcript', params: { name: 'project' }, query: { limit: 'int' } },
  // GET /api/memory is jv_memory_search when a query is given (the list otherwise is a UI route): see server.ts.
  { method: 'GET', path: '/api/memory', operation: 'jv_memory_search', query: { query: 'string', project: 'string', limit: 'int' } },
  { method: 'POST', path: '/api/memory', operation: 'jv_memory_add', body: true },
  { method: 'POST', path: '/api/memory/:id/archive', operation: 'jv_memory_archive', params: { id: 'id' }, body: true },
  { method: 'GET', path: '/api/schedules', operation: 'jv_schedule_list', query: { project: 'string' } },
  { method: 'POST', path: '/api/schedules', operation: 'jv_schedule_add', body: true },
  { method: 'POST', path: '/api/schedules/:id/run', operation: 'jv_schedule_run', params: { id: 'schedule' }, body: true },
  { method: 'POST', path: '/api/schedules/:id/pause', operation: 'jv_schedule_pause', params: { id: 'schedule' }, body: true },
  { method: 'POST', path: '/api/schedules/:id/resume', operation: 'jv_schedule_resume', params: { id: 'schedule' }, body: true },
  { method: 'GET', path: '/api/goals', operation: 'jv_goal_list', query: { project: 'string' } },
  { method: 'POST', path: '/api/goals', operation: 'jv_goal_add', body: true },
  { method: 'POST', path: '/api/goals/:id/done', operation: 'jv_goal_done', params: { id: 'goal' }, body: true },
  { method: 'GET', path: '/api/jobs', operation: 'jv_job_list', query: { project: 'string' } },
  { method: 'POST', path: '/api/jobs', operation: 'jv_job_run', body: true },
  { method: 'GET', path: '/api/usage', operation: 'jv_usage', query: { week: 'string' } },
  { method: 'GET', path: '/api/doctor', operation: 'jv_doctor' },
  // GET /api/bot adds the log and the queue to jv_bot_status: see server.ts.
  { method: 'GET', path: '/api/bot', operation: 'jv_bot_status' },
];

/** The operation names the routes need that `operations` does not have (jv ui warns about them at start). */
export function missingOperations(operations: readonly Pick<UiOperation, 'name'>[]): string[] {
  const have = new Set(operations.map((o) => o.name));
  return [...new Set(OPERATION_ROUTES.map((r) => r.operation))].filter((n) => !have.has(n));
}

export interface CompiledRoute {
  route: OperationRoute;
  pattern: RegExp;
  names: string[];
}

/** /api/tasks/:id -> ^/api/tasks/([^/]+)$ with ['id']. */
export function compilePath(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), names };
}

export function compileRoutes(routes: readonly OperationRoute[] = OPERATION_ROUTES): CompiledRoute[] {
  return routes.map((route) => ({ route, ...compilePath(route.path) }));
}

/** A query value as its declared type: digits to a number, true/false/1/0 (or a bare key) to a boolean. */
export function typedQuery(value: string, type: QueryType): unknown {
  if (type === 'int') return /^\d+$/.test(value) ? Number(value) : value;
  if (type === 'bool') {
    if (value === '' || value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }
  return value;
}

/** The operation input of a matched route. */
export function routeInput(
  route: OperationRoute,
  pathValues: Readonly<Record<string, string>>,
  url: URL,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (route.query) {
    for (const [key, type] of Object.entries(route.query)) {
      const raw = url.searchParams.get(key);
      if (raw === null) continue;
      const v = raw.trim();
      if (v === '' && type !== 'bool') continue;
      input[key] = typedQuery(v, type);
    }
  }
  if (route.body && body) Object.assign(input, body);
  for (const [param, key] of Object.entries(route.params ?? {})) {
    const v = pathValues[param];
    if (v !== undefined) input[key] = v;
  }
  return input;
}

/** The first problem a schema found, as one line ("text: Required"). */
export function schemaProblem(issues: ReadonlyArray<SchemaIssue>): string {
  const issue = issues[0];
  if (!issue) return 'the input is not valid';
  const where = issue.path.map((p) => String(p)).join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}
