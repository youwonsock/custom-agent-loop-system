import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { _electron as electron, test, expect } from "@playwright/test";

test("development desktop renders the operator console", async () => {
  // Keep the smoke test hermetic.  The desktop app deliberately refuses to
  // overwrite a partially initialized profile, so inheriting the developer's
  // real APPDATA would make a prior failed run poison every later run.
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-e2e-"));
  const appData = path.join(profileRoot, "roaming");
  const localAppData = path.join(profileRoot, "local");
  await Promise.all([fs.mkdir(appData, { recursive: true }), fs.mkdir(localAppData, { recursive: true })]);
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, "..", ".e2e", "main", "main.js")],
    env: {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      AGENT_LOOP_APP_DATA_ROOT: appData,
      AGENT_LOOP_LOCAL_DATA_ROOT: localAppData,
      ELECTRON_IS_DEV: "1",
      AGENT_LOOP_E2E: "1",
      AGENT_LOOP_APP_ROOT: path.resolve(__dirname, ".."),
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await expect(page).toHaveTitle("Agent Loop Orchestrator");
    await expect(page.getByRole("button", { name: /New Session/u })).toBeVisible();
  } finally {
    await electronApp.close();
    await fs.rm(profileRoot, { recursive: true, force: true });
  }
});
