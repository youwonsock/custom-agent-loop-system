# Changelog

All notable changes to this project are documented here. Published versions are immutable; fixes are released under a new version.

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
