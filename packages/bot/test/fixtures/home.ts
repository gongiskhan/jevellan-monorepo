// The bot tests' temporary JV_HOME: a providers.json with made-up providers, made-up secrets, the duty skills a
// workflow needs, and helpers for a git repository and a project. Every value here is made up; no real secret is
// read. Callers set process.env.JV_HOME before importing anything from jevellan-core (paths.ts resolves it at load).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_TOKEN = 'fake-oauth-token-BOT0123456789';
export const FAKE_KEY = 'fake-endpoint-key-BOT9876543210';

export function writeSkill(home: string, duty: string, needs: string[], body: string): void {
  const dir = join(home, 'skills', `jevellan-duty-${duty}`);
  mkdirSync(dir, { recursive: true });
  const needsYaml = needs.length ? `jv-needs:\n${needs.map((n) => `  - ${n}`).join('\n')}` : 'jv-needs: []';
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: jevellan-duty-${duty}\ndescription: "Jevellan internal. Not for direct use."\ndisable-model-invocation: true\n${needsYaml}\njv-version: 0.1.0\n---\n\n${body}\n`,
  );
}

export function makeHome(prefix: string): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'secrets', 'claude-main.token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'secrets', 'glm.key'), `${FAKE_KEY}\n`, { mode: 0o600 });
  mkdirSync(join(home, 'homes', 'claude-main'), { recursive: true });
  writeFileSync(
    join(home, 'providers.json'),
    JSON.stringify(
      {
        jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-test' },
        providers: [
          {
            name: 'claude-main',
            kind: 'claude-subscription',
            home: '~/.jv/homes/claude-main',
            tokenFile: '~/.jv/secrets/claude-main.token',
            models: [{ id: 'model-strong', label: 'Strong', efforts: ['low', 'medium', 'high'] }],
          },
          {
            name: 'glm',
            kind: 'claude-endpoint',
            baseUrl: 'https://endpoint.example.test/api/anthropic',
            keyFile: '~/.jv/secrets/glm.key',
            models: [{ id: 'glm-big', label: 'Big', efforts: ['high'] }],
          },
        ],
      },
      null,
      2,
    ),
  );
  writeSkill(home, 'implement', ['repo-write', 'shell'], 'Follow plan.md.');
  writeSkill(home, 'investigate', ['repo-read'], 'Read the code the task names.');
  writeSkill(home, 'verify', ['repo-read', 'shell'], 'Run the tests.');
  writeSkill(home, 'document', ['repo-write'], 'Update the documentation.');
  writeSkill(home, 'plan', ['repo-read'], 'Write plan.md.');
  return home;
}

/** git without the machine's configuration, with an identity on the command line. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** A git repository with one commit on main. */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# sandbox\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}
