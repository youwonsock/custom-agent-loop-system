# ADR 0007: Build once and promote verified artifacts

- Status: Accepted
- Date: 2026-08-16

## Context

Source tests do not prove that an npm tarball or VSIX contains the same code, dependencies, native
binary, or generated contracts. Rebuilding during publication also breaks the chain between test
evidence and released bytes. Native `node-pty` packaging makes this especially important across
Windows, Linux, macOS, architectures, and the minimum Node runtime.

## Decision

Treat npm and each native VSIX as immutable release candidates:

1. Build the npm tarball once and each native VSIX once in push CI.
2. Install or unpack those exact files and execute the bundled CLI, `ProcessSupervisor`, and native
   PTY lifecycle.
3. Reverify the npm tarball across Tier-1 operating systems on Node 18. Reverify each unchanged
   VSIX under Node 18 after its Node 20 verification.
4. Bind every artifact to SHA-256, a CycloneDX SBOM, a source-commit manifest, and a GitHub
   build-provenance attestation.
5. Require source, coverage, Extension Host, dependency-audit, package, and native matrix jobs in a
   single CI release gate.
6. Require the separate protected 24-report provider conformance matrix for the same commit.
7. Promotion downloads successful CI artifacts by run ID and publishes those bytes without
   rebuilding. It rejects missing targets, a different commit, invalid sidecars, failed reports,
   missing attestations, or an existing release.

Actions are referenced by immutable commit SHA with their reviewed major tag in a comment.
Dependabot remains responsible for proposing updates; a mutable tag can never change executable CI
code without review.

## Consequences

- Packaging defects and native ABI failures block before promotion.
- npm and VSIX publication have traceable, digest-bound evidence.
- CI is more expensive because exact artifacts run on multiple operating systems and Node versions.
- macOS x64 uses the explicitly selected Intel runner while available; changing Tier-1 targets is a
  reviewed release-policy change.
- Repository administrators must configure protected `provider-conformance` and `release`
  environments, provider secrets, and `NPM_TOKEN` when npm publication is enabled.
- Full-access remains an explicit unsafe mode until a separate OS identity or enforceable native
  deny boundary exists.
