# 7.0.0 profile migration

Version 7 removes superseded projection, workflow, and VS Code/VSIX runtime contracts. Existing
session state is deliberately not replayed or converted. The upgrade command preserves the configured
loop settings, secure credentials, model variants, project source trees, and working-tree changes.

Preview the exact destructive target set before running the reset:

```powershell
agent-loop upgrade --reset-sessions --dry-run --data-root <data-root> --config-root <config-root>
agent-loop upgrade --reset-sessions --data-root <data-root> --config-root <config-root>
```

The preview fixes the resolved sessions root, registry, session index, loop history, session IDs,
absolute deletion targets, warnings, definition hash, and expected v7 manifest. A malformed JSON index,
unsafe session directory, symbolic link, path escape, live owner, child process, or incomplete journal
stops the operation before any move. A missing or older index is read by the migration scanner; it is
never normalized through the current projection validator.

The reset is journaled and resumable. It archives the old manifest, verifies owners and child processes,
moves the fixed session set into a tombstone, removes the registry/index/history runtime state, installs
the v7 definitions, writes the v7 manifest, verifies the definition hash and preserved settings, then
removes the tombstone. A normal command refuses to start while an unfinished journal exists; only
`upgrade` may resume that exact target list. Files created after the target list is fixed are not added
automatically.

After completion, verify the new manifest and version-4 empty session index. The root-level
`sessions_registry.json` is considered a stale artifact unless it resolves under the active configured
data root; it is never deleted merely because it has the same filename.
