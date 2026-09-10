const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const { FuseState, FuseV1Options, getCurrentFuseWire } = await import("@electron/fuses");
  const candidates = process.argv[2]
    ? [path.resolve(process.argv[2])]
    : findExecutables(path.resolve(__dirname, "..", "out"));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Packaged Electron executable not found for fuse verification.");
  const wire = await getCurrentFuseWire(executable);
  if (wire.version !== "1") throw new Error(`Unsupported fuse wire version: ${wire.version}.`);
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  ]);
  for (const [fuse, state] of expected) {
    if (wire[fuse] !== state) throw new Error(`Fuse ${FuseV1Options[fuse]} was ${wire[fuse]}, expected ${state}.`);
  }
  console.log(`Electron fuses verified: ${path.basename(executable)}.`);
}

function findExecutables(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...findExecutables(candidate));
    else if (entry.isFile() && entry.name.toLowerCase() === "agent-loop-orchestrator.exe") result.push(candidate);
  }
  return result;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
