/** Extract ZIP archives without letting an entry write or link outside its destination. */

import { createWriteStream } from 'node:fs'
import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { open, type Entry, type ZipFile } from 'yauzl'

const FILE_TYPE_MASK = 0o170000
const DIRECTORY_TYPE = 0o040000
const SYMLINK_TYPE = 0o120000
const MAX_SYMLINK_TARGET_BYTES = 4096

/** Directory and entry hook for one extraction. */
export interface ExtractZipOptions {
  /** Absolute directory receiving the archive contents; created when absent. */
  dir: string
  /** Validates an entry before it is written; throwing aborts the extraction. */
  onEntry?: (entry: Entry) => void
}

/** Open a ZIP archive for lazy entry-by-entry reading. */
function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    open(path, { lazyEntries: true }, (error, zip) => {
      if (error === null) resolvePromise(zip)
      else reject(error)
    })
  })
}

/** Open one entry's decompressed byte stream. */
function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error === null) resolvePromise(stream)
      else reject(error)
    })
  })
}

/** Report whether an unknown thrown value is a Node.js filesystem error. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** Report whether a resolved path stays within the extraction root. */
function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** Return an entry's Unix permission bits or the fallback when the archive records none. */
function permissions(entry: Entry, fallback: number): number {
  const mode = ((entry.externalFileAttributes >>> 16) & 0xffff) & 0o777
  return mode === 0 ? fallback : mode
}

/** Report whether an entry describes a directory rather than a file. */
function isDirectory(entry: Entry): boolean {
  if (entry.fileName.endsWith('/')) return true
  if ((((entry.externalFileAttributes >>> 16) & 0xffff) & FILE_TYPE_MASK) === DIRECTORY_TYPE) return true
  return (entry.versionMadeBy >>> 8) === 0 && entry.externalFileAttributes === 16
}

/** Report whether an entry describes a symbolic link. */
function isSymlink(entry: Entry): boolean {
  return (((entry.externalFileAttributes >>> 16) & 0xffff) & FILE_TYPE_MASK) === SYMLINK_TYPE
}

/** Read an entry that is expected to contain a small symbolic-link target. */
async function readSmallEntry(zip: ZipFile, entry: Entry): Promise<string> {
  if (entry.uncompressedSize > MAX_SYMLINK_TARGET_BYTES) {
    throw new Error(`zip-extract: symbolic link target is too large: ${entry.fileName}`)
  }
  const chunks: Buffer[] = []
  for await (const chunk of await openEntry(zip, entry) as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Create every missing parent directory without following a symbolic link out of the extraction root.
 * @param root - Real extraction root.
 * @param destination - Absolute entry destination.
 * @returns Resolves after the parent exists and resolves within the root.
 */
async function prepareParent(root: string, destination: string): Promise<void> {
  const segments = relative(root, dirname(destination)).split(sep).filter(segment => segment !== '')
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    const existing = await lstat(current).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing === undefined) {
      await mkdir(current)
      continue
    }
    if (existing.isDirectory()) continue
    if (!existing.isSymbolicLink()) throw new Error(`zip-extract: unsupported path component: ${current}`)
    if (!within(root, await realpath(current))) throw new Error(`zip-extract: entry leaves the destination: ${destination}`)
  }
}

/**
 * Extract one entry after validating its destination and link target.
 * @param zip - Open archive.
 * @param entry - Entry to extract.
 * @param root - Real extraction root.
 * @param options - Extraction options, including the entry hook.
 * @returns Resolves after the entry is written.
 */
async function extractEntry(zip: ZipFile, entry: Entry, root: string, options: ExtractZipOptions): Promise<void> {
  if (entry.fileName.startsWith('__MACOSX/')) return
  options.onEntry?.(entry)

  const destination = resolve(root, entry.fileName)
  if (!within(root, destination)) throw new Error(`zip-extract: entry leaves the destination: ${entry.fileName}`)
  await prepareParent(root, destination)

  const existing = await lstat(destination).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (isDirectory(entry)) {
    if (existing !== undefined && !existing.isDirectory()) throw new Error(`zip-extract: duplicate entry: ${entry.fileName}`)
    if (existing === undefined) await mkdir(destination, { mode: permissions(entry, 0o755) })
    return
  }
  if (existing !== undefined) throw new Error(`zip-extract: duplicate entry: ${entry.fileName}`)

  if (isSymlink(entry)) {
    const target = await readSmallEntry(zip, entry)
    if (target === '' || target.includes('\0')) throw new Error(`zip-extract: invalid symbolic link target: ${entry.fileName}`)
    if (!within(root, resolve(dirname(destination), target))) {
      throw new Error(`zip-extract: symbolic link leaves the destination: ${entry.fileName}`)
    }
    await symlink(target, destination)
    return
  }

  await pipeline(await openEntry(zip, entry), createWriteStream(destination, { mode: permissions(entry, 0o644) }))
}

/**
 * Extract a ZIP archive, rejecting entries that resolve outside the destination directory.
 * @param archive - ZIP archive path.
 * @param options - Destination directory and optional entry hook.
 * @returns Resolves after every entry is written.
 */
export async function extractZip(archive: string, options: ExtractZipOptions): Promise<void> {
  if (!isAbsolute(options.dir)) throw new Error('zip-extract: destination directory must be absolute')
  await mkdir(options.dir, { recursive: true })
  const root = await realpath(options.dir)
  const zip = await openArchive(archive)
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      zip.close()
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    zip.on('error', (error: Error) => { finish(error) })
    zip.on('close', () => { finish() })
    zip.on('entry', (entry: Entry) => {
      extractEntry(zip, entry, root, options).then(
        () => { if (!settled) zip.readEntry() },
        (error: unknown) => { finish(error instanceof Error ? error : new Error(String(error))) },
      )
    })
    zip.readEntry()
  })
}
