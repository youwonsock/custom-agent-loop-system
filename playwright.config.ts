import { defineConfig } from "@playwright/test";
import * as path from "node:path";
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4379",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node dist/src/server/cli.js ui --root ${path.resolve("artifacts/e2e-workspace")} --port 4379 --no-open`,
    url: "http://127.0.0.1:4379/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  reporter: "list",
});
