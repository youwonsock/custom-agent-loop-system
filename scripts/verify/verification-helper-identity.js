const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Read and validate the helper that is shipped with release candidates.  The
 * manifest is deliberately bound to the bytes on disk so a package cannot
 * claim a helper identity for a different executable.
 */
function readVerificationHelperIdentity(root, { required = true } = {}) {
  const helperDirectory = path.join(root, "native", "bin", "win32-x64");
  const executablePath = path.join(helperDirectory, "verification-host.exe");
  const manifestPath = path.join(helperDirectory, "verification-host.manifest.json");
  if (!fs.existsSync(executablePath) || !fs.existsSync(manifestPath)) {
    if (!required) return null;
    throw new Error(`Windows verification helper is missing from ${helperDirectory}.`);
  }
  let manifest;
  try {
    // Accept manifests produced by older Windows PowerShell builds that
    // emitted a UTF-8 BOM, while the current build script writes BOM-free
    // UTF-8 for deterministic Node parsing.
    const manifestText = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, "");
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Windows verification helper manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== "win32-x64" ||
    manifest.artifact !== "native/bin/win32-x64/verification-host.exe" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256 || "") ||
    manifest.sha256 !== digest
  ) {
    throw new Error("Windows verification helper manifest does not match the executable bytes or target.");
  }
  return {
    target: manifest.target,
    artifact: manifest.artifact,
    sha256: digest,
    sourceCommit: typeof manifest.sourceCommit === "string" ? manifest.sourceCommit : "unknown",
    manifestFile: "native/bin/win32-x64/verification-host.manifest.json",
  };
}

module.exports = { readVerificationHelperIdentity };
