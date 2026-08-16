# Changelog

All notable changes to this project are documented here. Published versions are immutable; fixes are released under a new version.

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
