/** Platform-owned worker: stdout from authored tests never becomes result facts. */
import * as fs from "node:fs";
import { run } from "node:test";
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
function errors(
  value: unknown,
  depth = 0,
): Array<{ code: string; message: string }> {
  if (!value || depth > 5) return [];
  const v = obj(value);
  return [
    {
      code: String(v.code ?? v.name ?? "unknown"),
      message: String(v.message ?? "").slice(0, 1500),
    },
    ...errors(v.cause, depth + 1),
  ];
}
async function main(): Promise<void> {
  const [file, output] = process.argv.slice(2);
  if (!file || !output) throw Error("Node test worker arguments missing.");
  const cases: Obj[] = [];
  let summary: Obj | undefined;
  for await (const event of run({
    files: [file],
    concurrency: 1,
    timeout: 15000,
  })) {
    const data = event.data as unknown as Obj;
    if (
      (event.type === "test:pass" || event.type === "test:fail") &&
      obj(data.details).type !== "suite"
    ) {
      if (cases.length >= 1000)
        throw Error("Authored Node case limit exceeded.");
      cases.push({
        name: data.name,
        file: data.file,
        passed: event.type === "test:pass",
        skip: !!data.skip,
        todo: !!data.todo,
        errors: errors(obj(data.details).error),
      });
    }
    if (event.type === "test:summary" && !data.file)
      summary = { success: data.success, counts: data.counts };
    if (event.type === "test:stdout" || event.type === "test:stderr")
      process.stdout.write(String(data.message ?? ""));
  }
  fs.writeFileSync(
    output,
    JSON.stringify({ version: 1, summary, cases }) + "\n",
  );
  // Keep the process tree rooted until the parent terminates and verifies it.
  process.stdout.write("[AGENT_GRAPH_NODE_TESTS_DONE]\n");
  setInterval(() => {}, 1000);
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
