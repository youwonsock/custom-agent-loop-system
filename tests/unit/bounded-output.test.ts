import assert from "node:assert/strict";
import test from "node:test";
import { StreamingRedactor, appendBounded } from "../../src/runtime/bounded-output";

test("shared streaming redaction masks secrets split across chunks", () => {
  const redactor = new StreamingRedactor(["credential-value"]);
  const first = redactor.push("prefix credential-");
  const second = redactor.push("value suffix");
  const result = first + second + redactor.flush();
  assert.equal(result, "prefix [REDACTED]****** suffix");
  assert.doesNotMatch(result, /credential-value/u);
});

test("shared bounded output never exceeds its UTF-8 byte limit", () => {
  const result = appendBounded("", "😀😀😀", 5);
  assert.ok(Buffer.byteLength(result.value, "utf8") <= 5);
  assert.equal(result.truncated, true);
});
