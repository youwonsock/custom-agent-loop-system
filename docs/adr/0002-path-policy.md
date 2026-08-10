# ADR 0002: Path policy and TOCTOU scope

- Status: Proposed
- Date: 2026-08-08

## Decision

Use three distinct path policies:

1. Internal state/control access uses strict identifiers, lexical containment, canonical parent checks, and local-filesystem-only storage.
2. Provider access to the project is governed by the provider or OS sandbox.
3. Paths extracted from model text are warnings and audit evidence only.

Path dialect is explicit (`win32`, `posix`, or a separately supported WSL mode). A POSIX absolute path is never normalized through the Windows path API merely because `path.win32.isAbsolute()` accepts it.

For a not-yet-existing destination, validate the nearest existing ancestor and the remaining suffix. Reject unsupported device paths, ADS, reserved identifiers, and network data roots.

## Limitation

Node-level `realpath` followed by a normal open is not TOCTOU-proof against a malicious same-user process. Stronger claims require native secure-open primitives or a separate OS identity.

