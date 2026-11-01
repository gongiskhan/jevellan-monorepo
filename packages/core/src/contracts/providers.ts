// The providers.json contract (skills brief 6.6, D-011; brief section 3): the owner's file of providers and the Jev
// settings. The lifted providers.ts owns the schema (strict: an unknown key is refused naming it; enabled, paidUse,
// metered and the "same as <provider>" model lists of D-011); it is re-exported here, never copied. Validating a
// file fully (names used once, "same as" targets that exist, homes inside $JV_HOME/homes) is parseProviders', which
// also resolves paths, so it reads JV_HOME.

import type { z } from 'zod';
import { ModelSchema, PROVIDER_KINDS, ProvidersFileSchema, parseProviders } from '../providers.js';

export { ModelSchema, PROVIDER_KINDS, ProvidersFileSchema, parseProviders };

export type ProvidersFile = z.output<typeof ProvidersFileSchema>;
