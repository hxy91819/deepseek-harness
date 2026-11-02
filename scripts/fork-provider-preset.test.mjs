/** Installed-CLI smoke tests: run with node --test scripts/fork-provider-preset.test.mjs. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./fork-provider-preset.mjs', import.meta.url));
const dsh = process.env.PATH.split(delimiter).map(dir => join(dir, 'dsh')).find(existsSync);
const yaml = createRequire(realpathSync(dsh))('yaml');
const original = `# Keep environment-local settings and executable tags.
- id: llm-pi-ai
  config:
    providers:
      local-test:
        baseURL: http://127.0.0.1:9000/v1
- id: sandbox-policy
  config:
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
`;

function fixture(body) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-provider-preset-test-'));
  const profile = join(home, 'profiles/acp');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } } }));
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), original);
  try { body({ home, profile, file: join(profile, 'cordis.patch.yml') }); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function run(home, ...args) {
  return spawnSync(process.execPath, [script, '--home', home, ...args], { encoding: 'utf8', timeout: 60000 });
}

test('install across an environment, preserve other settings, and leave repeated installs unchanged', () => fixture(({ home, profile, file }) => {
  let result = run(home, '--default');
  assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(file, 'utf8');
  assert.match(updated, /maxRequestImageBytes: 4194304/);
  const parsed = yaml.parseDocument(updated, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }).toJS();
  const models = parsed.find(entry => entry.id === 'llm-pi-ai').config.providers['ollama-cloud'].models;
  assert.deepEqual(models[0].input, ['text', 'image']);
  assert.deepEqual(models[1].input, ['text']);
  assert.deepEqual(models[0].reasoningEfforts, { off: 'none', high: 'high', max: 'max' });
  assert.match(updated, /reasoningEfforts:/);
  assert.match(updated, /local-test:/);
  assert.match(updated, /workspaceRoot: !!js process.cwd\(\)/);
  assert.match(updated, /# Keep environment-local settings/);
  assert.match(updated, /policy: never/);
  assert.match(updated, /id: acp/);
  assert.equal(readFileSync(file + '.before-ollama-preset', 'utf8'), original);
  result = run(home, '--default', '--check');
  assert.equal(result.status, 0, result.stderr);
  result = run(home, '--default');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), updated);
  assert.deepEqual(readdirSync(profile).sort(), ['cordis.patch.yml', 'cordis.patch.yml.before-ollama-preset', 'cordis.yml', 'package.json']);
  assert.equal(existsSync(join(home, '.credentials.yaml')), false);
}));

test('check reports drift without writing and malformed patches stay untouched', () => fixture(({ home, file }) => {
  let result = run(home, '--check');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /needs update/);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(file + '.before-ollama-preset'), false);
  writeFileSync(file, 'not: [valid\n');
  result = run(home);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(file, 'utf8'), 'not: [valid\n');
}));

test('profile selection changes only the named profile', () => fixture(({ home, file }) => {
  const untouched = join(home, 'profiles/untouched');
  mkdirSync(untouched);
  writeFileSync(join(untouched, 'package.json'), '{}\n');
  writeFileSync(join(untouched, 'cordis.patch.yml'), original);
  const result = run(home, '--profile', 'acp');
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(readFileSync(file, 'utf8'), original);
  assert.equal(readFileSync(join(untouched, 'cordis.patch.yml'), 'utf8'), original);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /id: acp/);
}));

test('default selection uses the native model settings of non-ACP profiles', () => fixture(({ home }) => {
  const dir = join(home, 'profiles/headless');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }));
  writeFileSync(join(dir, 'cordis.yml'), '[]\n');
  const result = run(home, '--default', '--profile', 'headless');
  assert.equal(result.status, 0, result.stderr);
  const updated = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
  const parsed = yaml.parse(updated);
  assert.deepEqual(parsed.find(entry => entry.id === 'agent-default-model').config, { provider: 'ollama-cloud', model: 'deepseek-v4.1-flash' });
  assert.equal(parsed.some(entry => entry.id === 'acp'), false);
}));

test('a composition failure preserves the original and removes the candidate', () => fixture(({ home, profile, file }) => {
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
  const result = run(home);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(file + '.before-ollama-preset'), false);
  assert.equal(readdirSync(profile).some(name => name.startsWith('.ollama-preset-')), false);
}));
