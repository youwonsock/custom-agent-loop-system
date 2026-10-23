import { FailureKind } from "./resilience";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const MAX_DIAGNOSTIC_MESSAGE_BYTES = 2048;
export interface CliDiagnostic {
  kind: FailureKind;
  message: string;
  code: string | null;
  statusCode: number | null;
}
export interface CliDiagnostics {
  terminalError: CliDiagnostic | null;
  plainError: CliDiagnostic | null;
}
export const emptyCliDiagnostics = (): CliDiagnostics => ({
  terminalError: null,
  plainError: null,
});

export function diagnosticMessage(value: string): string {
  for (const [key, secret] of Object.entries(process.env)) {
    if (
      /key|token|secret|password/i.test(key) &&
      secret &&
      secret.length >= 4
    ) {
      value = value.replaceAll(secret, "[REDACTED]");
      value = value.replaceAll(
        JSON.stringify(secret).slice(1, -1),
        "[REDACTED]",
      );
    }
  }
  value = value.replace(/\bsk-[A-Za-z0-9_-]+|Bearer\s+\S+/gi, "[REDACTED]");
  return Buffer.from(value)
    .subarray(0, MAX_DIAGNOSTIC_MESSAGE_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

// These phrases describe an actual failure, rather than a mention of auth, a
// model, a token count, or an HTTP-looking substring in an identifier.
function kindOf(
  code: string,
  status: number | null,
  message: string,
): FailureKind {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^Stopped after \d+ consecutive invalid-argument failures for the ".+" tool\./i.test(message))
    return "tool_arguments";
  if (
    /^(providerautherror|authenticationerror|authenticationfailed|authrequired|unauthenticated|unauthorized|invalidapikey|missingapikey|expiredtoken|notloggedin)$/.test(
      normalized,
    ) ||
    /\b(?:authentication (?:is )?(?:required|failed)|not authenticated|not logged in|login (?:is )?required|please (?:sign in|log in|login)|please run \/login|unauthenticated|unauthorized)\b/i.test(
      message,
    ) ||
    /\b(?:invalid|missing|expired|revoked|incorrect)\s+(?:(?:authentication|API)\s+)?(?:key|token|credentials?)\b|\b(?:API[ _-]?key|credentials?)\s+(?:is |are )?(?:required|missing|invalid|expired)\b/i.test(
      message,
    ) ||
    status === 401
  )
    return "auth";
  if (
    /^(forbidden|permissiondenied|permissiondeniederror|insufficientpermissions|accessdenied|oauthorgnotallowed)$/.test(
      normalized,
    ) ||
    status === 403
  )
    return "permission";
  if (
    /^(modelnotfound|modelnotfounderror|unknownmodel|unsupportedmodel)$/.test(
      normalized,
    ) ||
    /\b(?:unknown|unsupported) model\b|\bmodel\b[^\n]{0,100}\b(?:unavailable|not found|not supported)\b/i.test(
      message,
    )
  )
    return "model_unavailable";
  if (
    /^(quotaexceeded|insufficientquota|billingerror|creditsrequired|insufficientcredits|usagelimitreached)$/.test(normalized) ||
    status === 402 ||
    /\b(?:quota|credits?|credit balance|usage limit|spending limit) (?:is |are |has been )?(?:exceeded|exhausted|insufficient|reached|depleted|too low)\b|\b(?:insufficient|exhausted|depleted) (?:quota|credits?|credit balance)\b|\bexceeded (?:your |the )?(?:current )?quota\b|\b(?:hit|reached|exceeded) (?:your |the )?(?:usage|spending) limit\b/i.test(message)
  )
    return "quota_exhausted";
  if (
    /^(ratelimit|ratelimiterror|ratelimitexceeded)$/.test(
      normalized,
    ) ||
    status === 429 || status === 503 ||
    /\bproviders? (?:for this model )?.*\b(?:at capacity|overloaded)\b/i.test(message) ||
    /\brate[ _-]?limit(?:ed| exceeded)?\b/i.test(
      message,
    )
  )
    return "rate_limited";
  if (
    [499, 502, 504].includes(status ?? 0) ||
    /^(econnreset|econnrefused|enotfound|etimedout|networkerror|transporterror)$/.test(
      normalized,
    ) ||
    /\bECONN(?:RESET|REFUSED|ABORTED)\b|\b(?:network (?:error|connection)|connection (?:lost|reset|refused)|fetch failed|transport (?:error|failed))\b/i.test(
      message,
    )
  )
    return "network";
  return "process_exit";
}
export function cliDiagnostic(error: unknown): CliDiagnostic {
  const raw = object(error),
    data = object(raw.data),
    response = object(raw.response);
  const rawCode = raw.code ?? data.code ?? raw.name;
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode).slice(0, 100)
      : "";
  const message =
    string(raw.message) ||
    string(data.message) ||
    string(error) ||
    `CLI 실행 오류${code ? ` (${code})` : ""}`;
  const rawStatus =
    raw.statusCode ??
    raw.status ??
    data.statusCode ??
    data.status ??
    response.status ??
    (typeof rawCode === "number" && [401, 402, 403, 429].includes(rawCode)
      ? rawCode
      : null);
  const statusMatch = message.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:[ _-]?code)?)\s*[:=]?\s*(\d{3})\b/i,
  );
  const status =
    typeof rawStatus === "number"
      ? rawStatus
      : statusMatch
        ? Number(statusMatch[1])
        : null;
  return {
    kind: kindOf(code, status, message),
    message: diagnosticMessage(message),
    code: code ? diagnosticMessage(code) : null,
    statusCode: status,
  };
}
export class CliDiagnosticError extends Error {
  readonly diagnostic: CliDiagnostic;
  constructor(error: unknown) {
    const diagnostic = cliDiagnostic(error);
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

export class CliDiagnosticCollector {
  readonly diagnostics = emptyCliDiagnostics();
  private finalError(error: unknown): void {
    const next = cliDiagnostic(error),
      previous = this.diagnostics.terminalError;
    // A generic final wrapper must not erase an explicit provider failure.
    if (
      next.kind === "process_exit" &&
      previous &&
      previous.kind !== "process_exit"
    ) {
      next.kind = previous.kind;
      next.code = previous.code;
      next.statusCode = previous.statusCode;
      next.message = diagnosticMessage(`${previous.message}\n${next.message}`);
    }
    this.diagnostics.terminalError = next;
  }
  observeEvent(event: Obj): void {
    // Read only known execution-level error fields. Tool errors, embedded
    // documents and assistant text are deliberately not traversed.
    if (event.type === "error" || event.type === "turn.failed") {
      if (event.willRetry === true) return;
      this.finalError(event.error ?? event);
    } else if (event.type === "result") {
      if (
        event.is_error === true ||
        string(event.subtype).startsWith("error_")
      ) {
        const messages = Array.isArray(event.errors)
          ? event.errors
              .slice(0, 8)
              .filter((v) => typeof v === "string")
              .map((v) => diagnosticMessage(v as string))
          : [];
        this.finalError({
          code: event.error ?? event.subtype,
          message:
            messages.join("\n") ||
            string(event.result) ||
            "CLI가 실행 실패를 반환했습니다.",
        });
      } else if (event.subtype === "success" && event.is_error !== true) {
        this.diagnostics.terminalError = null;
      }
    } else if (
      event.type === "assistant" &&
      typeof event.error === "string" &&
      /^(authentication_failed|oauth_org_not_allowed|billing_error|rate_limit|overloaded|invalid_request|model_not_found|server_error|unknown|max_output_tokens)$/.test(
        event.error,
      )
    ) {
      this.finalError({
        code: event.error,
        message: `CLI 오류: ${event.error}`,
      });
    } else if (event.type === "turn.completed") {
      this.diagnostics.terminalError = null;
    }
  }
  observeLine(line: string): void {
    // Kilo's native logger writes logfmt alongside JSON events. Only ERROR
    // records are diagnostics; tool output and assistant text are not scanned.
    if (/^timestamp=\S+ level=ERROR\b/.test(line)) {
      const value = line.match(/\berror\.error=("(?:[^"\\]|\\.)*")/);
      if (value) {
        try { this.diagnostics.plainError = cliDiagnostic(JSON.parse(value[1]!)); } catch { /* keep raw log */ }
      }
      return;
    }
    if (/^(?:insufficient credits?\b|credit balance\b|(?:your )?(?:usage|spending) limit\b|you(?:'ve| have)? (?:hit|reached|exceeded) (?:your |the )?(?:usage|spending) limit\b)/i.test(line)) {
      this.diagnostics.plainError = cliDiagnostic(line);
      return;
    }
    if (
      !/^(?:\[[^\]\n]{1,40}\]\s*)?(?:error\b|fatal\b|authentication\b|not (?:authenticated|logged in)\b|login (?:is )?required\b|please (?:sign in|log in|login|run \/login)\b|unauthori[sz]ed\b|unauthenticated\b|(?:invalid|missing|expired|revoked) (?:API |authentication )?(?:key|token|credentials?)\b|API[ _-]?key\b|HTTP\b|temporary (?:network|connection)\b|network (?:error|connection)\b|connection (?:lost|reset|refused)\b|ECONN\w*\b|fetch failed\b|unknown model\b|model .*(?:not found|unavailable|not supported)|rate[ _-]?limit\b|quota .*(?:exceeded|exhausted))/i.test(
        line,
      )
    )
      return;
    this.diagnostics.plainError = cliDiagnostic(line);
  }
}
