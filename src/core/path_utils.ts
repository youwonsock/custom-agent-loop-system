// win32.isAbsolute('/tmp') is true, so it cannot distinguish POSIX roots.
export function isWindowsAbsolutePath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)
  );
}
