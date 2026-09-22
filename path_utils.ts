import * as path from "node:path";

// win32.isAbsolute('/tmp') is true, so it cannot distinguish POSIX roots.
export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

export function resolveFileSystemPath(value: string): string {
  if (isWindowsAbsolutePath(value)) return path.win32.resolve(value);
  if (path.posix.isAbsolute(value)) return path.posix.resolve(value);
  return path.resolve(value);
}
