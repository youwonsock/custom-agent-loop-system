# Release and artifact promotion

The release pipeline promotes only artifacts that a successful push CI run already built and
tested. Promotion never runs a build, install, or package command.

## Tier-1 release targets

| Artifact | Build target | Exact-artifact verification |
|---|---|---|
| npm package | platform-neutral `.tgz`, built once on Ubuntu x64 | install, CLI, ProcessSupervisor, and native PTY on Windows x64, Linux x64, and macOS arm64 with Node 18 |
| VSIX | `win32-x64` | bundled core, ProcessSupervisor, and PTY on Node 20 and the same VSIX again on Node 18 |
| VSIX | `linux-x64` | bundled core, ProcessSupervisor, and PTY on Node 20 and the same VSIX again on Node 18 |
| VSIX | `darwin-arm64` | bundled core, ProcessSupervisor, and PTY on Node 20 and the same VSIX again on Node 18 |
| VSIX | `darwin-x64` | bundled core, ProcessSupervisor, and PTY on Node 20 and the same VSIX again on Node 18 |

Source tests run on Windows, Linux, and macOS. Core and extension coverage gates require at least
80% lines, 60% branches, and 70% functions. The real VS Code Extension Host suite runs separately
on Windows.

## Candidate contents

Every `.tgz` and `.vsix` has three mandatory sidecars:

- `.sha256`: digest of the exact candidate bytes;
- `.cdx.json`: CycloneDX SBOM whose application component binds that digest;
- `.manifest.json`: package/version, size, digest, source commit, and native target where relevant.

Successful push CI runs also create GitHub build-provenance attestations for each package file.
Third-party Actions are pinned to immutable commit SHAs; Dependabot opens reviewable SHA updates for
the `github-actions` ecosystem.

## Protected provider gate

Before tagging, run `Authenticated provider conformance` for the exact candidate commit through the
protected `provider-conformance` environment. All four pinned provider CLIs must pass write and
read-only (or the documented Codex fail-closed) checks on Windows, Linux, and macOS. This produces
24 reports. Promotion verifies the workflow commit and every report; it cannot substitute ordinary
CI evidence or omit a cell.

## Promotion

1. Ensure the package and extension versions equal the intended `vX.Y.Z` tag.
2. Ensure a successful **push** CI run exists for that commit and completed the `Protected release
   candidate gate`.
3. Complete the protected provider conformance workflow for the same commit.
4. Create the tag. Tag-triggered promotion discovers the successful runs, or invoke
   `Promote tested release artifacts` manually with both run IDs and the existing tag.
5. The protected `release` environment downloads only the `release-*` candidate artifacts,
   verifies five artifacts and all sidecars, checks their source commit and four VSIX targets,
   validates 24 provider reports, and verifies GitHub attestations.
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

cd vscode-extension
npm run coverage
npm run package
cd ..
npm run verify:vsix
npm run checksum:artifacts
$vsix = Get-ChildItem vscode-extension -Filter 'agent-loop-vscode-*-3.4.1.vsix' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
npm run verify:release-bundle -- $vsix.FullName
```

Local checks can validate the current OS artifact but cannot replace the protected multi-OS and
authenticated-provider gates.

## Full-access disclosure

`--full-access` is explicitly unsafe while providers run with the current OS user's privileges.
The CLI prints this limitation, and the extension requires a modal acknowledgment before enabling
the mode. Moving the mutable data root is not isolation; use a separate OS identity or enforceable
native deny boundary when host-level isolation is required.
