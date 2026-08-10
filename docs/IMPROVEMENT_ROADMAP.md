# Improvement roadmap

This roadmap separates the compatibility-preserving security hotfix from later state-layout and recovery work.

## Security hotfix candidate

1. Restore a green, pinned CI baseline and preserve 3.4.0 state/config fixtures.
2. Gate every extension process launch on Workspace Trust and remove automatic provider discovery.
3. Validate control identifiers and paths, quarantine malformed requests, correct POSIX path handling, and reject a mutable root inside the project.
4. Fail closed for read-only capabilities that a provider cannot enforce, disable generic automatic confirmation, and redact every resolved secret.
5. Make extension spawn/stop state truthful, isolate log buffers by session, and namespace secrets by data/config identity.
6. Build the candidate artifact once, unpack and test its bundled core and native PTY, then publish that exact artifact only after all declared Tier-1 targets pass.

The hotfix does not migrate the state format or introduce a general journal.

## Follow-up architecture

1. Introduce the RootSet resolver and core capability/version handshake.
2. Add shared path/config/protocol contracts and a versioned migrator.
3. Compile pipeline graphs, enforce approval gates, and add durable cycle/workflow/attempt budgets.
4. Introduce a shared session repository, owner fencing, revision CAS, bounded recovery WAL, and a rebuildable session index.
5. Make control application idempotent and route extension offline updates through repository transactions.
6. Enforce provider capability isolation and unify process supervision and descendant containment.
7. Split the orchestrator only after characterization tests protect the established behavior; then add quotas, event-driven summaries, performance gates, SBOMs, and release provenance.

## Remaining verification and delivery work

1. Run authenticated provider sandbox conformance tests for every supported CLI and Tier-1 OS; keep Codex read-only disabled until an isolated configuration home can exclude inherited MCP servers.
2. Add VS Code Extension Host UI end-to-end coverage for trust transitions, process recovery, Stop/Interrupt, settings changes, and SecretStorage migration.
3. Add raw-log backpressure and slow/filesystem-fault tests so the bounded close policy is exercised beyond the current EACCES/EISDIR/ENOSPC/EIO fixtures.
4. Add a tag/manual promotion workflow that consumes the already-tested OS artifacts without rebuilding, then signs or attests the VSIX, checksums, and SBOM before Marketplace or release publication.
5. Introduce a separate OS identity or native deny boundary before describing full-access sessions as isolated from Agent Loop control/state data.
6. Pin third-party GitHub Actions to immutable commit SHAs with automated update review, and reverify each OS-specific VSIX on Node 18 rather than using Linux as the runtime-floor representative.
7. Add an Extension Host coverage threshold and execute the full Windows/Linux/macOS matrix in the protected remote CI environment before promotion.

## Release gates

- No untrusted-workspace process launch.
- No internal path escape or malformed control request execution.
- No read-only mutation for supported provider profiles; unsupported profiles fail closed.
- No affirmative answer to an unknown or destructive prompt.
- No exact secret sentinel in arguments, output, state, logs, temporary files, or diagnostics.
- Native installed-artifact PTY lifecycle succeeds for every declared Tier-1 target.
- Tested artifacts are promoted without rebuilding.
