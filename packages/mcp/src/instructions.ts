// The server's `instructions` (what an MCP client shows its model), brief section 5: the coordinator skill's text from
// "How you work" to the end, with the jv commands replaced by the tool names of this server, so a session connected
// to it behaves like the coordinator without being one. Read from the installed skill (~/.jv/skills); the shell
// examples are left out (the tools take JSON), and the placeholders the coordinator's launcher fills are made general.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from 'jevellan-core/paths';

/** jv commands and the tools that stand for them, longest first. */
const COMMANDS: ReadonlyArray<[RegExp, string]> = [
  [/`?jv status --json(?: --project [^`\s]+)?`?/g, '`jv_status`'],
  [/`?jv status`?/g, '`jv_status`'],
  [/`?jv task create`?/g, '`jv_task_create`'],
  [/`?jv task show`?/g, '`jv_task_show`'],
  [/`?jv task message`?/g, '`jv_task_message`'],
  [/`?jv task answer`?/g, '`jv_task_answer`'],
  [/`?jv task stop T --discard`?/g, '`jv_task_stop` with discard'],
  [/`?jv task stop`?/g, '`jv_task_stop`'],
  [/`?jv task resume`?/g, '`jv_task_resume`'],
  [/`?jv task override`?/g, '`jv_task_override`'],
  [/`?jv land T --force`?/g, '`jv_land` with force'],
  [/`?jv land`?/g, '`jv_land`'],
  [/`?jv report`?/g, '`jv_report_get`'],
  [/`?jv usage`?/g, '`jv_usage`'],
  [/`?jv providers check`?/g, '`jv_doctor`'],
  [/`?jv notes write`?/g, 'the project notes (kept by the coordinator; not a tool of this server)'],
  [/`?jv handoff`?/g, 'the handoff (built from the store by the coordinator; not a tool of this server)'],
];

const PLACEHOLDERS: ReadonlyArray<[RegExp, string]> = [
  [/"\{\{project\}\}"/g, 'the project'],
  [/\{\{project\}\}/g, 'the project'],
  [/\{\{path\}\}/g, 'its checkout'],
  [/\{\{default_branch\}\}/g, 'its default branch'],
  [/\{\{jv\}\} ?/g, ''],
];

const PREAMBLE =
  'This server operates Jevellan, the system that runs software tasks for the owner. Every tool mirrors a jv command ' +
  'and returns its JSON as structured content. Act the way the project coordinator does:';

/** The instructions text built from a coordinator SKILL.md. */
export function instructionsFrom(skill: string): string {
  const start = skill.indexOf('How you work:');
  let text = start >= 0 ? skill.slice(start) : skill;
  text = text.replace(/```[a-z]*\n[\s\S]*?```\n?/g, '');
  for (const [re, by] of PLACEHOLDERS) text = text.replace(re, by);
  for (const [re, by] of COMMANDS) text = text.replace(re, by);
  text = text.replace(/Every command accepts --json; use it whenever you read the output yourself\. ?/g, 'Every tool returns JSON as structured content. ');
  text = text.replace(/,? one line each with what it is for/g, '');
  text = text.replace(/# The jv commands you use/g, '# The tools you use');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return `${PREAMBLE}\n\n${text}\n`;
}

/** The instructions from the installed coordinator skill, or the preamble alone when it is not installed. */
export function serverInstructions(file: string = join(paths.skillsDir, 'jevellan-coordinator', 'SKILL.md')): string {
  try {
    return instructionsFrom(readFileSync(file, 'utf8'));
  } catch {
    return `${PREAMBLE}\n\nThe coordinator skill is not installed (${file}); run jv bootstrap.\n`;
  }
}
