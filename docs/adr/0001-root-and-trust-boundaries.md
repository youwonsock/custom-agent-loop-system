# ADR 0001: Root and trust boundaries

> v4 note: the deprecated `--root` compatibility input and all pre-v4 data migration paths have now
> been removed. `--data-root` and `--config-root` are the only supported root inputs.

- Status: Proposed
- Date: 2026-08-08

## Decision

Replace the overloaded legacy `root` concept with a resolved `RootSet`:

- `codeRoot`: packaged, read-only code and defaults
- `configRoot`: trusted configuration
- `projectRoot`: the untrusted agent workspace
- `dataRoot`: local session state, control, lease, log, and recovery data

The data and control roots stay together on one local filesystem so that atomic rename and recovery semantics remain available. Data-root discovery from the current working directory, workspace files, or the presence of a registry is not allowed.

Precedence is explicit CLI/extension input, followed by the OS application-data default. The legacy `--root` option is removed; profiles must use `--data-root` and `--config-root`.

## Immediate compatibility rule

Before the RootSet migration ships, a new run must fail before provider spawn when the mutable legacy root is equal to or contained by the project root. Existing sessions are not moved automatically.

## Migration

Migration is explicit and idempotent: copy to staging under the destination data root, validate schema and checksums, atomically rename within that root, then write a migration manifest. A live leased session is followed but never migrated or taken over.
