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
