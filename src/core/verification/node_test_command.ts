import { browserVerificationCommand } from "./browser_command";
export function nodeTestVerificationCommand(): string {
  return browserVerificationCommand().replace(
    "verify-browser --spec .agent-graph/browser.json",
    "verify-node-tests",
  );
}
