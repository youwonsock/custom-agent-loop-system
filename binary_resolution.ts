import * as fs from "node:fs";
import * as path from "node:path";

function resolveCmdToExe(cmdPath: string): string {
  try {
    const content = fs.readFileSync(cmdPath, "utf8");
    const cmdDir = path.dirname(cmdPath);
    const exeMatch = content.match(/"%dp0%\\([^\"]+\.exe)"/i);
    if (exeMatch) {
      const resolved = path.join(cmdDir, exeMatch[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // Ignore inaccessible launch shims and let the normal spawn error explain it.
  }
  return cmdPath;
}

export function resolveBinaryForSpawn(binary: string): string {
  if (process.platform !== "win32") return binary;
  if (path.extname(binary).length > 0) return binary;
  if (path.isAbsolute(binary) && fs.existsSync(binary)) return binary;
  if (binary.toLowerCase() === "codex") {
    const architecture = process.arch === "arm64"
      ? { packageName: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
      : { packageName: "codex-win32-x64", target: "x86_64-pc-windows-msvc" };
    const bundledCodex = path.resolve(
      __dirname,
      "..",
      "node_modules",
      "@openai",
      architecture.packageName,
      "vendor",
      architecture.target,
      "bin",
      "codex.exe"
    );
    if (fs.existsSync(bundledCodex)) return bundledCodex;
  }
  const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
  const extensions = pathExt.split(";").filter(Boolean);
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, binary + extension);
      try {
        if (!fs.existsSync(candidate)) continue;
        if ([".cmd", ".bat"].includes(extension.toLowerCase())) {
          const executable = resolveCmdToExe(candidate);
          if (executable !== candidate) return executable;
        }
        return candidate;
      } catch {
        // Continue searching PATH entries.
      }
    }
  }
  return binary;
}
