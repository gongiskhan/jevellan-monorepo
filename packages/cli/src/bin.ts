#!/usr/bin/env node
// The jv executable of jevellan-cli. The shim ~/.jv/bin/jv runs this file with the Node binary recorded at
// bootstrap and --disable-warning=ExperimentalWarning (D-001); bin/jv.mjs at the checkout root runs it too.

import { main } from './cli.js';

// node:sqlite prints an ExperimentalWarning on first use; without the shim's flag, drop that one warning only.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`jv: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
