// What a bot process registers before it opens the store (M-015): jevellan-memory as jevellan-core's memory port and
// as the store's schema extension, as the jv command's setup does. The bot's jobs need it: the improver's and the
// planner's work tasks read the memories of the project, and a store the bot creates must have the memory tables.
// `jv bot start` already runs inside the jv command, so this repeats its registration (both are idempotent: the
// extension is replaced by name, the port by the same module); a bot started by any other host gets the same memory.

import { registerMemory } from 'jevellan-core/memory-port';
import { registerSchemaExtension } from 'jevellan-core/store';
import * as memory from 'jevellan-memory';

/** Registers jevellan-memory for this process (idempotent). */
export function ensureMemory(): void {
  registerSchemaExtension(memory.memorySchemaExtension);
  registerMemory(memory);
}
