#!/usr/bin/env node
/** Install the fork's Ollama route into existing DSH profiles, preserving other settings. */
import { constants, copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
let check = false;
let makeDefault = false;
const selected = [];

function yamlModule() {
  // Installed dsh already supplies YAML; a fresh fork checkout needs no pnpm install.
  for (const location of [import.meta.url, ...(process.env.PATH || '').split(delimiter).map(dir => join(dir, 'dsh'))]) {
    try {
      return createRequire(location === import.meta.url ? location : realpathSync(location))('yaml');
    } catch (error) {
      if (!['ENOENT', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
    }
  }
  throw new Error('Install dsh and put its executable on PATH (its YAML module is required).');
}

function parse(yaml, source, file) {
  const doc = yaml.parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  });
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
  if (!yaml.isSeq(doc.contents)) throw new Error(`${file}: expected a YAML patch list.`);
  return doc;
}

function patchIndex(yaml, doc, id) {
  let index = -1;
  doc.contents.items.forEach((item, i) => {
    if (yaml.isMap(item) && item.get('id') === id) index = i;
  });
  if (index === -1) {
    doc.contents.add(doc.createNode({ id }));
    index = doc.contents.items.length - 1;
  }
  return index;
}

function validate(profile, extraPatch) {
  const output = execFileSync('dsh', ['--profile', profile, ...(extraPatch ? ['--patch', extraPatch] : []), '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    encoding: 'utf8',
  });
  const tree = parse(yamlModule(), output, `${profile} composed configuration`).toJS();
  const pending = [...tree];
  while (pending.length) {
    const entry = pending.pop();
    if (entry?.id === 'llm-pi-ai' && entry.name === '@deepseek-ai/dsh-llm-pi-ai' && entry.disabled !== true) return;
    if (Array.isArray(entry?.config)) pending.push(...entry.config);
  }
  throw new Error(`${profile}: no active llm-pi-ai plugin; use a profile with the dsh-base bundle.`);
}

function main() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') check = true;
    else if (arg === '--default') makeDefault = true;
    else if (['--home', '--profile'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      if (arg === '--home') home = resolve(value);
      else {
        if (!/^[\w.-]+$/.test(value) || value === '.' || value === '..') throw new Error('Invalid profile name.');
        selected.push(value);
      }
    } else if (arg === '--help') {
      console.log('Usage: node scripts/fork-provider-preset.mjs [--home DSH_HOME] [--profile NAME ...] [--default] [--check]');
      return;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  const yaml = yamlModule();
  const presetFile = join(root, '.fork/providers/ollama-cloud.yml');
  const preset = parse(yaml, readFileSync(presetFile, 'utf8'), presetFile).toJS()[0].config.providers['ollama-cloud'];
  const profilesRoot = join(home, 'profiles');
  const profiles = selected.length ? [...new Set(selected)] : readdirSync(profilesRoot).filter(name => existsSync(join(profilesRoot, name, 'package.json'))).sort();
  if (!profiles.length) throw new Error('No existing DSH profiles found; create a profile with dsh first.');
  let pending = false;
  for (const profile of profiles) {
    const dir = join(profilesRoot, profile);
    const packageFile = join(dir, 'package.json');
    const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
    const file = join(dir, 'cordis.patch.yml');
    const source = existsSync(file) ? readFileSync(file, 'utf8') : '[]\n';
    const doc = parse(yaml, source, file);
    const index = patchIndex(yaml, doc, 'llm-pi-ai');
    doc.setIn([index, 'config', 'providers', 'ollama-cloud'], preset);
    if (makeDefault) {
      const acp = metadata.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-acp-app');
      const defaults = patchIndex(yaml, doc, acp ? 'acp' : 'agent-default-model');
      doc.setIn([defaults, 'config', 'provider'], 'ollama-cloud');
      doc.setIn([defaults, 'config', 'model'], 'deepseek-v4.1-flash');
    }
    if (JSON.stringify(parse(yaml, source, file).toJS()) === JSON.stringify(doc.toJS())) {
      validate(profile);
      console.log(`${profile}: current (composed configuration validated)`);
      continue;
    }
    pending = true;
    if (check) {
      console.log(`${profile}: needs update`);
      continue;
    }
    const candidate = join(dir, `.ollama-preset-${process.pid}.yml`);
    try {
      writeFileSync(candidate, doc.toString(), { mode: 0o600, flag: 'wx' });
      validate(profile, candidate);
      if ((existsSync(file) ? readFileSync(file, 'utf8') : '[]\n') !== source) throw new Error(`${file}: changed during validation; run again.`);
      if (existsSync(file) && !existsSync(file + '.before-ollama-preset')) copyFileSync(file, file + '.before-ollama-preset', constants.COPYFILE_EXCL);
      renameSync(candidate, file);
    } finally {
      rmSync(candidate, { force: true });
    }
    console.log(`${profile}: updated (composed configuration validated; restart this profile to load it)`);
  }
  if (check && pending) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`fork-provider-preset: ${error.message}`);
  process.exitCode = 1;
}
