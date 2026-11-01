// Loaded with --import before every core test file: detached processes the tests start (jv run, jv exec) use the
// core test entry, since jevellan-core has no command layer of its own (M-007).

import { fileURLToPath } from 'node:url';

process.env.JV_CLI_ENTRY = fileURLToPath(new URL('./fixtures/run-entry.js', import.meta.url));
