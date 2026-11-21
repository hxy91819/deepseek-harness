/** ZIP extraction keeps every entry and link inside the destination directory. */

import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync, type ZipAttributes } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { extractZip } from './zip-extract.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Create an isolated extraction root and return it. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zip-extract-'))
  roots.push(root)
  return root
}

/** Encode a Unix external-attribute record for one entry. */
function unix(mode: number): ZipAttributes {
  return { os: 3, attrs: (mode << 16) >>> 0 }
}

it('extracts files and preserves Unix executable permissions', async () => {
  const root = await makeRoot()
  const archive = join(root, 'archive.zip')
  await writeFile(archive, zipSync({
    'bin/tool': [strToU8('#!/bin/sh\n'), unix(0o100755)],
    'docs/readme.txt': strToU8('hello\n'),
  }))
  const destination = join(root, 'out')
  await extractZip(archive, { dir: destination })
  expect(await readFile(join(destination, 'docs/readme.txt'), 'utf8')).toBe('hello\n')
  expect((await stat(join(destination, 'bin/tool'))).mode & 0o777).toBe(0o755)
})

it('rejects entries that resolve outside the destination', async () => {
  const root = await makeRoot()
  const archive = join(root, 'archive.zip')
  await writeFile(archive, zipSync({ '../escape.txt': strToU8('x') }))
  await expect(extractZip(archive, { dir: join(root, 'out') })).rejects.toThrow()
  await expect(lstat(join(root, 'escape.txt'))).rejects.toThrow()
})

it('extracts a relative symbolic link that stays inside the destination', async () => {
  const root = await makeRoot()
  const archive = join(root, 'archive.zip')
  await writeFile(archive, zipSync({
    'versions/current': [strToU8('1.0'), unix(0o120777)],
    'versions/1.0/file.txt': strToU8('ok\n'),
  }))
  const destination = join(root, 'out')
  await extractZip(archive, { dir: destination })
  expect(await readlink(join(destination, 'versions/current'))).toBe('1.0')
  expect(await readFile(join(destination, 'versions/current/file.txt'), 'utf8')).toBe('ok\n')
})

it('rejects symbolic link targets outside the destination', async () => {
  const root = await makeRoot()
  const archive = join(root, 'archive.zip')
  await writeFile(archive, zipSync({ link: [strToU8('../../etc/passwd'), unix(0o120777)] }))
  await expect(extractZip(archive, { dir: join(root, 'out') })).rejects.toThrow('symbolic link leaves the destination')
  await expect(lstat(join(root, 'out/link'))).rejects.toThrow()
})
