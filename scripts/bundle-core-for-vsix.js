#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const destination = path.join(root, "vscode-extension", "core");
const distDestination = path.join(destination, "dist");

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(distDestination, { recursive: true });

for (const name of fs.readdirSync(path.join(root, "dist"))) {
  if (!name.endsWith(".js") && !name.endsWith(".json")) continue;
  if (name.endsWith(".test.js")) continue;
  fs.copyFileSync(path.join(root, "dist", name), path.join(distDestination, name));
}

for (const name of [
  "agent_loop.json",
  "agent_loop.schema.json",
  "agent_roles.json",
  "agent_roles.schema.json",
  "loop_config.schema.json",
  "runtime_defaults.json",
]) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
}

const productionPackages = [
  "fs-extra",
  "graceful-fs",
  "jsonfile",
  "universalify",
  "node-pty",
];
for (const packageName of productionPackages) {
  const source = path.join(root, "node_modules", packageName);
  if (!fs.existsSync(source)) {
    throw new Error(`Cannot bundle missing production dependency: ${packageName}`);
  }
  fs.cpSync(source, path.join(destination, "node_modules", packageName), {
    recursive: true,
    force: true,
  });
}

const nodePtyDestination = path.join(destination, "node_modules", "node-pty");
const nativePlatform = `${process.platform}-${process.arch}`;
const nativePrebuild = path.join(nodePtyDestination, "prebuilds", nativePlatform);
const hasNativePrebuild = fs.existsSync(nativePrebuild);
for (const disposable of ["deps", "scripts", "src", "third_party", "typings"]) {
  fs.rmSync(path.join(nodePtyDestination, disposable), { recursive: true, force: true });
}
if (hasNativePrebuild) {
  fs.rmSync(path.join(nodePtyDestination, "build"), { recursive: true, force: true });
}
const prebuildsRoot = path.join(nodePtyDestination, "prebuilds");
if (fs.existsSync(prebuildsRoot)) {
  for (const entry of fs.readdirSync(prebuildsRoot)) {
    if (entry !== nativePlatform) {
      fs.rmSync(path.join(prebuildsRoot, entry), { recursive: true, force: true });
    }
  }
}
const pruneDevelopmentFiles = (directory) => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneDevelopmentFiles(entryPath);
      continue;
    }
    if (entry.name.endsWith(".pdb") || entry.name.endsWith(".map") || entry.name.endsWith(".test.js")) {
      fs.rmSync(entryPath, { force: true });
    }
  }
};
pruneDevelopmentFiles(nodePtyDestination);

if (!hasNativePrebuild && !fs.existsSync(path.join(nodePtyDestination, "build", "Release", "pty.node"))) {
  throw new Error(`node-pty has no native binary for ${nativePlatform}. Run npm install on the target platform first.`);
}

const manifest = {
  formatVersion: 1,
  coreVersion: require(path.join(root, "package.json")).version,
  entrypoint: "dist/loop_orchestrator.js",
  targetPlatform: nativePlatform,
};
fs.writeFileSync(
  path.join(destination, "bundle-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
