// jv memory add|search|list|archive|export (brief section 6): what the agents of the system remember, through
// jevellan-memory on the store's own connection. A write to a project's scope regenerates
// ~/.jv/projects/<name>/memory.md. Nothing deletes a memory: archive is the only removal.
//
//   jv memory add --scope global|project [--project N] --kind K [--tag t]... "text"
//   jv memory search [--project N] "query"
//   jv memory list [--project N] [--kind K] [--status active|archived]
//   jv memory archive M --reason "..."
//   jv memory export [--project N]

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagInt, flagString, flagStrings, requireFlag } from '../command.js';
import { JvError, notFound, refused } from 'jevellan-core/errors';
import { normalizeId } from 'jevellan-core/ids';
import { paths } from 'jevellan-core/paths';
import { openStore, type Store } from 'jevellan-core/store';
import { memory } from '../setup.js';

type Memory = ReturnType<typeof memory.list>[number];

/** jevellan-memory refusals carry jv's exit codes; the CLI reports them as its own. */
function asJv<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof memory.MemoryError) throw new JvError(e.message, e.exitCode === 3 ? 3 : 2);
    throw e;
  }
}

function line(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
  const state = m.status === 'archived' ? ` (archived${m.superseded_by ? `, superseded by ${m.superseded_by}` : ''})` : '';
  return `${m.id} ${m.scope} (${m.kind}) ${m.text}${tags}${state}`.slice(0, 100 + m.text.length);
}

function requireProject(store: Store, name: string): string {
  const p = store.getProjectByName(name);
  if (!p) throw notFound(`no project ${name}`);
  return p.name;
}

/** Who writes a memory from the command line: the coordinator (JV_SESSION names a coordinator session) or the owner. */
function source(store: Store): string {
  const s = process.env.JV_SESSION ? store.getSession(process.env.JV_SESSION) : undefined;
  return s?.kind === 'coordinator' ? 'coordinator' : 'owner';
}

function allScopes(store: Store): string[] {
  return (store.db.prepare("SELECT DISTINCT scope FROM memories WHERE status = 'active' ORDER BY scope").all() as Array<{ scope: string }>).map((r) => r.scope);
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  const store = openStore();
  try {
    switch (sub) {
      case 'add': {
        const scopeFlag = flagString(args, 'scope') ?? (flagString(args, 'project') ? 'project' : undefined);
        if (scopeFlag !== 'global' && scopeFlag !== 'project') throw refused('--scope global|project is required');
        const kind = requireFlag(args, 'kind');
        const text = args.positionals.slice(1).join(' ');
        if (text.trim() === '') throw refused('jv memory add: the text is required');
        let project: string | undefined;
        if (scopeFlag === 'project') project = requireProject(store, requireFlag(args, 'project'));
        const scope = project ? memory.projectScope(project) : memory.GLOBAL_SCOPE;
        const r = asJv(() => memory.remember(store.db, { scope, kind: kind as memory.MemoryKind, text, tags: flagStrings(args, 'tag'), source: source(store) }));
        if (project) memory.writeProjectMemoryFile(store.db, project, `${paths.projectDir(project)}/memory.md`);
        const m = memory.get(store.db, r.id)!;
        io.result({ ...r, memory: m }, `${r.created ? 'Remembered' : 'Already known'} (${r.id}): ${line(m)}`);
        return 0;
      }
      case 'search': {
        const query = args.positionals.slice(1).join(' ');
        if (query.trim() === '') throw refused('jv memory search: the query is required');
        const project = flagString(args, 'project');
        const scopes = project ? memory.readScopes(requireProject(store, project)) : allScopes(store);
        const found = memory.recall(store.db, { scopes, query, limit: flagInt(args, 'limit') ?? 20, touch: false });
        io.result({ query, scopes, memories: found }, () => (found.length ? found.map(line).join('\n') : 'Nothing remembered matches.'));
        return 0;
      }
      case 'list': {
        const project = flagString(args, 'project');
        const status = flagString(args, 'status') ?? 'active';
        if (status !== 'active' && status !== 'archived' && status !== 'all') throw refused('--status is active, archived or all');
        const kind = flagString(args, 'kind');
        if (kind !== undefined && !(memory.MEMORY_KINDS as readonly string[]).includes(kind)) throw refused(`--kind is one of ${memory.MEMORY_KINDS.join(', ')}`);
        const rows = memory.list(store.db, {
          ...(project ? { scope: memory.projectScope(requireProject(store, project)) } : {}),
          ...(kind ? { kind: kind as memory.MemoryKind } : {}),
          status,
          limit: flagInt(args, 'limit') ?? 200,
        });
        io.result({ memories: rows }, () => (rows.length ? rows.map(line).join('\n') : 'No memories.'));
        return 0;
      }
      case 'archive': {
        const id = args.positionals[1];
        if (!id) throw refused('jv memory archive M --reason "...": the memory id is required');
        const reason = requireFlag(args, 'reason');
        const m = asJv(() => memory.archive(store.db, normalizeId(id), reason, source(store)));
        if (m.scope.startsWith('project:')) memory.writeProjectMemoryFile(store.db, m.scope.slice('project:'.length), `${paths.projectDir(m.scope.slice('project:'.length))}/memory.md`);
        io.result({ memory: m }, `Archived ${m.id}: ${reason}`);
        return 0;
      }
      case 'export': {
        const project = flagString(args, 'project');
        const scopes = project ? [memory.projectScope(requireProject(store, project))] : allScopes(store);
        const markdown = scopes.map((s) => memory.exportMarkdown(store.db, s)).join('\n');
        io.result({ scopes, markdown }, markdown || '# Memory\n\nNothing remembered yet.\n');
        return 0;
      }
      default:
        throw refused('jv memory add|search|list|archive|export');
    }
  } finally {
    store.close();
  }
}
