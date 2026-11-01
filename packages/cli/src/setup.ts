// What every jv process registers before a command runs (M-015): jevellan-memory as jevellan-core's memory port
// and as a schema extension of the store, so `jv run`, the worker MCP server, the bot, the UI and the MCP server all
// read and write memories through the same package. Imported for its effect by cli.ts.

import * as memory from 'jevellan-memory';
import { registerMemory } from 'jevellan-core/memory-port';
import { registerSchemaExtension } from 'jevellan-core/store';

registerSchemaExtension(memory.memorySchemaExtension);
registerMemory(memory);

export { memory };
