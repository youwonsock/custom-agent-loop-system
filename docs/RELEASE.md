# Release and artifact promotion (8.0.0)

The release pipeline promotes only artifacts that a successful push CI run already built and
tested. Promotion never runs a build, install, or package command.

## Tier-1 release targets

| Artifact | Build target | Exact-artifact verification |
|---|---|---|
| npm package | platform-neutral `.tgz`, built once on Ubuntu x64 | install, CLI, ProcessSupervisor, and native PTY on Windows x64, Linux x64, and macOS arm64 with Node 18 |
| Windows desktop portable bundle | `win32-x64` | Electron 44 portable directory built once on Windows 2025 + Node 22.20, then checksum/SBOM/fuse/native smoke verified |

Source tests run on Windows, Linux, and macOS. Core coverage gates require at least 80% lines, 60%
branches, and 70% functions. Electron development and packaged smoke suites run on Windows.

## Candidate contents

Every `.tgz`, desktop portable directory, and release-only portable `.zip` archive has three mandatory sidecars:

- `.sha256`: digest of the exact candidate bytes;
- `.cdx.json`: CycloneDX SBOM whose application component binds that digest;
- `.manifest.json`: package/version, size, digest, source commit, and native target where relevant.

Successful push CI runs also create GitHub build-provenance attestations for each package file.
Third-party Actions are pinned to immutable commit SHAs; Dependabot opens reviewable SHA updates for
the `github-actions` ecosystem.

## Protected provider gate

Before tagging, run `Authenticated provider conformance` for the exact candidate commit through the
protected `provider-conformance` environment. All four pinned provider CLIs must produce the complete
write/read-only/tools-none matrix on Windows, Linux, and macOS. This produces 36 reports. Verified
cells must pass authenticated execution with the exact version and capability key; the explicitly
fail-closed Codex tools-none cell is recorded as blocked and is never counted as an executed
tool-free proof. Promotion verifies the workflow commit and every report; it cannot substitute
ordinary CI evidence or omit a cell.

## Promotion

1. Ensure the package and desktop versions equal the intended `vX.Y.Z` tag.
2. Ensure a successful **push** CI run exists for that commit and completed the `Protected release
   candidate gate`.
3. Complete the protected provider conformance workflow for the same commit.
4. Create the tag. Tag-triggered promotion discovers the successful runs, or invoke
   `Promote tested release artifacts` manually with both run IDs and the existing tag.
5. The protected `release` environment downloads only the `release-*` candidate artifacts,
   verifies the npm and Windows portable artifacts and all sidecars, checks their source commit and
   the `win32-x64` target,
   validates 36 provider reports, and verifies GitHub attestations.
6. Promotion creates a draft GitHub release from those exact files. An optional manual gate may
   publish the downloaded `.tgz` to npm with provenance. The draft becomes public only after all
   selected publication steps succeed.

The workflow refuses to overwrite an existing release. A failed npm publication leaves a
recoverable draft rather than a partially advertised public release.

## Local verification

```powershell
npm run typecheck
npm test
npm run coverage
npm run pack:check
npm run verify:release-bundle -- artifacts/npm
npm run bundle:desktop-core
npm --prefix desktop-app ci
npm --prefix desktop-app run package:portable
node scripts/package/package-desktop-artifact.js
npm run verify:desktop
npm run verify:release-bundle -- artifacts
```

Local checks can validate the current OS artifact but cannot replace the protected multi-OS and
authenticated-provider gates.

For live candidate validation, run the `agent-loop-orchestrator.exe` inside the portable directory built
from the same candidate commit as the core. Do not let two release builds share recovery ownership of one
mutable session root.

## Full-access disclosure

`--full-access` is explicitly unsafe while providers run with the current OS user's privileges.
The CLI prints this limitation, and the desktop app requires a native modal acknowledgment before
enabling the mode. Moving the mutable data root is not isolation; use a separate OS identity or
enforceable native deny boundary when host-level isolation is required.
