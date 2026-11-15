import type { ArchivePackage, ArchiveWindow, PartitionFile } from './archive-types'

// 分区归档产物独立持久化，与条目数据（lake-govern-config:entries）分开存放，
// 重置某个业务模块不会清掉已经落库的归档结论。
const FILE_KEY = 'lake-govern-config:archive-files'
const WINDOW_KEY = 'lake-govern-config:archive-windows'
const PACKAGE_KEY = 'lake-govern-config:archive-packages'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readKey<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeKey<T>(key: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let fileCache: PartitionFile[] | null = null
let windowCache: ArchiveWindow[] | null = null
let packageCache: ArchivePackage[] | null = null

export function loadFiles(): PartitionFile[] {
  if (fileCache === null) {
    fileCache = readKey<PartitionFile[]>(FILE_KEY, [])
  }
  return fileCache
}

export function saveFiles(files: PartitionFile[]): void {
  fileCache = clone(files)
  writeKey(FILE_KEY, fileCache)
}

export function loadWindows(): ArchiveWindow[] {
  if (windowCache === null) {
    windowCache = readKey<ArchiveWindow[]>(WINDOW_KEY, [])
  }
  return windowCache
}

export function saveWindows(windows: ArchiveWindow[]): void {
  windowCache = clone(windows)
  writeKey(WINDOW_KEY, windowCache)
}

export function loadPackages(): ArchivePackage[] {
  if (packageCache === null) {
    packageCache = readKey<ArchivePackage[]>(PACKAGE_KEY, [])
  }
  return packageCache
}

export function savePackages(packages: ArchivePackage[]): void {
  packageCache = clone(packages)
  writeKey(PACKAGE_KEY, packageCache)
}

export function resetArchive(): void {
  fileCache = []
  windowCache = []
  packageCache = []
  writeKey(FILE_KEY, [])
  writeKey(WINDOW_KEY, [])
  writeKey(PACKAGE_KEY, [])
}

export function archiveStorageKeys(): string[] {
  return [FILE_KEY, WINDOW_KEY, PACKAGE_KEY]
}
