"use strict";
// Proves a formatting-only change: every TS/JS file must parse to the same
// syntax tree before (git revision) and after (working tree), ignoring
// positions, comments, quote style, redundant parentheses and JSX whitespace.
// Usage: node scripts/check-format-ast.js <git-revision>
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { parsers } = require("prettier/plugins/typescript");

const revision = process.argv[2];
if (!revision)
  throw new Error("Usage: node scripts/check-format-ast.js <git-revision>");
const files = execFileSync(
  "git",
  [
    "diff",
    "--name-only",
    revision,
    "--",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.cjs",
    "*.mjs",
  ],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean);

const ignored = new Set([
  "range",
  "loc",
  "start",
  "end",
  "raw",
  "comments",
  "tokens",
  "parent",
  "extra",
]);
const keyed = new Set([
  "Property",
  "PropertyDefinition",
  "MethodDefinition",
  "TSPropertySignature",
  "TSAbstractPropertyDefinition",
  "TSAbstractMethodDefinition",
]);
function normalize(node) {
  if (Array.isArray(node))
    return node
      .filter((child) => !(child?.type === "JSXText" && !child.value.trim()))
      .filter(
        (child) =>
          !(
            child?.type === "JSXExpressionContainer" &&
            child.expression?.type === "Literal" &&
            typeof child.expression.value === "string" &&
            !child.expression.value.trim()
          ),
      )
      .map(normalize);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node))
    if (!ignored.has(key) && !key.startsWith("__")) out[key] = normalize(value);
  // "a": 1 and a: 1 name the same property.
  if (keyed.has(node.type) && !node.computed && node.key?.type === "Literal")
    out.key = {
      type: "Identifier",
      name: String(node.key.value),
      decorators: [],
      optional: false,
      typeAnnotation: undefined,
    };
  if (node.type === "JSXText")
    out.value = node.value.replace(/\s+/g, " ").trim();
  if (node.type === "TemplateElement") out.value = node.value.cooked;
  return out;
}
async function shape(source, file) {
  return JSON.stringify(
    normalize(
      await parsers.typescript.parse(source, {
        filepath: file.replace(/\.(c|m)?js$/, ".tsx"),
      }),
    ),
  );
}

(async () => {
  let failed = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let before;
    try {
      before = execFileSync("git", ["show", `${revision}:${file}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      continue; // new file
    }
    const a = await shape(before, file),
      b = await shape(fs.readFileSync(file, "utf8"), file);
    if (a !== b) {
      failed++;
      const at = [...a].findIndex((c, i) => c !== b[i]);
      console.error(
        `${file}: syntax differs\n  before: …${a.slice(Math.max(0, at - 120), at + 120)}\n  after:  …${b.slice(Math.max(0, at - 120), at + 120)}`,
      );
    }
  }
  console.log(
    `${files.length - failed}/${files.length} changed source files are syntax-identical to ${revision}`,
  );
  process.exitCode = failed ? 1 : 0;
})();
