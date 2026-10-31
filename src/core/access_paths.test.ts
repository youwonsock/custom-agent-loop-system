import test from "node:test";
import assert from "node:assert/strict";
import { outsidePaths } from "./access_paths";

test("web root document mappings do not request filesystem root access", () => {
  for (const text of [
    "Handle `/` -> index.html, static assets (css/js) with correct MIME types",
    "Serve / => index.html",
    'Map "/" → index.html',
    "HTTP GET / serves the game",
  ])
    assert.deepEqual(outsidePaths(text, ["/workspace/game"]), [], text);
});
test("route descriptions cannot conceal explicit or adjacent filesystem access", () => {
  for (const text of [
    "Inspect `/` to enumerate the filesystem",
    "FILE_ACCESS: /",
    "FILE_ACCESS: Handle `/` -> index.html",
    "Handle `/tmp/key` -> index.html",
    "Copy `/` -> index.html",
    "Handle `/` -> index.html; inspect `/`",
  ])
    assert.ok(outsidePaths(text, ["/workspace/game"]).length > 0, text);
  assert.deepEqual(
    outsidePaths("Handle `/` -> index.html; read `/etc/passwd`", [
      "/workspace/game",
    ]),
    ["/etc/passwd"],
  );
});
test("regex literals quoted in a plan are not filesystem paths", () => {
  for (const text of [
    "- slugify replaces /[^a-z0-9]+/g with one hyphen",
    "Assert the export exists with `/slugify\\(/`",
    'Uses text.replace(/-+/g, "-")',
    "Trim with `/^-+|-+$/g`",
    "Reject characters /[^/a-z]/ in names",
    "Use '/a b\\(c/' in the check",
    "text.split(/x/)",
    "value.replace(/foo/g, bar)",
  ])
    assert.deepEqual(outsidePaths(text, ["/workspace/game"]), [], text);
});
test("regex-shaped text cannot conceal a real path", () => {
  const paths = (text: string) => outsidePaths(text, ["/workspace/game"]);
  assert.deepEqual(paths("Read /foo/g"), ["/foo/g"]);
  assert.equal(paths("Read /secret/a(1)/").length, 1);
  assert.deepEqual(paths("Read /tmp/a+b/"), ["/tmp/a+b/"]);
  assert.equal(paths("Read /tmp(1)/key").length, 1);
  assert.deepEqual(paths("FILE_ACCESS: /a+b/"), ["/a+b/"]);
  assert.deepEqual(paths("text.replace(/etc/g, bar)"), ["/etc/g"]);
  assert.deepEqual(paths("text.replace(/etc/passwd, bar)"), ["/etc/passwd"]);
});
