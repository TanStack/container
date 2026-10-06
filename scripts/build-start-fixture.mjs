import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = path.join(projectRoot, 'fixtures/start-basic')
const outputDirectory = path.join(projectRoot, 'public/start-fixture')
const projectOutputDirectory = path.join(outputDirectory, 'project')
const fixtureDependencies = {
  '@tanstack/react-router': '1.170.15',
  '@tanstack/react-start': '1.168.25',
  react: '19.1.1',
  'react-dom': '19.1.1',
}

await mkdir(outputDirectory, { recursive: true })
await mkdir(projectOutputDirectory, { recursive: true })
await mkdir(path.join(projectOutputDirectory, 'src'), { recursive: true })
await cp(
  path.join(fixtureRoot, 'src/router.tsx'),
  path.join(projectOutputDirectory, 'src/router.tsx'),
)
await cp(
  path.join(fixtureRoot, 'src/routes'),
  path.join(projectOutputDirectory, 'src/routes'),
  {
    recursive: true,
  },
)
await writeFile(
  path.join(projectOutputDirectory, 'package.json'),
  `${JSON.stringify(
    {
      name: 'browser-start-fixture',
      private: true,
      type: 'module',
      dependencies: fixtureDependencies,
    },
    null,
    2,
  )}\n`,
)

async function listProjectFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(
        ...(await listProjectFiles(
          path.join(directory, entry.name),
          relativePath,
        )),
      )
    } else if (/\.(?:json|[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(relativePath)
    }
  }
  return files.sort()
}

const projectFiles = (await listProjectFiles(projectOutputDirectory)).filter(
  (file) => file !== 'src/routeTree.gen.ts',
)
await writeFile(
  path.join(outputDirectory, 'project-manifest.json'),
  `${JSON.stringify({ files: projectFiles }, null, 2)}\n`,
)

const packageLock = JSON.parse(
  await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'),
)

function findInstalledPackage(dependencyName, ownerInstallPath = '') {
  const rootCandidate = path.posix.join('node_modules', dependencyName)
  if (packageLock.packages[rootCandidate]) return rootCandidate

  let directory = ownerInstallPath
    ? path.join(projectRoot, ownerInstallPath)
    : projectRoot
  while (directory.startsWith(projectRoot)) {
    const candidate = path.join(directory, 'node_modules', dependencyName)
    const relative = path
      .relative(projectRoot, candidate)
      .split(path.sep)
      .join('/')
    if (packageLock.packages[relative]) return relative
    if (directory === projectRoot) break
    directory = path.dirname(directory)
  }
  return undefined
}

async function createBrowserBuildLock(rootPackageNames) {
  const excluded = new Set([
    'vite',
    'esbuild',
    'rollup',
    'lightningcss',
    '@vitejs/plugin-react',
  ])
  const packagePaths = new Set()
  const pendingPackages = [...rootPackageNames]
    .filter((name) => !excluded.has(name))
    .map((name) => {
      const installPath = findInstalledPackage(name)
      if (!installPath)
        throw new Error(`Could not find installed package '${name}'`)
      return installPath
    })

  while (pendingPackages.length) {
    const installPath = pendingPackages.shift()
    if (packagePaths.has(installPath)) continue
    packagePaths.add(installPath)
    const packageJson = JSON.parse(
      await readFile(
        path.join(projectRoot, installPath, 'package.json'),
        'utf8',
      ),
    )
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ])
    for (const dependencyName of dependencyNames) {
      if (excluded.has(dependencyName)) continue
      const dependencyPath = findInstalledPackage(dependencyName, installPath)
      if (dependencyPath) pendingPackages.push(dependencyPath)
    }
  }

  return {
    version: 1,
    packages: [...packagePaths].sort().map((installPath) => {
      const lockEntry = packageLock.packages[installPath]
      if (!lockEntry.resolved || !lockEntry.integrity) {
        throw new Error(
          `Package '${installPath}' has no registry resolution or integrity`,
        )
      }
      return {
        installPath: `/${installPath}`,
        version: lockEntry.version,
        resolved: lockEntry.resolved,
        integrity: lockEntry.integrity,
      }
    }),
  }
}

const browserBuildLock = await createBrowserBuildLock(
  new Set(Object.keys(fixtureDependencies)),
)
// The fixed fixture is self-contained. Read only public, integrity-pinned npm
// archive content, never cache metadata or credentials. This is not the general
// SDK package cache. npm install must have populated the standard npm v2 cache.
const npmCache = execFileSync('npm', ['config', 'get', 'cache'], {
  encoding: 'utf8',
}).trim()
if (!path.isAbsolute(npmCache))
  throw new Error('npm cache path must be absolute')
const archivesDirectory = path.join(outputDirectory, 'archives')
await mkdir(archivesDirectory, { recursive: true })
let archiveBytes = 0
for (const pkg of browserBuildLock.packages) {
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity))
    throw new Error('Expected SHA-512 fixture integrity')
  const digest = Buffer.from(pkg.integrity.slice(7), 'base64').toString('hex')
  if (digest.length !== 128) throw new Error('Invalid SHA-512 fixture digest')
  const source = path.join(
    npmCache,
    '_cacache/content-v2/sha512',
    digest.slice(0, 2),
    digest.slice(2, 4),
    digest.slice(4),
  )
  let archive
  try {
    archive = await readFile(source)
  } catch {
    throw new Error(
      `Missing pinned fixture archive. Populate npm cache with: npm cache add ${pkg.resolved} --ignore-scripts`,
    )
  }
  if (
    archive.length > 16 * 1024 * 1024 ||
    createHash('sha512').update(archive).digest('hex') !== digest
  )
    throw new Error(`Invalid cached fixture archive: ${pkg.installPath}`)
  await writeFile(path.join(archivesDirectory, digest + '.tgz'), archive)
  archiveBytes += archive.length
}
await writeFile(
  path.join(outputDirectory, 'browser-build-lock.json'),
  `${JSON.stringify(browserBuildLock, null, 2)}\n`,
)
await writeFile(
  path.join(outputDirectory, 'browser-build-local-lock.json'),
  JSON.stringify(
    {
      ...browserBuildLock,
      packages: browserBuildLock.packages.map((pkg) => ({
        ...pkg,
        registryResolved: pkg.resolved,
        resolved:
          '/start-fixture/archives/' +
          Buffer.from(pkg.integrity.slice(7), 'base64').toString('hex') +
          '.tgz',
      })),
    },
    null,
    2,
  ) + '\n',
)

console.log(
  `Prepared ${projectFiles.length} raw Start files and ${browserBuildLock.packages.length} verified local package archives (${archiveBytes} bytes)`,
)
