#!/usr/bin/env node

import { main } from "../interfaces/cli/main";

export { main } from "../interfaces/cli/main";

const RUNNING_IN_UTILITY_PROCESS = process.env.AGENT_LOOP_UTILITY_PROCESS === "1";

if (require.main === module) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
      if (RUNNING_IN_UTILITY_PROCESS) setImmediate(() => process.exit(exitCode));
    },
    (error: unknown) => {
      console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      if (RUNNING_IN_UTILITY_PROCESS) setImmediate(() => process.exit(1));
    }
  );
}
