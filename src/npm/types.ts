export interface PackageIdentity {
  name?: string
  installPath: string
  version: string
}

export interface LockedPackage extends PackageIdentity {
  resolved: string
  integrity: string
  bundledPackages?: PackageIdentity[]
}

export interface RuntimeLock {
  version: 1
  packages: LockedPackage[]
}

export interface InstallProgress {
  completed: number
  total: number
  package: LockedPackage
}
