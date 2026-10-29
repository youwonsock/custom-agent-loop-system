const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bindings(projectRoot) {
  const project = createRequire(path.join(projectRoot, "package.json"));
  const sdk = createRequire(project.resolve("@anthropic-ai/claude-agent-sdk"));
  const mcp = createRequire(sdk.resolve("@modelcontextprotocol/sdk/client"));
  const fastify = createRequire(project.resolve("fastify"));
  const consumers = [
    ["SDK/MCP/Ajv", createRequire(mcp.resolve("ajv"))],
    [
      "Fastify/Ajv compiler",
      createRequire(fastify.resolve("@fastify/ajv-compiler")),
    ],
    [
      "Fastify/JSON serializer",
      createRequire(fastify.resolve("fast-json-stringify")),
    ],
  ];
  const express = createRequire(mcp.resolve("express"));
  return {
    uris: consumers.map(([consumer, from]) => ({
      consumer,
      file: from.resolve("fast-uri"),
      version: from("fast-uri/package.json").version,
      uri: from("fast-uri"),
    })),
    bodyParser: {
      file: express.resolve("body-parser"),
      version: express("body-parser/package.json").version,
    },
  };
}

function checkUris(projectRoot) {
  return bindings(projectRoot).uris.map(({ consumer, file, version, uri }) => {
    const cannotBecome = (operation, unsafe, label) => {
      let result;
      try {
        result = operation();
      } catch (error) {
        assert.match(error.message, /malformed|invalid|scheme/i, label);
        return;
      }
      assert.notEqual(result, unsafe, label);
    };
    for (const encoded of [
      "%6Aavascript:alert(1)",
      "%u006Aavascript:alert(1)",
    ]) {
      assert.notEqual(
        uri.parse(encoded).scheme,
        "javascript",
        `${consumer}: encoded scheme`,
      );
      cannotBecome(
        () => uri.normalize(encoded),
        "javascript:alert(1)",
        `${consumer}: normalization`,
      );
      cannotBecome(
        () => uri.resolve("https://example.com/base/", encoded),
        "javascript:alert(1)",
        `${consumer}: resolution`,
      );
    }
    cannotBecome(
      () => uri.equal("%68ttp://example.com/", "http://example.com/"),
      true,
      `${consumer}: encoded equality`,
    );
    for (const ref of ["../x", "a/../b"]) {
      const base = "https://example.com/dir/document.json";
      assert.equal(
        uri.resolve(base, uri.normalize(ref)),
        uri.resolve(base, ref),
        `${consumer}: relative reference`,
      );
    }
    for (const raw of [
      "http://a@b@evil.example/",
      "http://go\tod.example/",
      "http://go\rod.example/",
      "http://go\nod.example/",
    ])
      assert.ok(
        uri.parse(raw).error,
        `${consumer}: invalid authority ${JSON.stringify(raw)}`,
      );
    const suffix = uri.serialize(
      { scheme: "custom", path: "javascript:alert(1)" },
      { reference: "suffix" },
    );
    assert.notEqual(
      uri.parse(suffix).scheme,
      "javascript",
      `${consumer}: suffix scheme injection`,
    );
    assert.equal(
      uri.resolve("https://example.com/dir/a.json", "../b.json"),
      "https://example.com/b.json",
    );
    assert.equal(uri.parse("http://127.0.0.1:4317/api").port, 4317);
    return { consumer, file, version, passed: true };
  });
}

function post(port, encoding, frame, trailing = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/payload",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(encoding ? { "Content-Encoding": encoding } : {}),
          "Content-Length": frame.length + trailing.length,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("HTTP probe timed out")));
    if (trailing.length) {
      req.write(frame);
      setTimeout(() => req.end(trailing), 30);
    } else req.end(frame);
  });
}

async function checkBodyParser(
  projectRoot,
  parser = bindings(projectRoot).bodyParser,
) {
  const { file, version } = parser;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "body-parser-server.cjs"), file],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
  );
  let stderr = "",
    port;
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-16000)));
  const exited = once(child, "exit");
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Body parser probe startup timed out")),
        5000,
      );
      child.once("message", (value) => {
        clearTimeout(timer);
        resolve(value.port);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Body parser probe exited (${code}): ${stderr}`));
      });
    });
    const payload = Buffer.from(JSON.stringify({ ok: true, value: 7 }));
    const plain = await post(port, null, payload);
    assert.equal(plain.status, 200);
    assert.deepEqual(JSON.parse(plain.body), { ok: true, value: 7 });
    const results = [];
    for (const [encoding, compress] of [
      ["gzip", zlib.gzipSync],
      ["deflate", zlib.deflateSync],
      ["br", zlib.brotliCompressSync],
    ]) {
      const frame = compress(payload);
      const valid = await post(port, encoding, frame);
      assert.equal(valid.status, 200);
      assert.deepEqual(JSON.parse(valid.body), { ok: true, value: 7 });
      // End the decoder first, then deliver more than a stream buffer of junk.
      const attack = await post(
        port,
        encoding,
        Buffer.concat([frame, Buffer.of(0)]),
        Buffer.alloc(192 * 1024, 0x5a),
      ).catch((error) => ({ requestError: error.message }));
      await delay(100);
      assert.equal(
        child.exitCode,
        null,
        `body-parser ${version} crashed on ${encoding}: ${stderr}`,
      );
      assert.equal(
        child.signalCode,
        null,
        `body-parser ${version} terminated on ${encoding}`,
      );
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(health.status, 200);
      assert.equal(await health.text(), "healthy");
      results.push({
        encoding,
        validStatus: valid.status,
        attack,
        healthyAfterAttack: true,
      });
    }
    return { file, version, pid: child.pid, port, results, passed: true };
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { checkUris, checkBodyParser };
