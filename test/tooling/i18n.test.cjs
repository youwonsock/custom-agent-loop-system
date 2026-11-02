const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../web/src");
const english = JSON.parse(
  fs.readFileSync(path.join(root, "i18n/en.json"), "utf8"),
);
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

test("every text the screens translate has an English entry", () => {
  const missing = new Set();
  for (const file of sources(root))
    for (const [, literal] of fs
      .readFileSync(file, "utf8")
      .matchAll(/\bt\(\s*("(?:[^"\\\n]|\\.)*")/g)) {
      const key = JSON.parse(literal).trim();
      if (key && !english[key]) missing.add(key);
    }
  assert.deepEqual([...missing], []);
});

test("no screen shows Korean text outside the translation call", () => {
  const raw = [];
  for (const file of sources(root)) {
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        const outside = line
          .replace(/\bt\(\s*"(?:[^"\\]|\\.)*"/g, "")
          .replace(/\/\/.*$/, "");
        // A language's own name stays in that language.
        if (
          /[가-힣]/.test(outside.replace('"한국어"', "")) &&
          !/^\s*"(?:[^"\\]|\\.)*",?$/.test(line)
        )
          raw.push(`${path.basename(file)}:${i + 1}`);
      });
  }
  assert.deepEqual(raw, []);
});
