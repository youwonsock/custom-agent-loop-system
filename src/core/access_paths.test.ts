import * as fs from "node:fs/promises";
import * as os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { isWithin, outsidePaths } from "./access_paths";
import { inside } from "./verification_sources";

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
test("comment markers quoted in a plan are not filesystem paths", () => {
  const paths = (text: string) => outsidePaths(text, ["/workspace/game"]);
  for (const text of [
    '   slugify("Hello World!"); // → "hello-world"',
    "// a comment",
    "/// docs",
    "/** slugify text */ export function slugify",
    "/* note */",
  ])
    assert.deepEqual(paths(text), [], text);
  assert.deepEqual(paths("code(); // see /etc/passwd"), ["/etc/passwd"]);
  assert.equal(paths("Read //etc/passwd").length, 1);
  assert.equal(paths("FILE_ACCESS: //").length, 1);
  assert.equal(paths("List /*").length, 1);
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
test("containment treats the root, sibling prefixes and dot names correctly on both path styles", () => {
  const posix = (file: string) => isWithin("/work/game", file, path.posix);
  assert.ok(posix("/work/game"));
  assert.ok(posix("/work/game/a/b"));
  assert.ok(posix("/work/game/..hidden"));
  assert.ok(posix("/work/game/a/../b"));
  assert.ok(!posix("/work/game-other/a"));
  assert.ok(!posix("/work/game/../other"));
  assert.ok(!posix("/work"));
  assert.ok(isWithin("/", "/any/file", path.posix));
  const win = (file: string) => isWithin("C:\\work\\game", file, path.win32);
  assert.ok(win("C:\\work\\game\\a"));
  assert.ok(win("c:\\WORK\\game\\a"));
  assert.ok(!win("C:\\work\\game-other\\a"));
  assert.ok(!win("D:\\work\\game\\a"));
});
test("verification paths stay inside the target, including through symlinks", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "inside-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "game");
  await fs.mkdir(path.join(root, "..hidden"), { recursive: true });
  await fs.mkdir(path.join(base, "game-other"));
  assert.equal(await inside(root, "."), root);
  assert.equal(await inside(root, "..hidden"), path.join(root, "..hidden"));
  assert.equal(await inside(root, "new/dir", true), path.join(root, "new/dir"));
  await assert.rejects(inside(root, "../game-other"), /must stay/);
  await assert.rejects(
    inside(root, path.join(base, "game-other")),
    /must stay/,
  );
  if (process.platform === "win32") return;
  await fs.symlink(path.join(base, "game-other"), path.join(root, "link"));
  await assert.rejects(inside(root, "link"), /symlink leaves/);
  await assert.rejects(inside(root, "link/below", true), /symlink leaves/);
});
