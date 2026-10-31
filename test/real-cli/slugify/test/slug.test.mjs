import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("slugify lowercases, joins with single hyphens and trims", async () => {
  const { slugify } = await import("../slug.mjs");
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Hello,   World!  "), "hello-world");
  assert.equal(slugify("--Already--Slugged--"), "already-slugged");
  assert.equal(slugify("Version 2.0"), "version-2-0");
  assert.equal(slugify("!!!"), "");
});

test("README documents slugify with a usage example", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /slugify\(/);
});
