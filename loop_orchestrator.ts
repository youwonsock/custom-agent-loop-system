#!/usr/bin/env node

import { main } from "./src/interfaces/cli/main";

export { main } from "./src/interfaces/cli/main";

if (require.main === module) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}
