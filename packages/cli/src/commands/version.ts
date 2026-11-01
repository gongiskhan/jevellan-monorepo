// jv --version: "jevellan <version> (store schema <n>, skills <jv-version>)", the package version (one for every
// package of the monorepo), the store schema this jv writes and the jv-version of the installed router skill
// (~/.jv/skills/jevellan-router/SKILL.md). --json adds the store's own schema version and the paths.

import { join } from 'node:path';
import type { CommandIo, ParsedArgs } from '../command.js';
import { skillJvVersion } from 'jevellan-core/bootstrap';
import { paths } from 'jevellan-core/paths';
import { readStoreSchemaVersion, SCHEMA_VERSION } from 'jevellan-core/store';
import { packageVersion } from 'jevellan-core/version';

export { packageVersion };

export async function run(_args: ParsedArgs, io: CommandIo): Promise<number> {
  const version = packageVersion();
  const storeSchemaVersion = readStoreSchemaVersion(paths.store) ?? null;
  const skillsFile = join(paths.skillsDir, 'jevellan-router', 'SKILL.md');
  const skillsVersion = skillJvVersion(skillsFile);
  io.result({ version, schemaVersion: SCHEMA_VERSION, storeSchemaVersion, store: paths.store, skillsVersion, skills: skillsFile }, () => {
    let line = `jevellan ${version} (store schema ${SCHEMA_VERSION}, skills ${skillsVersion ?? 'not installed'})`;
    if (storeSchemaVersion !== null && storeSchemaVersion !== SCHEMA_VERSION) line += `\nthe store at ${paths.store} has schema ${storeSchemaVersion}`;
    return line;
  });
  return 0;
}
