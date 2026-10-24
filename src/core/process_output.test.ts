import test from "node:test";
import assert from "node:assert/strict";
import { StreamingRedactor } from "./process_output";

test("complete unrelated records are emitted immediately even with a longer credential", () => {
  const redactor = new StreamingRedactor(["private-token-".repeat(100)]);
  const event = '{"type":"tool_use","error":"[AGENT_GRAPH_UNSCOPED_TERMINATION] blocked"}\n';
  assert.equal(redactor.push(event), event);
  assert.equal(redactor.flush(), "");
});

test("every chunk split masks overlapping and JSON-escaped credentials without discarding safe text", () => {
  const secrets = ["top-secret", "secret", 'quote"slash\\token', "aaa"];
  const text = 'safe top-secret quote\\"slash\\\\token aaa safe\n';
  const whole = new StreamingRedactor(secrets);
  const expected = whole.push(text) + whole.flush();
  assert.doesNotMatch(expected, /top-secret|quote|aaa/);
  for (let first = 0; first <= text.length; first++) {
    for (let second = first; second <= text.length; second++) {
      const redactor = new StreamingRedactor(secrets);
      assert.equal(redactor.push(text.slice(0, first)) + redactor.push(text.slice(first, second)) + redactor.push(text.slice(second)) + redactor.flush(), expected, `split ${first},${second}`);
    }
  }
});
