# ADR 0009: Independent Windows desktop transition

## Status

Accepted for v5.0.0 and superseded by the v6 verification transition. Earlier VSIX decisions remain
historical and are superseded for the GUI surface; their ADRs are not rewritten.

## Decision

The operator GUI is delivered as a Windows 10/11 x64 Electron 44 application. The CLI, protocol v3,
projection schema 2/state schema 5, and session index v4 remain the authoritative compatibility
contracts. Electron
uses a sandboxed renderer and a task-scoped preload bridge; core work runs in utility processes from the
packaged compiled bundle. Provider CLIs remain external and are discovered, never installed, by the app.

Configuration and encrypted secret references live under `%APPDATA%\\AgentLoopOrchestrator`; session
state, projections, leases, and logs live under `%LOCALAPPDATA%\\AgentLoopOrchestrator`. A chosen project
must be local and outside both roots. Closing the window hides it in the tray; only an explicitly
confirmed Stop & Quit may terminate active sessions.

## Consequences

There is no VS Code host, embedded terminal, provider installer, migration of extension storage, or
automatic updater. The Windows package includes the win32-x64 verification process helper outside ASAR;
the helper is built once in CI and its manifest is bound to the release artifact. Existing VSIX ADRs
remain useful historical records and are marked superseded by this decision rather than overwritten.
