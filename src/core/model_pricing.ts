import { ModelPricing } from "../shared/domain";

/** Only native metadata is accepted here; a model name or missing rate is not a quote. */
export function modelPricing(
  model: Record<string, unknown> = {},
  checkedAt = new Date().toISOString(),
): ModelPricing {
  let positive = false, invalid = false;
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 5) { invalid = true; return; }
    if (Array.isArray(value)) {
      if (!value.length || value.length > 32) { invalid = true; return; }
      value.forEach(v => inspect(v, depth + 1));
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (!entries.length || entries.length > 32) { invalid = true; return; }
      for (const [key, rate] of entries) {
        // Native tier descriptors contain context sizes, not monetary rates.
        if (key !== "tier") inspect(rate, depth + 1);
      }
    } else {
      const rate = typeof value === "number" ? value :
        typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
          ? Number(value) : NaN;
      if (!Number.isFinite(rate) || rate < 0) invalid = true;
      else if (rate > 0) positive = true;
    }
  };
  if (model.cost !== undefined) inspect(model.cost);
  if (positive)
    return { status: "paid", source: "native_cost", checkedAt,
      reason: "네이티브 모델 목록에 0보다 큰 비용이 보고되었습니다." };
  if (model.isFree === false)
    return { status: "paid", source: "native_flag", checkedAt,
      reason: "공급자가 무료 모델이 아니라고 보고했습니다." };
  if (model.isFree === true && !invalid)
    return { status: "free", source: "native_flag", checkedAt,
      reason: "공급자가 isFree=true로 보고했습니다. 실제 청구액 보장은 아닙니다." };
  return { status: "unknown", source: "unavailable", checkedAt,
    reason: invalid ? "비용 정보가 잘못되어 무료 여부를 확인할 수 없습니다." :
      "명시적인 무료 정보가 없습니다. 누락되거나 기본값으로 채워진 0은 무료 근거가 아닙니다." };
}
