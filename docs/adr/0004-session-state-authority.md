# ADR 0004: Session state authority

- Status: Accepted
- Date: 2026-08-08

## Decision

The per-session aggregate is the only logical authority. Its physical representation is the highest valid revision from an atomic state snapshot and a bounded recovery WAL.

- `sessions_index.json` is a rebuildable projection.
- Provider discovery results are a separate cache.
- Manual model/provider choices belong to trusted configuration.
- Plans and other large artifacts are immutable blobs referenced by hash from the aggregate.

Every commit validates the expected revision and owner fencing epoch. The active fenced core owns online writes. The extension submits control requests while an owner is active and uses the same repository transaction API for permitted offline changes.

The recovery WAL stores complete durable state records, not semantic events, heartbeats, output chunks, or polling activity. It exists for bounded crash recovery rather than general event sourcing.

Registry corruption is repaired from session aggregates. Corrupt aggregate data is quarantined and marked blocked; it is never replaced silently with an empty state.
