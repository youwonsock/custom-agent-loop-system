const fs = require("fs");
const path = require("path");

if (process.platform === "win32") {
  process.exit(0);
}

const ptyDir = path.dirname(require.resolve("node-pty"));
const prebuildsDir = path.join(ptyDir, "..", "prebuilds");

if (!fs.existsSync(prebuildsDir)) process.exit(0);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name === "spawn-helper") {
      try {
        fs.chmodSync(full, 0o755);
        console.log(`[postinstall] Fixed permissions: ${full}`);
      } catch (err) {
        console.warn(`[postinstall] Failed to chmod ${full}: ${err.message}`);
      }
    }
  }
}

walk(prebuildsDir);
