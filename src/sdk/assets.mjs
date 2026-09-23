import {cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync} from 'node:fs'
import {dirname, basename, join, resolve, relative, isAbsolute, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {verifySDK} from './verify-sdk.mjs'

function packageRoot() {
  return dirname(fileURLToPath(import.meta.url))
}

function verifiedSource(name) {
  const root = packageRoot()
  verifySDK(root)
  const source = join(root, name)
  if (!lstatSync(source).isDirectory()) throw new Error(`SDK ${name} must be a directory`)
  return {root, source}
}

function copyVerifiedDirectory(name, destination) {
  if (typeof destination !== 'string' || !destination || destination.includes('\0')) throw new TypeError('Expected a destination directory path')
  const {root, source} = verifiedSource(name)
  const requested = resolve(destination)
  // Resolve the existing parent before creating anything. No recursive mkdir or
  // overwrite is allowed, so a mistaken destination cannot replace user files.
  const parent = realpathSync(dirname(requested))
  if (!lstatSync(parent).isDirectory()) throw new Error('Destination parent must be a directory')
  const target = join(parent, basename(requested))
  const inside = relative(realpathSync(root), target)
  if (!inside || (inside.split(sep)[0] !== '..' && !isAbsolute(inside))) throw new Error('Destination must be outside the SDK package')
  mkdirSync(target)
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(target, name), {recursive: true, dereference: false, errorOnExist: true, force: false})
  }
  return target
}

/**
 * Copy this package's verified runtime tree to a new directory for same-origin
 * hosting. The parent must already exist. Returns its canonical absolute path.
 * A copy failure can leave partial output; this helper never deletes files.
 */
export function copyRuntimeAssets(destination) {
  return copyVerifiedDirectory('runtime', destination)
}

/**
 * Copy the package's verified preview-host tree, including hosting.json, to a
 * new directory. The same no-overwrite and path-boundary rules used by the
 * runtime asset helper apply.
 */
export function copyPreviewHostAssets(destination) {
  return copyVerifiedDirectory('preview-host', destination)
}

/** Return a fresh copy of the verified preview-host deployment contract. */
export function readPreviewHostHostingContract() {
  const {source} = verifiedSource('preview-host')
  return JSON.parse(readFileSync(join(source, 'hosting.json'), 'utf8'))
}
