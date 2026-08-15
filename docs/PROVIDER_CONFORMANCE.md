# Provider capability conformance

Provider capability declarations are trusted only when the adapter profile and the authenticated
conformance evidence agree. Persisted configuration cannot elevate a profile: the core derives it
again from the adapter before every invocation.

## Protected matrix

The `Authenticated provider conformance` workflow is intentionally manual and uses the protected
`provider-conformance` GitHub environment. It runs OpenCode, Kilo, Codex, and Claude on Windows,
Linux, and macOS. Each job uses a pinned CLI version, a disposable workspace, and two checks:

The matrix uses Node.js 22 because the pinned Claude CLI requires it. This runner requirement is
independent of the packaged Agent Loop runtime, which is still tested and supported on Node.js 18.

1. A write-capable run must create the exact proof artifact and emit structured events.
2. A read-only run must leave a byte-hashed workspace unchanged. Codex must instead reject the
   request before spawn until an isolated configuration home is implemented and separately proven.

Every run also injects a random secret sentinel, asks the model to report it during the adversarial
read-only case, and scans arguments, output, diagnostics, logs, and the disposable workspace for
the exact value. The report never contains the sentinel. Unknown/destructive interactive prompts
remain fail-closed in `ProcessSupervisor`.

Required environment secrets are `OPENCODE_API_KEY`, `KILO_API_KEY`, `OPENAI_API_KEY`, and
`ANTHROPIC_API_KEY`. Promotion requires all 12 provider/OS jobs and both modes to pass. Reports are
uploaded as immutable workflow artifacts and must refer to the exact candidate commit.

For an already authenticated local CLI, one matrix cell can be run with:

```text
npm run conformance:provider -- --provider opencode --model opencode/big-pickle --mode read-only
```

The pinned install commands follow the providers' primary installation documentation:
[OpenCode](https://opencode.ai/docs),
[Kilo](https://kilo.ai/docs/code-with-ai/platforms/cli),
[Codex](https://github.com/openai/codex), and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started).

The ordinary CI suite tests adapter construction, capability preflight, side-effect filtering,
secret redaction, slow-log backpressure, finalization failure, prompt denial, and descendant
containment without credentials or model charges. It does not substitute for this protected matrix.
