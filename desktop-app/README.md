# Agent Loop Orchestrator desktop

This package is the Windows 10/11 x64 operator console for Agent Loop Orchestrator 8.0.0.

The root build stages compiled core JavaScript and definition JSON into `core/`; no root
`node_modules` are copied. Forge rebuilds `node-pty` for Electron 44 and unpacks its native binary
outside ASAR. Provider CLIs remain external and are only detected by the app.

```powershell
# from the repository root
npm run bundle:desktop-core
npm --prefix desktop-app ci
npm --prefix desktop-app start
npm run package:desktop
```

The renderer receives only the task-scoped `DesktopBridge` from preload. It cannot access Node.js,
Electron IPC primitives, arbitrary navigation, downloads, or popups.
