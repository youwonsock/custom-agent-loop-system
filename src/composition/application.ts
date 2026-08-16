import * as path from "node:path";
import { DefaultAgentTaskRunner } from "../application/agent-task-runner";
import { CommandService } from "../application/command-service";
import { PromptComposer } from "../application/prompt-composer";
import { RecoveryService } from "../application/recovery-service";
import { RunReducer } from "../application/run-reducer";
import { TaskInputAssembler } from "../application/task-input-assembler";
import { TransitionRouter } from "../application/transition-router";
import { WorkflowRunner } from "../application/workflow-runner";
import { createDefaultDefinitionRegistries } from "../definitions/default-registries";
import { FileArtifactStore } from "../infrastructure/file-artifact-store";
import { FileRunControlRepository } from "../infrastructure/file-run-control-repository";
import { FileRunRepository } from "../infrastructure/file-run-repository";
import { FileRunProjection } from "../interfaces/vscode/run-projection";
import { SupervisedAgentRuntime } from "../runtime/supervised-agent-runtime";
import type { LoopConfig } from "../../runtime_config";

export interface ApplicationCompositionOptions {
  dataRoot: string;
  runId: string;
  config: LoopConfig;
  secretValues?: Readonly<Record<string, string>>;
  onChildPid?: (pid: number | null) => void;
}

export function composeApplication(options: ApplicationCompositionOptions): {
  repository: FileRunRepository;
  runner: WorkflowRunner;
  commands: CommandService;
  recovery: RecoveryService;
  projection: FileRunProjection;
} {
  const runsRoot = path.resolve(options.dataRoot, options.config.paths.sessionsRoot);
  const runDirectory = path.join(runsRoot, options.runId);
  const repository = new FileRunRepository({ runsRoot });
  const controls = new FileRunControlRepository(
    runsRoot,
    options.config.paths.controlDirName
  );
  const artifacts = new FileArtifactStore(path.join(runDirectory, "artifacts"));
  const projection = new FileRunProjection(
    {
      runsRoot,
      indexPath: path.resolve(options.dataRoot, options.config.paths.sessionsIndexFileName),
      projectionFileName: options.config.paths.sessionFileNames.state,
      progressFileName: options.config.paths.sessionFileNames.progressNotes,
      finalSummaryFileName: options.config.paths.sessionFileNames.finalSummary,
      indexLockFileName: options.config.paths.registryLockFileName,
    },
    artifacts
  );
  const registries = createDefaultDefinitionRegistries();
  const assembler = new TaskInputAssembler(artifacts, registries.schemas);
  const runtime = new SupervisedAgentRuntime({
    providers: options.config.providers,
    toolAccess: options.config.toolAccess,
    defaults: options.config.defaults,
    destructivePrompts: options.config.destructivePrompts,
    runDataRoot: runsRoot,
    secretValues: options.secretValues,
    controls,
    onChildPid: options.onChildPid,
  });
  const taskRunner = new DefaultAgentTaskRunner(
    runtime,
    artifacts,
    assembler,
    new PromptComposer(),
    registries
  );
  const reducer = new RunReducer();
  const runner = new WorkflowRunner(
    repository,
    reducer,
    new TransitionRouter(),
    taskRunner,
    assembler,
    projection,
    undefined,
    undefined,
    controls
  );
  return {
    repository,
    runner,
    commands: new CommandService(repository, reducer, projection, controls),
    recovery: new RecoveryService(repository, reducer, projection),
    projection,
  };
}
