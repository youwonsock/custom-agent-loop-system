const path = require("node:path");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  packagerConfig: {
    asar: {
      unpackDir: "core/native",
    },
    prune: true,
    platform: "win32",
    arch: "x64",
    name: "Agent Loop Orchestrator",
    executableName: "agent-loop-orchestrator",
    // The webpack plugin normally keeps only `.webpack`. The utility-process
    // entry also loads the staged compiled core and its production dependencies
    // (fs-extra/node-pty), so retain those two runtime trees in the app.
    // Keep Forge's normal copy traversal.  The webpack output, staged core,
    // and production dependencies are all needed by the packaged runtime;
    // `prune` removes development dependencies after copying.
    ignore: () => false,
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
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "agent_loop_orchestrator",
        authors: "Agent Loop Orchestrator",
        description: "Agent Loop Orchestrator operator console",
        setupExe: "AgentLoopOrchestratorSetup.exe",
        noMsi: true,
      },
    },
  ],
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
