#!/usr/bin/env node
/**
 * Build the npm bundle published with one fork release.
 *
 * The bundle contains every release-family tarball plus the native entry, a
 * generated install manifest, BUILD.json, a per-tarball SHA256SUMS, and the
 * outer archive checked by the release asset. Run it from an official build
 * (`DSH_BUILD_CLIENT_PROFILE=official pnpm run build`) on a clean aggregate
 * commit; the pack step rejects a build record from another profile.
 *
 * Usage: node scripts/fork-release.mjs <fork-v...> <dsh-v...> [output]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const help = `用法：node scripts/fork-release.mjs <fork-v...> <dsh-v...> [输出目录]

在聚合 worktree 的干净提交上构建 fork 发布包：
  fork-v...   发布 tag，格式 fork-v<版本>-<YYYYMMDD>.<序号>
  dsh-v...    上游基线 tag，写入 BUILD.json
  输出目录    默认 dist/fork-release
`

const args = process.argv.slice(2)
const wantsHelp = args.includes('-h') || args.includes('--help')
if (wantsHelp || args.length < 2) {
  process.stdout.write(help)
  process.exit(wantsHelp ? 0 : 2)
}
const [tag, base, outputArg = 'dist/fork-release'] = args
if (!tag.startsWith('fork-v') || !base.startsWith('dsh-v')) {
  process.stderr.write(help)
  process.exit(2)
}
const match = /^(?<version>.+)-(?<date>\d{8})\.(?<sequence>\d+)$/u.exec(tag.slice('fork-v'.length))
if (!match?.groups) throw new Error(`tag 必须以 -YYYYMMDD.N 结尾：${tag}`)
const { version, date, sequence } = match.groups
const bundleVersion = `${version}-fork.${date}.${sequence}`
const bundleName = `deepseek-harness-fork-${tag.slice('fork-v'.length)}`
const repo = process.cwd()
const output = resolve(repo, outputArg)
const work = join(output, '.work')
const bundle = join(work, bundleName)
const packagesDir = join(bundle, 'packages')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

if (execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() !== '') {
  throw new Error('工作树不干净，发布包必须从已提交的聚合构建')
}

function run(command, commandArgs, cwd = repo) {
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', env: { ...process.env, LEFTHOOK: '0' } })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

rmSync(work, { recursive: true, force: true })
mkdirSync(packagesDir, { recursive: true })

run('pnpm', ['release:pack', '--family', 'dsh', '--out', join(work, 'dsh'), '--concurrency', '8'])
run('pnpm', ['release:pack', '--family', 'vendor', '--out', join(work, 'vendor'), '--concurrency', '8'])
run('pnpm', ['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(work, 'native')])

const tarballs = []
for (const source of ['dsh', 'vendor', 'native']) {
  const directory = join(work, source)
  if (!existsSync(directory)) throw new Error(`缺少 ${source} 打包目录`)
  for (const filename of readdirSync(directory).sort()) {
    if (!filename.endsWith('.tgz')) continue
    cpSync(join(directory, filename), join(packagesDir, filename))
    tarballs.push(filename)
  }
}

const manifests = new Map()
for (const filename of tarballs) {
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', join(packagesDir, filename), 'package/package.json'], { encoding: 'utf8' }),
  )
  if (manifests.has(manifest.name)) throw new Error(`重复包 ${manifest.name}`)
  // npm aborts a hard dependency on a foreign platform but skips an optional one.
  const platformGated = manifest.os !== undefined || manifest.cpu !== undefined
  manifests.set(manifest.name, { filename, version: manifest.version, platformGated })
}
const dependencies = {}
const optionalDependencies = {}
for (const [name, entry] of [...manifests].sort(([left], [right]) => left.localeCompare(right))) {
  const spec = `file:packages/${entry.filename}`
  if (entry.platformGated) optionalDependencies[name] = spec
  else dependencies[name] = spec
}

const readme = `# DeepSeek Harness 个人 fork

基于 \`${base}\`，包含 ACP mid-turn steering 补丁及依赖安全修复。

需要 Node.js \`^22.19.0 || >=24.0.0\` 和 npm。在解压目录执行：

\`\`\`sh
npm install
npm run dsh -- --version
npm run dsh -- --profile acp
\`\`\`

CLI 位于 \`node_modules/.bin/dsh\`。普通 npm 安装需保留可选依赖；安装仍需联网下载第三方依赖和适配本机的原生依赖。本归档内的本项目及 Cordis 包均使用 \`packages/\` 中的本地 tarball。

\`BUILD.json\` 记录上游基线与 fork 提交，\`SHA256SUMS\` 校验本地 tarball。
`

writeFileSync(
  join(bundle, 'package.json'),
  `${JSON.stringify(
    {
      name: 'hxy91819-deepseek-harness-fork',
      version: bundleVersion,
      private: true,
      engines: { node: '^22.19.0 || >=24.0.0' },
      scripts: { dsh: 'dsh' },
      dependencies,
      ...(Object.keys(optionalDependencies).length === 0 ? {} : { optionalDependencies }),
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(bundle, 'BUILD.json'),
  `${JSON.stringify(
    {
      repository: 'https://github.com/hxy91819/deepseek-harness',
      base,
      commit,
      packages: tarballs.length,
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(bundle, 'README.md'), readme)

const sums = tarballs
  .map(filename => `${sha256(join(packagesDir, filename))}  packages/${filename}`)
  .join('\n')
writeFileSync(join(bundle, 'SHA256SUMS'), `${sums}\n`)

const archiveName = `${bundleName}-npm-bundle.tar.gz`
const archive = join(output, archiveName)
rmSync(archive, { force: true })
run('tar', ['czf', archive, '-C', work, bundleName], output)
writeFileSync(join(output, 'SHA256SUMS'), `${sha256(archive)}  ${archiveName}\n`)

console.log(
  JSON.stringify(
    { tag, base, commit, bundleVersion, packages: tarballs.length, archive, archiveSha256: sha256(archive) },
    null,
    2,
  ),
)
