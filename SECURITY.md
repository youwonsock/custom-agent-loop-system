# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through the repository's [private security advisory form](https://github.com/youwonsock/Custom_AgentLoopSystem/security/advisories/new). Do not include exploit details, credentials, or sensitive logs in a public issue.

Include the affected version or commit, operating system, provider profile, access mode, minimal reproduction steps, and whether the issue requires a trusted workspace or full-access mode. Redact secrets and personal paths from diagnostics.

## Security boundary

The supported trust assumptions and known limitations are documented in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md). In particular, host-wide full-access child processes are not isolated from other files owned by the same OS user.

## Disclosure

Please allow time for validation, patch preparation, artifact verification, and coordinated disclosure. A public advisory should identify affected versions, prerequisites, the fixed version, and artifact checksums without exposing active users before a fix is available.

## Release security gates

High-severity production dependency audits, generated-file drift checks, and packaged Electron smoke tests are fail-closed release gates. A registry or audit-service outage may be handled only by rerunning the bounded CI job after service recovery; it must not be bypassed or reclassified as a successful scan. Lockfile changes require a fresh audit. The Windows portable desktop bundle is built once on Node 22.20 and reverified unchanged before promotion; the packaged artifact, rather than only the source tree, is the release subject.
