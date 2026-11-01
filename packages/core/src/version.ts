// The package version of jevellan-core, read from its package.json. Every package of the monorepo shares one
// version (brief section 2), so this is also the version jv prints.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ROOT } from './paths.js';

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}
