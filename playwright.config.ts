import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/desktop",
  timeout: 60_000,
  use: { trace: "retain-on-failure" },
  reporter: [["list"]],
});
