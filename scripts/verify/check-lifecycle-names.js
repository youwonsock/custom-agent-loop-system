#!/usr/bin/env node

/**
 * Keep first-party lifecycle and provider catalog names explicit. This check
 * walks syntax trees rather than grepping source text, so prose, diagnostics,
 * protocol strings, and dependency metadata do not create false positives.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const ignoredDirectories = new Set([
  ".git", "node_modules", "dist", "core", ".webpack", ".e2e", "out",
  "test-results", "coverage", "artifacts", ".spike-dist", ".tmp", "tmp",
]);
const ignoredFiles = new Set([
  "package-lock.json", "desktop-app/package-lock.json",
]);
const forbiddenExact = new Set([
  "fallbackModels", "profileFallbackModels", "usedFallback", "providerModelEntries",
]);

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(full));
    else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|cjs|mjs|json)$/u.test(entry.name) && !ignoredFiles.has(path.relative(root, full).replace(/\\/gu, "/"))) result.push(full);
  }
  return result;
}

function forbiddenName(name) {
  return forbiddenExact.has(name) || /fallback/iu.test(name) || /^ensure/iu.test(name) || /^initialize/iu.test(name) || /^cleanup/iu.test(name) || /IfNeeded$/u.test(name);
}

function stripNonCode(sourceText) {
  const blank = (value) => value.replace(/[^\r\n]/gu, " ");
  return sourceText
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/\/\/[^\r\n]*/gu, blank)
    .replace(/'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`/gsu, blank);
}

function checkSyntax(filePath, sourceText) {
  const source = stripNonCode(sourceText);
  const violations = [];
  const lines = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") lines.push(index + 1);
  const identifierPattern = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/gu;
  for (const match of source.matchAll(identifierPattern)) {
    const name = match[0];
    if (!forbiddenName(name)) continue;
    const offset = match.index ?? 0;
    let line = 0;
    while (line + 1 < lines.length && lines[line + 1] <= offset) line += 1;
    violations.push(`${path.relative(root, filePath)}:${line + 1}:${offset - lines[line] + 1} identifier '${name}'`);
  }
  return violations;
}

function checkJsonKeys(filePath, sourceText) {
  let value;
  try { value = JSON.parse(sourceText); }
  catch { return []; } // The canonical JSON check reports malformed documents.
  const violations = [];
  function visit(candidate, location) {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenName(key)) violations.push(`${path.relative(root, filePath)}:${location}.${key} JSON key '${key}'`);
      visit(child, `${location}.${key}`);
    }
  }
  visit(value, "$");
  return violations;
}

const violations = [];
for (const filePath of filesUnder(root)) {
  const relative = path.relative(root, filePath).replace(/\\/gu, "/");
  // Documentation and generated lock metadata are intentionally outside the
  // first-party identifier contract.
  if (relative.startsWith("docs/") || relative.endsWith(".md") || relative === "scripts/verify/check-lifecycle-names.js") continue;
  const sourceText = fs.readFileSync(filePath, "utf8");
  if (filePath.endsWith(".json")) violations.push(...checkJsonKeys(filePath, sourceText));
  else violations.push(...checkSyntax(filePath, sourceText));
}
if (violations.length > 0) {
  process.stderr.write(`Forbidden lifecycle/catalog names detected:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Lifecycle/catalog naming check passed.\n");
}
