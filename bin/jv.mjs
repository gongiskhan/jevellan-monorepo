#!/usr/bin/env node
// jv from this checkout (M-007: the checkout is the install). Refuses Node older than 22.13 (node:sqlite), naming
// an installed Node 22 when there is one, then runs packages/cli/dist/bin.js. Build first: npm ci && npm run build.
// The installed shim ~/.jv/bin/jv (written by `jv bootstrap`) runs packages/cli/dist/bin.js directly.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_MAJOR = 22;
const MIN_MINOR = 13;

function nodeIsRecentEnough() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
}

function installedNode22() {
  const root = join(homedir(), '.nvm', 'versions', 'node');
  try {
    const found = readdirSync(root)
      .filter((v) => /^v22\.(\d+)\.\d+$/.test(v) && Number(v.split('.')[1]) >= MIN_MINOR)
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number);
        const pb = b.slice(1).split('.').map(Number);
        return pb[1] - pa[1] || pb[2] - pa[2];
      });
    return found.length ? join(root, found[0], 'bin') : undefined;
  } catch {
    return undefined;
  }
}

if (!nodeIsRecentEnough()) {
  const bin = installedNode22();
  const hint = bin
    ? `Node 22 is installed at ${bin}: run export PATH=${bin}:$PATH and try again.`
    : 'Install Node 22.13 or later (for example with nvm: nvm install 22) and try again.';
  process.stderr.write(`jv: Node ${process.versions.node} is too old; jv needs Node 22.13 or later (node:sqlite). ${hint}\n`);
  process.exit(2);
}

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'dist', 'bin.js');
if (!existsSync(entry)) {
  process.stderr.write(`jv: ${entry} is missing; run npm ci && npm run build in this checkout first\n`);
  process.exit(2);
}
await import(pathToFileURL(entry).href);
