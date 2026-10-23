import test from "node:test";
import assert from "node:assert/strict";
import { modelPricing } from "./model_pricing";
import { normalizeModels } from "./catalog";

test("only an explicit native free flag confirms free pricing; default zero rates do not", () => {
  const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  for (const model of [{}, { id: "vendor/auto/free", name: "Free" }, { cost }, { isFree: "true", cost }])
    assert.equal(modelPricing(model).status, "unknown");
  assert.equal(modelPricing({ isFree: true, cost }).status, "free");
  assert.equal(modelPricing({ isFree: true }).status, "free");
  assert.equal(modelPricing({ isFree: false, cost }).status, "paid");
});

test("nonzero prices override a free flag including cache and higher context tiers", () => {
  for (const cost of [
    { input: 0, output: 0.01 },
    { input: 0, output: 0, cache: { read: 0.1, write: 0 } },
    { input: 0, output: 0, context_over_200k: { input: "0.02", output: 0 } },
    [{ input: 0, output: 0 }, { tier: { type: "context", size: 200000 }, input: 0, output: 0.3 }],
  ]) assert.equal(modelPricing({ isFree: true, cost }).status, "paid");
  assert.equal(modelPricing({ isFree: true, cost: [{ tier: { type: "context", size: 200000 }, input: 0, output: 0 }] }).status, "free");
});

test("malformed or incomplete cost entries cannot confirm free; provider payloads are not retained", () => {
  for (const cost of [null, {}, [], { input: null, output: 0 }, { input: -1 }, { input: NaN }, { input: Infinity }, { input: "" }, { input: "unknown" }])
    assert.equal(modelPricing({ isFree: true, cost }).status, "unknown");
  const [model] = normalizeModels([{ id: "model", isFree: true, cost: { input: "0", output: "0e-6" }, secret: "DO_NOT_PERSIST" }], "provider");
  assert.equal(model!.pricing!.status, "free");
  assert.equal(model!.pricing!.source, "native_flag");
  assert.ok(Number.isFinite(Date.parse(model!.pricing!.checkedAt)));
  assert.ok(!JSON.stringify(model).includes("DO_NOT_PERSIST"));
});
