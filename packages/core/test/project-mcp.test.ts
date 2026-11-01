// project.json mcpServers (run.ts projectMcpServers): secret values come from files under ~/.jv/secrets (envFiles,
// headerFiles, bearerTokenFile), a pointer outside that folder or to a missing, empty or readable-by-others file is
// refused without its content, and a literal value under a credential's name is refused. Made-up values only.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-project-mcp-test-');
process.env.JV_HOME = home;
const { projectMcpServers, looksLikeSecretName } = await import('../src/run.js');
const { paths } = await import('../src/paths.js');
const { redact } = await import('../src/redact.js');

after(() => rmSync(home, { recursive: true, force: true }));

const TRACKER_KEY = 'fake-tracker-key-2468013579';
const DOCS_TOKEN = 'fake-docs-token-1357924680';
const SEARCH_KEY = 'fake-search-key-1122334455';
writeFileSync(join(home, 'secrets', 'tracker.key'), `${TRACKER_KEY}\n`, { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'docs.token'), `${DOCS_TOKEN}\n`, { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'search.key'), SEARCH_KEY, { mode: 0o600 });

let n = 0;
function project(mcpServers: unknown): string {
  const name = `p${++n}`;
  mkdirSync(paths.projectDir(name), { recursive: true });
  writeFileSync(paths.projectJson(name), JSON.stringify({ mcpServers }));
  return name;
}
const refusedWith = (re: RegExp, never: string[] = []) => (e: unknown) => {
  const m = (e as Error).message;
  return (e as { exitCode?: number }).exitCode === 2 && re.test(m) && never.every((v) => !m.includes(v));
};

test('envFiles, headerFiles and bearerTokenFile are read from ~/.jv/secrets into env and headers', () => {
  const name = project({
    tracker: { command: 'tracker-mcp', args: ['--stdio'], env: { TRACKER_REGION: 'eu-west' }, envFiles: { TRACKER_API_KEY: '~/.jv/secrets/tracker.key' } },
    docs: { type: 'http', url: 'https://docs.example.test/mcp', headers: { 'X-Project': 'sandbox' }, bearerTokenFile: '~/.jv/secrets/docs.token' },
    search: { type: 'sse', url: 'https://search.example.test/sse', headerFiles: { 'X-Api-Key': join(home, 'secrets', 'search.key') } },
  });
  assert.deepEqual(projectMcpServers(name), {
    tracker: { type: 'stdio', command: 'tracker-mcp', args: ['--stdio'], env: { TRACKER_REGION: 'eu-west', TRACKER_API_KEY: TRACKER_KEY } },
    docs: { type: 'http', url: 'https://docs.example.test/mcp', headers: { 'X-Project': 'sandbox', Authorization: `Bearer ${DOCS_TOKEN}` } },
    search: { type: 'sse', url: 'https://search.example.test/sse', headers: { 'X-Api-Key': SEARCH_KEY } },
  });
  // The values live in ~/.jv/secrets, so the redactor knows them.
  assert.equal(redact(`${TRACKER_KEY} ${DOCS_TOKEN} ${SEARCH_KEY}`), '[redacted] [redacted] [redacted]');
});

test('a pointer outside ~/.jv/secrets, through a symlink out of it, or to a missing, empty or open file is refused without its content', () => {
  mkdirSync(join(home, 'elsewhere'), { recursive: true });
  const outside = 'fake-outside-value-97531';
  writeFileSync(join(home, 'elsewhere', 'k'), outside, { mode: 0o600 });
  symlinkSync(join(home, 'elsewhere', 'k'), join(home, 'secrets', 'link.key'));
  writeFileSync(join(home, 'secrets', 'empty.key'), '', { mode: 0o600 });
  writeFileSync(join(home, 'secrets', 'open.key'), 'fake-open-value-86420', { mode: 0o644 });
  const env = (file: string) => project({ s: { command: 'x', envFiles: { K: file } } });
  assert.throws(() => projectMcpServers(env(join(home, 'elsewhere', 'k'))), refusedWith(/mcpServers\.s\.envFiles\.K names .* not a file under .*secrets/, [outside]));
  assert.throws(() => projectMcpServers(env('~/.jv/secrets/link.key')), refusedWith(/not a file under/, [outside]));
  assert.throws(() => projectMcpServers(env('~/.jv/secrets/../elsewhere/k')), refusedWith(/not a file under/, [outside]));
  assert.throws(() => projectMcpServers(env('~/.jv/secrets/missing.key')), refusedWith(/missing\.key is missing/));
  assert.throws(() => projectMcpServers(env('~/.jv/secrets/empty.key')), refusedWith(/empty\.key is empty/));
  assert.throws(() => projectMcpServers(env('~/.jv/secrets/open.key')), refusedWith(/has mode 644 \(chmod 600/, ['fake-open-value']));
  assert.throws(() => projectMcpServers(project({ s: { type: 'http', url: 'http://x', bearerTokenFile: '/etc/hosts' } })), refusedWith(/bearerTokenFile names \/etc\/hosts/));
});

test('a literal value under a credential name is refused; other literals stay; duplicates and wrong kinds are refused', () => {
  const literal = 'fake-literal-token-123123';
  assert.throws(() => projectMcpServers(project({ s: { command: 'x', env: { GITHUB_TOKEN: literal } } })), refusedWith(/env\.GITHUB_TOKEN looks like a secret; .*envFiles/, [literal]));
  assert.throws(() => projectMcpServers(project({ s: { type: 'http', url: 'http://x', headers: { Authorization: `Bearer ${literal}` } } })), refusedWith(/headers\.Authorization looks like a secret/, [literal]));
  assert.throws(() => projectMcpServers(project({ s: { type: 'http', url: 'http://x', headers: { 'X-Api-Key': literal } } })), refusedWith(/X-Api-Key looks like a secret/));
  assert.throws(() => projectMcpServers(project({ s: { command: 'x', env: { A: '1' }, envFiles: { A: '~/.jv/secrets/tracker.key' } } })), refusedWith(/env\.A is given twice/));
  assert.throws(() => projectMcpServers(project({ s: { type: 'http', url: 'http://x', headerFiles: { authorization: '~/.jv/secrets/docs.token' }, bearerTokenFile: '~/.jv/secrets/docs.token' } })), refusedWith(/Authorization is given twice/));
  assert.throws(() => projectMcpServers(project({ s: { command: 'x', headerFiles: { H: '~/.jv/secrets/docs.token' } } })), refusedWith(/for http and sse servers/));
  assert.throws(() => projectMcpServers(project({ s: { type: 'http', url: 'http://x', envFiles: { K: '~/.jv/secrets/docs.token' } } })), refusedWith(/for stdio servers/));
  assert.deepEqual(projectMcpServers(project({ s: { command: 'x', env: { LOG_LEVEL: 'debug', KEYBOARD: 'us', AUTHOR: 'me' } } })).s, { type: 'stdio', command: 'x', env: { LOG_LEVEL: 'debug', KEYBOARD: 'us', AUTHOR: 'me' } });
  for (const name of ['API_KEY', 'OPENAI_API_KEY', 'apiKey', 'X-Auth-Token', 'Proxy-Authorization', 'DB_PASSWORD', 'Cookie', 'CLIENT_SECRET']) assert.equal(looksLikeSecretName(name), true, name);
  for (const name of ['LOG_LEVEL', 'KEYBOARD', 'AUTHOR', 'MONKEY', 'X-Project', 'Accept', 'PWD']) assert.equal(looksLikeSecretName(name), false, name);
});
