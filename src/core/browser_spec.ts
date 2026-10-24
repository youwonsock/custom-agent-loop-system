export type Step = {
  id: string;
  type: string;
  selector?: string;
  container?: string;
  name?: string;
  key?: string;
  direction?: string;
  width?: number;
  height?: number;
  equals?: string | number;
  contains?: string;
  path?: string;
  status?: number;
};
export interface BrowserSpec {
  version: 1;
  server: { command: string[] };
  steps: Step[];
}
const types = [
  "viewport",
  "click",
  "press",
  "drag",
  "reload",
  "visible",
  "text",
  "count",
  "noOverflow",
  "within",
  "snapshot",
  "sameSnapshot",
  "differentSnapshot",
  "noConsoleErrors",
  "http",
];
export const checks = new Set([
  "visible",
  "text",
  "count",
  "noOverflow",
  "within",
  "sameSnapshot",
  "differentSnapshot",
  "noConsoleErrors",
  "http",
]);
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 4096;
export function validateBrowserSpec(value: unknown): BrowserSpec {
  const s = value as BrowserSpec;
  if (
    !s ||
    s.version !== 1 ||
    !Array.isArray(s.server?.command) ||
    !s.server.command.length ||
    s.server.command.length > 64 ||
    !s.server.command.every(string) ||
    !Array.isArray(s.steps) ||
    !s.steps.length ||
    s.steps.length > 100
  )
    throw new Error(
      "Browser spec requires version:1, server.command argv and 1–100 steps.",
    );
  const ids = new Set<string>();
  for (const step of s.steps) {
    if (
      !step ||
      !string(step.id) ||
      ids.has(step.id) ||
      !types.includes(step.type)
    )
      throw new Error("Browser steps need unique ids and supported types.");
    ids.add(step.id);
    if (
      [
        "click",
        "drag",
        "visible",
        "text",
        "count",
        "within",
        "snapshot",
        "sameSnapshot",
        "differentSnapshot",
      ].includes(step.type) &&
      !string(step.selector)
    )
      throw new Error(`${step.id}: selector required`);
    if (step.type === "within" && !string(step.container))
      throw new Error(`${step.id}: container required`);
    if (
      ["snapshot", "sameSnapshot", "differentSnapshot"].includes(step.type) &&
      !string(step.name)
    )
      throw new Error(`${step.id}: name required`);
    if (step.type === "press" && !string(step.key))
      throw new Error(`${step.id}: key required`);
    if (
      step.type === "viewport" &&
      ![step.width, step.height].every(
        (n) => Number.isInteger(n) && n! >= 240 && n! <= 4096,
      )
    )
      throw new Error(`${step.id}: viewport must be 240–4096`);
    if (
      step.type === "drag" &&
      !["up", "down", "left", "right"].includes(step.direction ?? "")
    )
      throw new Error(`${step.id}: direction required`);
    if (
      step.type === "count" &&
      (!Number.isInteger(step.equals) || Number(step.equals) < 1)
    )
      throw new Error(`${step.id}: positive count required`);
    if (
      step.type === "text" &&
      !(typeof step.equals === "string" || string(step.contains))
    )
      throw new Error(`${step.id}: equals or contains required`);
    if (
      step.type === "http" &&
      (!string(step.path) ||
        !step.path.startsWith("/") ||
        step.path.startsWith("//") ||
        /[\r\n]/.test(step.path) ||
        !Number.isInteger(step.status) ||
        step.status! < 100 ||
        step.status! > 599)
    )
      throw new Error(
        `${step.id}: local HTTP path and expected status required`,
      );
  }
  if (!s.steps.some((s) => checks.has(s.type)))
    throw new Error(
      "Browser spec must execute real assertions, not only actions/screenshots.",
    );
  return s;
}
