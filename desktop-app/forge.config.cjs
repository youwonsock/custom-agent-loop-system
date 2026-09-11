const path = require("node:path");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

const runtimeDirectories = [
  ".webpack",
  "core",
  "node_modules/fs-extra/lib",
  "node_modules/graceful-fs",
  "node_modules/jsonfile",
  "node_modules/universalify",
  "node_modules/node-pty/lib",
  "node_modules/node-pty/prebuilds/win32-x64",
];
const runtimeFiles = new Set([
  "package.json",
  "node_modules/fs-extra/package.json",
  "node_modules/graceful-fs/package.json",
  "node_modules/jsonfile/package.json",
  "node_modules/universalify/package.json",
  "node_modules/node-pty/package.json",
]);

function packagedRelativePath(file) {
  const raw = String(file).replace(/\\/gu, "/");
  if (!/^[A-Za-z]:\//u.test(raw) && raw.startsWith("/")) return raw.slice(1);
  const absolute = path.resolve(file);
  return path.relative(__dirname, absolute).replace(/\\/gu, "/");
}

function isRuntimePath(relative) {
  if (!relative || relative === ".") return true;
  if (runtimeFiles.has(relative)) return true;
  return runtimeDirectories.some((directory) =>
    relative === directory || relative.startsWith(`${directory}/`) || directory.startsWith(`${relative}/`)
  );
}

function shouldIgnorePackagedPath(file) {
  const relative = packagedRelativePath(file);
  if (/\.map$/u.test(relative)) return true;
  if (/\/(?:[^/]+\.)?(?:test|spec)\.[^/]+$/iu.test(relative)) return true;
  if (/^node_modules\/node-pty\/prebuilds\/win32-x64\/.*\.pdb$/iu.test(relative)) return true;
  if (/(?:^|\/)__tests__(?:\/|$)/iu.test(relative)) return true;
  if (relative.startsWith("node_modules/node-pty/prebuilds/") && !relative.startsWith("node_modules/node-pty/prebuilds/win32-x64/")) return true;
  return !isRuntimePath(relative);
}

module.exports = {
  packagerConfig: {
    asar: {
      unpackDir: "core/native",
    },
    // Keep a native resources copy for Chromium's Windows file loader.  The
    // renderer is also retained in app.asar so the archive boundary remains
    // inspectable and deterministic.
    extraResource: [path.resolve(__dirname, ".webpack", "x64", "renderer")],
    prune: true,
    platform: "win32",
    arch: "x64",
    name: "Agent Loop Orchestrator",
    executableName: "agent-loop-orchestrator",
    // Keep only the webpack bundle, staged core, and the small production
    // dependency closure used by the bundled core.  Forge's default filter
    // cannot retain the staged core, while accepting everything would leak
    // the desktop source tree, tests, and build toolchain into app.asar.
    ignore: shouldIgnorePackagedPath,
    win32metadata: {
      ProductName: "Agent Loop Orchestrator",
      FileDescription: "Agent Loop Orchestrator operator console",
      CompanyName: "Agent Loop Orchestrator",
    },
    // The signing hook is intentionally empty for the unsigned v1 release.
    ...(process.env.AGENT_LOOP_WINDOWS_CERTIFICATE_FILE ? {
      windowsSign: { certificateFile: process.env.AGENT_LOOP_WINDOWS_CERTIFICATE_FILE },
    } : {}),
  },
  rebuildConfig: {
    // node-pty 1.1.0 ships an N-API win32-x64 prebuild.  Electron 44 can
    // load that ABI-stable binary directly; rebuilding it here would require
    // the optional Spectre-mitigated MSVC libraries and would make packaging
    // depend on a toolchain component that is not part of the app runtime.
    force: false,
    onlyModules: [],
  },
  plugins: [
    {
      name: "@electron-forge/plugin-webpack",
      config: {
        mainConfig: path.resolve(__dirname, "webpack.main.config.js"),
        renderer: {
          config: path.resolve(__dirname, "webpack.renderer.config.js"),
          entryPoints: [
            {
              name: "main_window",
              html: path.resolve(__dirname, "src/renderer/index.html"),
              js: path.resolve(__dirname, "src/renderer.ts"),
              preload: { js: path.resolve(__dirname, "src/preload.ts") },
            },
          ],
        },
      },
    },
    { name: "@electron-forge/plugin-auto-unpack-natives", config: {} },
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      },
    },
  ],
};
