# Changelog

All notable changes to this project are documented here. Published versions are immutable; fixes are released under a new version.

## 7.0.0 - 2026-09-11

### Migration and contract boundary

- Promote the core and desktop product to 7.0.0 and require the strict-current-contracts handshake capability.
- Reset old session, registry, index, and loop-history runtime state through a fixed-target resumable journal;
  preserve settings, credentials, project sources, and working-tree changes.
- Remove superseded projection/snapshot readers, workflow schema 1/completion fallback, and VS Code/VSIX runtime paths.
- Add legacy-boundary, migration recovery, and installed-artifact checks to the release gates.

## 6.0.0 - 2026-09-07

### Reliability and verification

- Require a plan-approved verification contract and core-authored `verification_result.v1` proof
  before QA, final acceptance, and `SUCCESS`.
- Execute approved checks sequentially with durable command checkpoints, bounded logs, process-tree
  cleanup, workspace fingerprints, and fail-closed recovery for unknown outcomes.
- Carry verification failures, review findings, and plan feedback into the next cycle; add hashed
  same-session reapproval for verification policy, protected files, existing tests, and lockfiles.
- Add core convergence evaluation, project leases, tools-none format recovery, and journaled
  `upgrade --reset-sessions` handling for deleting old sessions while preserving configuration.

### Distribution

- Add the Windows x64 Job Object verification helper and package/desktop artifact gates that use the
  same helper build, checksums, SBOM, and provenance metadata.
- Move the operator console to the v6 projection and protocol contracts while retaining CLI operation.

## 5.0.0 - 2026-08-31

### Desktop application

- Replace the VS Code GUI with an independent Windows 10/11 x64 Electron operator console.
- Add tray-resident lifecycle, single-instance handling, native confirmation for Full Access/Delete/
  Stop & Quit, and utility-process core execution.
- Split roaming configuration and local session data roots and add fail-closed Windows safeStorage
  secret storage.
- Add shared operator projection contracts and bounded `agent-loop models --json` provider discovery.
- Publish npm runtime and unsigned Squirrel `Setup.exe` candidates with checksums, SBOM, manifest, and
  provenance metadata. Automatic updates are intentionally out of scope for v1.

## 4.0.0 - 2026-08-16

### Architecture

- Replace stage-specific executors with Agent, Task, Workflow, and one common `AgentTaskRunner`.
- Add compiled deterministic graph validation, activation-based aggregate state, reducer-owned effects,
  revision CAS, fencing, immutable artifacts, and explicit human gates.
- Require versioned JSON task envelopes and remove text completion markers and compatibility fallback.
- Snapshot every compiled workflow definition into its run and reject all pre-v4 state and definitions.

### Safety and integration

- Reserve mutation attempts before dispatch and prohibit automatic replay of unknown mutation outcomes.
- Route plan/access approval, Stop, Interrupt, and Resume through idempotent core commands.
- Convert VS Code to a read-only v4 projection consumer and remove its aggregate/WAL writers.
- Keep LangGraph in an isolated structure-comparison experiment; CrewAI and LangGraph are absent from
  production dependencies.

## 3.4.1 - 2026-08-08

### Security

- Gate VS Code process execution on Workspace Trust and restrict execution-bearing settings.
- Reject orchestration state placed inside an agent-writable project.
- Validate and contain control request, acknowledgement, session, and deletion paths.
- Fail closed when a provider cannot enforce a read-only role and stop automatically approving text prompts.
- Redact resolved MCP credentials and namespace VS Code SecretStorage entries by data/config identity.

### Reliability

- Make extension process start/stop failures visible and isolate output by session.
- Verify the bundled core and native PTY from the unpacked VSIX artifact.
- Add generated-file, Node compatibility, package checksum, SBOM, and supply-chain CI gates.

### Documentation

- Add a threat model, security reporting policy, architecture decisions, and a staged improvement roadmap.
