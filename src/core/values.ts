import { createHash } from "node:crypto";

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** The value as a plain object, or an empty one for anything else. */
export const obj = (v: unknown): Obj => (isObj(v) ? v : {});
export const sha = (v: string | Buffer): string =>
  createHash("sha256").update(v).digest("hex");
