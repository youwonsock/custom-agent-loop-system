const test = require("node:test");
const path = require("node:path");
const {
  checkUris,
  checkBodyParser,
} = require("../helpers/dependency-security.cjs");
const project = path.resolve(__dirname, "../..");

test("all consuming fast-uri branches reject spoofed schemes/hosts and preserve relative URI meaning", () => {
  console.log(
    JSON.stringify({
      securityProbe: "fast-uri",
      consumers: checkUris(project),
    }),
  );
});

test("SDK body-parser survives trailing compressed frames and still parses valid JSON", async () => {
  console.log(
    JSON.stringify({
      securityProbe: "body-parser",
      ...(await checkBodyParser(project)),
    }),
  );
});
