# Security model

This document defines the security boundary used by the Agent Loop core and VS Code extension. It is intentionally narrower than the permissions of the host user account.

## Trust assumptions

- The target project, repository instructions, model output, provider events, and MCP responses are untrusted input.
- Packaged core code, validated user configuration, extension global storage, and the parent orchestrator process are trusted.
- Provider executables are trusted to implement their declared sandbox contract. A provider that cannot enforce a requested capability must fail closed.
- Workspace settings are not trusted until VS Code Workspace Trust is granted.

## Required isolation

- Agent processes receive the project root, not the session data root, as their writable workspace.
- Session state, leases, control requests, logs, and recovery data must not live below the project root.
- Read-only stages must be prevented from mutating files by the provider or OS sandbox. Output inspection and post-run diffs are defense in depth, not the primary boundary.
- Side-effecting MCP tools are not available to read-only stages unless their capabilities are explicitly classified and enforced.
- Unknown or destructive interactive prompts are never answered affirmatively without an explicit user decision.

## Full-access limitation

A child process running with the same host-user privileges and unrestricted filesystem access can reach user data outside the project. Moving session data outside the project does not protect it from this mode. Until a separate OS identity or an enforceable deny rule is available, full access is an explicit unsafe mode and must not be described as isolated from the control plane.

## Path guarantees

- Internal data/control paths use validated identifiers, containment checks, and local-filesystem storage.
- Provider project access is enforced by the provider or OS sandbox, not by scanning model text for paths.
- Paths extracted from model output are audit signals only.
- `realpath` and component checks reduce symlink/junction risk but do not prove safety against a malicious same-user process swapping links between validation and open.

## Secrets

- Only provider-required environment variables should be forwarded.
- Every resolved secret value must be registered with the streaming redactor before child output is consumed.
- Secrets must not appear in command-line arguments, state, registry data, progress notes, logs, or crash diagnostics.
- Remote MCP credentials require HTTPS, except for explicitly supported loopback development endpoints.

## Explicitly unsupported guarantees

- Exactly-once execution of third-party provider or remote MCP side effects after a host crash.
- Isolation of the data root from a host-wide full-access child running as the same user.
- Protection from every same-user symlink-swap or PID-reuse race without native OS primitives.
- Detection of encoded, transformed, or provider-retained copies of a secret.
- Complete behavior guarantees for future third-party CLI versions.

