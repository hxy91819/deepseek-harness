/** Fork promotion preserves the generated commit and rejects changed merge inputs. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./fork-aggregate', import.meta.url))
const roots: string[] = []
const bashAvailable = process.platform !== 'win32'
  && spawnSync('bash', ['-c', '(( BASH_VERSINFO[0] >= 4 ))']).status === 0

interface Fixture {
  root: string
  remote: string
  env: NodeJS.ProcessEnv
}

function git(fixture: Fixture, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-fork-aggregate-'))
  roots.push(directory)
  const root = join(directory, 'checkout')
  const remote = join(directory, 'remote.git')
  const config = join(directory, 'gitconfig')
  writeFileSync(config, '')
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
  }
  mkdirSync(root)
  const result = { root, remote, env }
  git(result, 'init', '--quiet', '--initial-branch=local/aggregate')
  git(result, 'config', 'user.name', 'DSH fixture')
  git(result, 'config', 'user.email', 'fixture@example.invalid')
  git(result, 'config', 'core.hooksPath', join(directory, 'hooks'))
  writeFileSync(join(root, 'baseline.txt'), 'base\n')
  git(result, 'add', '.')
  git(result, 'commit', '--quiet', '-m', 'baseline')
  git(result, 'tag', 'baseline')
  git(result, 'checkout', '--quiet', '-b', 'fork-tooling')
  mkdirSync(join(root, '.fork'))
  writeFileSync(join(root, '.fork/branches'), 'base baseline\nfork-tooling\nfix/example\n')
  git(result, 'add', '.')
  git(result, 'commit', '--quiet', '-m', 'inventory')
  git(result, 'checkout', '--quiet', '-b', 'fix/example', 'baseline')
  writeFileSync(join(root, 'feature.txt'), 'feature\n')
  git(result, 'add', '.')
  git(result, 'commit', '--quiet', '-m', 'feature')
  git(result, 'checkout', '--quiet', 'local/aggregate')
  git(result, 'init', '--quiet', '--bare', remote)
  git(result, 'remote', 'add', 'fork', remote)
  git(result, 'remote', 'add', 'origin', remote)
  git(result, 'push', '--quiet', 'fork', '--all')
  git(result, 'push', '--quiet', 'fork', '--tags')
  return result
}

function run(fixture: Fixture, ...args: string[]) {
  return spawnSync('bash', [script, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...fixture.env,
      // A different commit date exposes regeneration without a wall-clock sleep.
      ...args.includes('--promote') ? {
        GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z',
        GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z',
      } : {},
    },
  })
}

function generate(fixture: Fixture): string {
  const generated = run(fixture)
  expect(generated.status, generated.stderr).toBe(0)
  return git(fixture, 'rev-parse', 'aggregate/next')
}

function expectRejected(fixture: Fixture, aggregate: string, ...args: string[]): void {
  const rootBefore = git(fixture, 'rev-parse', 'local/aggregate')
  const remoteBefore = git(fixture, 'ls-remote', 'fork', 'refs/heads/local/aggregate')
  const promoted = run(fixture, '--promote', ...args)
  expect(promoted.status, promoted.stdout).toBe(1)
  expect(git(fixture, 'rev-parse', 'aggregate/next')).toBe(aggregate)
  expect(git(fixture, 'rev-parse', 'local/aggregate')).toBe(rootBefore)
  expect(git(fixture, 'ls-remote', 'fork', 'refs/heads/local/aggregate')).toBe(remoteBefore)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The fork script uses POSIX worktree paths and Bash 4's mapfile.
describe.skipIf(!bashAvailable)('fork aggregate promotion', () => {
  it('promotes the existing SHA locally and remotely without regenerating it', () => {
    const repo = fixture()
    const aggregate = generate(repo)
    const promoted = run(repo, '--promote')
    expect(promoted.status, promoted.stderr).toBe(0)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(aggregate)
    expect(git(repo, 'rev-parse', 'aggregate/next')).toBe(aggregate)
    expect(git(repo, 'ls-remote', 'fork', 'refs/heads/local/aggregate')).toContain(aggregate)
    expect(run(repo, '--promote').status).toBe(0)
  })

  it('requires a generated aggregate before promotion', () => {
    const repo = fixture()
    const promoted = run(repo, '--promote')
    expect(promoted.status).toBe(1)
    expect(promoted.stderr).toContain('请先运行 scripts/fork-aggregate')
  })

  it('rejects a branch that advanced after generation', () => {
    const repo = fixture()
    const aggregate = generate(repo)
    git(repo, 'checkout', '--quiet', 'fix/example')
    writeFileSync(join(repo.root, 'feature.txt'), 'new feature\n')
    git(repo, 'commit', '--quiet', '-am', 'advance feature')
    git(repo, 'checkout', '--quiet', 'local/aggregate')
    expectRejected(repo, aggregate)
  })

  it('rejects a different baseline even when branch heads are unchanged', () => {
    const repo = fixture()
    const aggregate = generate(repo)
    git(repo, 'tag', 'next-base', 'fix/example')
    expectRejected(repo, aggregate, '--base', 'next-base')
  })

  it.each(['fork-tooling\n', 'fix/example\nfork-tooling\n'])(
    'rejects a changed inventory: %s', (branches) => {
      const repo = fixture()
      const aggregate = generate(repo)
      git(repo, 'checkout', '--quiet', 'fork-tooling')
      writeFileSync(join(repo.root, '.fork/branches'), `base baseline\n${branches}`)
      git(repo, 'commit', '--quiet', '-am', 'change inventory')
      git(repo, 'checkout', '--quiet', 'local/aggregate')
      expectRejected(repo, aggregate)
    },
  )

  it('preserves dirty aggregate and root worktrees when rejecting promotion', () => {
    const repo = fixture()
    const aggregate = generate(repo)
    const next = join(repo.root, '.worktrees/aggregate-next')
    writeFileSync(join(next, 'feature.txt'), 'uncommitted\n')
    expectRejected(repo, aggregate)
    expect(readFileSync(join(next, 'feature.txt'), 'utf8')).toBe('uncommitted\n')
    git(repo, '-C', next, 'restore', 'feature.txt')
    writeFileSync(join(repo.root, 'baseline.txt'), 'uncommitted\n')
    expectRejected(repo, aggregate)
    expect(readFileSync(join(repo.root, 'baseline.txt'), 'utf8')).toBe('uncommitted\n')
  })

  it('accepts inputs already contained in the base or another listed branch', () => {
    const repo = fixture()
    git(repo, 'branch', 'fix/alias', 'fix/example')
    git(repo, 'branch', 'fix/base', 'baseline')
    git(repo, 'checkout', '--quiet', 'fork-tooling')
    writeFileSync(join(repo.root, '.fork/branches'), 'base baseline\nfork-tooling\nfix/example\nfix/alias\nfix/base\n')
    git(repo, 'commit', '--quiet', '-am', 'include redundant inputs')
    git(repo, 'checkout', '--quiet', 'local/aggregate')
    const aggregate = generate(repo)
    expect(run(repo, '--promote').status).toBe(0)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(aggregate)
  })
})
