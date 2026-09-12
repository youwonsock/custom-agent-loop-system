export type CliOptions = Record<string, string>;

export function parseCliArgs(args: readonly string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const equalsIndex = key.indexOf("=");
    if (equalsIndex >= 0) {
      result[key.slice(0, equalsIndex)] = key.slice(equalsIndex + 1);
      continue;
    }
    if (index + 1 < args.length && !args[index + 1].startsWith("--")) {
      result[key] = args[++index];
    } else {
      result[key] = "true";
    }
  }
  return result;
}

export interface CliApplicationDependencies<TContext> {
  printUsage(): void;
  prepare(command: string, options: CliOptions): Promise<TContext>;
  handlers: Record<
    string,
    (options: CliOptions, context: TContext) => Promise<void>
  >;
  reportUnknown(command: string): void;
}

export async function runCliApplication<TContext>(
  args: readonly string[],
  dependencies: CliApplicationDependencies<TContext>
): Promise<number> {
  if (args.length === 0) {
    dependencies.printUsage();
    return 1;
  }

  const command = args[0];
  if (command === "--help" || command === "-h") {
    dependencies.printUsage();
    return 0;
  }

  const options = parseCliArgs(args.slice(1));
  const context = await dependencies.prepare(command, options);
  const handler = dependencies.handlers[command];
  if (!handler) {
    dependencies.reportUnknown(command);
    dependencies.printUsage();
    return 1;
  }
  await handler(options, context);
  return 0;
}

