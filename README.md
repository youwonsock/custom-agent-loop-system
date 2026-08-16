# Custom Agent Loop System

CrewAI의 Agent/Task 분리와 LangGraph의 State/Node/Edge/Reducer/Checkpoint 개념을 참고해,
외부 프레임워크 없이 구현한 TypeScript 작업 오케스트레이터입니다. 모든 모델 작업은 하나의
`AgentTaskRunner`를 통과하고, 코어가 검증한 구조화 결과만 워크플로를 전진시킵니다.

## 작업 흐름

```text
PLANNING
  → PLAN_APPROVAL
  → IMPLEMENTATION
  → TEST
  → QA_REVIEW
  → MASTER_APPROVAL
  → SUCCESS
```

- `Agent`는 역할, 목표, 기본 모델, 접근 권한과 도구 상한만 정의합니다.
- `Task`는 입력/결과 스키마, 허용 signal, guardrail, effect mapper, retry 정책을 정의합니다.
- `Workflow Node`가 Agent와 Task를 결합하고 명명된 입력과 단일 transition을 정의합니다.
- 계획 승인은 별도 human-gate node이므로 승인 재개 시 planning provider를 다시 실행하지 않습니다.
- 테스트 실패와 승인 거절은 실행 오류가 아니라 검증된 업무 signal로 처리됩니다.
- 반복 실행은 node ID가 아닌 activation ID로 기록되어 이전 출력이 덮어써지지 않습니다.

## 결과 계약

모든 모델 Task의 마지막 assistant 응답은 Markdown fence 없는 JSON 객체 하나여야 합니다.

```json
{
  "schemaVersion": 1,
  "signal": "success",
  "summary": "작업 요약",
  "requirementEvidence": [],
  "payload": {}
}
```

코어는 envelope, task별 payload schema, signal, guardrail을 순서대로 검증합니다. 형식 오류에는
도구를 모두 차단한 format-only recovery를 한 번만 허용합니다. 텍스트 완료 마커나 provider가
주장한 node/activation ID는 상태 변경 근거로 인정하지 않습니다.

## 설치와 실행

요구사항은 Node.js 18 이상과 PATH에서 실행 가능하고 인증된 provider CLI(OpenCode, Kilo,
Codex, Claude) 중 하나 이상입니다.

```powershell
npm install
npm run build
node dist/loop_orchestrator.js init

node dist/loop_orchestrator.js run `
  --goal "구현 목표" `
  --target "C:\repo\project"
```

주요 명령은 다음과 같습니다.

```powershell
node dist/loop_orchestrator.js status --session <run-id> --json
node dist/loop_orchestrator.js approve-plan --session <run-id> --choice-id <choice-id>
node dist/loop_orchestrator.js revise-plan --session <run-id> --message "수정 요청"
node dist/loop_orchestrator.js cancel-plan --session <run-id>
node dist/loop_orchestrator.js resume --session <run-id>
node dist/loop_orchestrator.js resume --session <run-id> --approve-access
node dist/loop_orchestrator.js resume --session <run-id> --full-access
node dist/loop_orchestrator.js set-access --session <run-id> --mode ask
node dist/loop_orchestrator.js interrupt --session <run-id> --message "중단 사유"
node dist/loop_orchestrator.js stop --session <run-id>
node dist/loop_orchestrator.js models
node dist/loop_orchestrator.js capabilities
```

`--full-access`는 현재 OS 사용자 권한으로 provider를 실행하는 명시적 비격리 모드입니다.
호스트 수준 격리가 필요하면 별도 OS 계정이나 강제 가능한 native sandbox를 사용해야 합니다.

## 정의 파일

`agent-loop init`은 config root에 다음 정의와 schema를 준비합니다.

- `agents.json` / `agents.schema.json`
- `tasks.json` / `tasks.schema.json`
- `workflow.json` / `workflow.schema.json`
- `loop_config.json` / `loop_config.schema.json`

정의는 run 생성 시 compile·검증한 뒤 `CompiledWorkflowBundle` 전체가 aggregate에 snapshot됩니다.
원본 파일을 변경해도 진행 중인 run은 바뀌지 않습니다. 이전 3.x 정의와 세션 데이터는 읽거나
migration하지 않습니다.

Compiler는 참조 무결성, signal 전이, 입력 선행 가능성, 접근 권한 확대, unreachable node,
terminal 없는 cycle, workflow-step을 소비하지 않는 cycle, 승인 gate 우회, 자동 경로 budget을
검사합니다.

## 상태와 복구

- `RunReducer`만 제한된 `DomainEffect`를 aggregate에 적용합니다.
- node 예약과 attempt 번호는 provider 시작 전에 CAS checkpoint로 저장됩니다.
- 결과, effect, transition, activation 완료는 하나의 revision으로 커밋됩니다.
- repository commit은 expected revision과 fencing epoch를 모두 검사합니다.
- provider 실행 후 mutation 결과가 불명확하면 activation을 `unknown_mutation`으로 표시하고 자동
  replay를 거부합니다.
- access approval은 현재 activation에 연결되며 승인 후 같은 activation에서 새 attempt로 재개됩니다.
- VS Code 확장은 versioned read-only projection만 읽고 aggregate를 직접 쓰지 않습니다.

상태는 `RUNNING`, `WAITING_USER`, `PAUSED`, `BLOCKED`, `STOPPED`, `SUCCESS`, `FAILED`를
사용합니다. workflow-step, cycle, node execution, artifact input, event 수는 compiled budget으로
제한됩니다.

## 모듈 경계

```text
src/
  domain/          순수 계약과 aggregate
  definitions/     loader, compiler, registry
  application/     runner, reducer, router, command/recovery service
  tasks/           schema, guardrail, effect mapper
  runtime/         provider 실행 adapter
  infrastructure/ repository, artifact, control queue
  interfaces/      CLI와 VS Code projection
  composition/     concrete 조립
```

`domain`은 외부 계층을 import하지 않고, runtime/infrastructure만 application port를 구현합니다.
구조 테스트가 금지된 import, 직접 aggregate writer, 구형 executor/텍스트 parser의 재도입을
차단합니다.

## VS Code 확장

```powershell
npm --prefix vscode-extension install
npm --prefix vscode-extension run package
code --install-extension vscode-extension\agent-loop-vscode-win32-x64-4.0.0.vsix --force
```

플랫폼별 VSIX에는 v4 코어와 해당 플랫폼의 `node-pty`가 포함됩니다. Extension Host는 코어
command protocol을 통해 승인·중단·재개를 요청하고 `run_projection.json`만 표시합니다.

## 개발 검증

```powershell
npm run typecheck
npm test
npm run generated:check
npm run pack:check
npm run evaluate:langgraph

npm --prefix vscode-extension run typecheck
npm --prefix vscode-extension test
npm --prefix vscode-extension run test:host
npm --prefix vscode-extension run package
```

LangGraph는 `experiments/langgraph`의 구조 비교 전용 private package에만 존재합니다. production
package와 VSIX에는 CrewAI/LangGraph dependency가 포함되지 않습니다. 결정 근거는
[ADR 0008](./docs/adr/0008-agent-task-graph-v4.md)에 기록되어 있습니다.
