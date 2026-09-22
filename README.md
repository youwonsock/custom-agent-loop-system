# Custom Agent Loop System

코딩 CLI를 PTY 자식 프로세스로 실행하고, 계획·구현·테스트·QA·최종 승인 역할이 하나의 목표를 상호 검증하도록 구성한 TypeScript 오케스트레이터입니다. CLI 코어와 독립 설치 가능한 VS Code 확장으로 구성됩니다.

## 주요 동작

- 기본 루프: `PLANNING → IMPLEMENTATION → TEST_GENERATION → VERIFICATION → MASTER_APPROVAL`
- 계획 단계는 정확히 3개 선택지를 만든 뒤 `WAITING_USER`에서 승인을 기다립니다.
- 원래 목표는 모든 단계의 최상위 계약으로 유지되며, 승인된 계획은 구현 전략으로만 취급됩니다.
- 목표에서 도출한 `REQ-###` 요구사항 원장을 세션에 고정하고 구현·테스트·QA·승인 단계가 각 항목의 증거를 제출하도록 요구합니다.
- 같은 미해결 요구사항으로 두 번째 완료 사이클까지 개선이 없으면 토큰 낭비 방지를 위해 `INTERRUPT → PAUSED`로 전환합니다.
- 인터넷 조사가 명시된 목표는 실제 검색 이벤트와 URL 근거가 있어야 통과합니다. 이름이 지정된 제품은 제목·제작자·제품 ID·공식 URL을 잠그고 서로 다른 출처 두 곳 이상으로 동일성을 검증합니다.

## 요구사항과 설치

- Node.js 18 이상
- 사용할 에이전트 CLI 중 하나 이상이 PATH에 설치되고 인증되어 있어야 합니다: OpenCode, Kilo Code, OpenAI Codex, Anthropic Claude Code
- 소스 빌드:

```powershell
npm install
npm run build
node dist/loop_orchestrator.js init
```

VS Code 확장은 플랫폼별 VSIX에 코어와 해당 플랫폼용 `node-pty` 바이너리를 포함합니다. 에이전트 CLI와 Node.js 자체는 포함하지 않습니다.

```powershell
cd vscode-extension
npm install
npm run package
code --install-extension agent-loop-vscode-win32-x64-3.4.0.vsix --force
```

확장의 기본 데이터 루트는 VS Code 전역 저장소입니다. 별도 코어 저장소를 지정하지 않아도 번들된 코어를 우선 실행합니다. `agentLoop.rootDir`은 데이터 루트를, `agentLoop.orchestratorScript`는 명시적인 외부 코어 진입점을 지정할 때만 사용하십시오.

## CLI

```powershell
node dist/loop_orchestrator.js run `
  --goal "구현 목표" `
  --target "C:\repo\project"

node dist/loop_orchestrator.js resume --session <session-id>
node dist/loop_orchestrator.js resume --session <session-id> --approve-access
node dist/loop_orchestrator.js resume --session <session-id> --full-access
node dist/loop_orchestrator.js models
```

기본 접근 모드는 `ask`입니다. 구현 계획이 대상 프로젝트 밖의 절대 경로를 요구하면 에이전트를 시작하기 전에 구체적인 접근 요청을 만들고 `WAITING_USER`로 전환합니다. 사용자는 해당 요청만 승인하거나 세션 전체 접근을 허용할 수 있습니다. 읽기 전용 역할은 세션이 전체 접근이어도 공급자의 읽기 전용 샌드박스를 사용합니다.

## 상태와 복구 정책

| 상태 | 의미 | 자동 처리 |
|---|---|---|
| `RUNNING` | 유효한 owner/lease가 실행 중 | 중복 실행 차단 |
| `RECOVERING` | 토큰 사용 전의 일시적 transport 장애 | 1/5/15분 기본 backoff 후 재개 |
| `WAITING_USER` | 계획·권한·인증 등 사용자 결정 필요 | 자동 재개 안 함 |
| `PAUSED` | 토큰을 사용했지만 반복 작업이 수렴하지 않음 | 수동 Resume만 새 복구 사이클 부여 |
| `STOPPED` | 명시적 Stop 또는 정상 확장 종료 | 자동 재개 안 함 |
| `BLOCKED` | 자식 종료나 소유권 안전을 확인할 수 없음 | 새 에이전트 시작 금지 |

기본 watchdog은 최초 transport 2분, 모델 무진행 5분, 실행 중 도구 무진행 10분, 진행 시 갱신되는 attempt 15분입니다. 역할 전체 복구 예산은 48분이고 최대 3회 시도와 재시도 backoff를 포함합니다. 연결 실패는 확보한 CLI 세션으로 한 번 재연결한 뒤 새 세션을 사용합니다.

완료는 `exitCode === 0`과 assistant text의 독립 행 `[PHASE_DONE]`이 모두 있어야 합니다. 테스트는 마지막 `VERDICT: PASS|FAIL`, QA와 최종 승인은 마지막 `APPROVED|REJECTED`도 요구합니다. 프롬프트 echo, raw JSON 필드, tool 입력에 있는 문자열은 완료로 인정하지 않습니다.

`maxIterations`는 완료된 구현→검증 사이클 수를 제한합니다. 한도에 도달하면 실패로 폐기하지 않고 비용 차단을 위해 `PAUSED`가 되며, 미해결 요구사항 또는 계획을 검토한 뒤에만 수동 Resume합니다.

## 보호장치

- 장기 `session_owner.lock`, 5초 heartbeat lease, 단기 상태/registry lock을 분리합니다.
- owner PID가 죽고 lease가 만료된 경우에만 stale 소유권을 원자적으로 인수합니다.
- 남은 PTY 부모·자식 PID를 bounded kill로 종료하고 사망을 확인하기 전에는 새 attempt를 시작하지 않습니다.
- Stop/Interrupt는 요청별 파일 큐로 저장해 동시 요청을 유실하지 않으며 Stop을 우선 처리합니다.
- 상태·registry는 임시 파일과 atomic rename으로 쓰고, 손상 registry는 잠금 안에서 격리 후 세션 디렉터리와 재조정합니다.
- 세션 삭제는 terminal 상태, lease/owner, 모든 자식 PID를 확인한 뒤 tombstone으로 원자 이동합니다.
- PTY 출력은 의미 있는 이벤트만 활동으로 인정합니다. ANSI, spinner, 공백, 반복 이벤트는 timeout을 연장하지 않습니다.
- 메모리는 attempt당 최근 1MiB ring으로 제한합니다. 정규화·redaction된 시도 로그는 파일당 8–32MiB, 최근 50개로 제한하며 history는 최근 250개와 항목당 최대 512KiB만 유지합니다.
- MCP 자격증명은 VS Code SecretStorage 또는 `${env:NAME}`/`${secret:key}` 참조로만 영속화합니다. 실행 시에만 메모리로 해석하고 인자·출력·로그에서 스트리밍 redaction합니다.
- `loop_config.json`의 상대 경로가 데이터 루트를 벗어나거나 timeout/heartbeat/복구 예산 관계가 잘못되면 시작 전에 실패합니다.

## 모델과 도구 설정

확장 Settings는 `Models`, `Roles & Stages`, `Tools` 화면으로 나뉩니다.

- Models: 설치되어 실행 가능한 에이전트 CLI만 공급자로 표시하고, 선택한 CLI가 발견한 모델만 해당 역할의 모델 목록에 표시합니다.
- Roles & Stages: 역할 지침, 단계 담당자, 성공·실패 전이와 시작·재진입 지점을 편집합니다. 역할/단계 ID를 바꾸면 연결된 참조도 함께 갱신됩니다.
- Tools: 모든 역할에 공통으로 적용되는 Web Search와 MCP 연결을 설정합니다.

Codex 모델은 인증된 `codex app-server`의 `model/list`를 페이지 끝까지 조회합니다. 동적 조회가 실패하거나 비어 있을 때만 설정된 fallback 모델을 표시합니다.

MCP 영속 설정 예시:

```json
{
  "environment": {
    "API_KEY": "${env:DOCS_API_KEY}"
  },
  "headers": {
    "Authorization": "${secret:agentLoop.mcp.docs.headers.authorization}"
  }
}
```

확장 UI에 직접 입력한 값은 SecretStorage로 옮겨지고 `loop_config.json`에는 참조만 남습니다.

## 제한적 파일 기반 루프 커스텀

시각적 그래프 편집기는 제공하지 않습니다. 새 세션에 적용할 역할과 루프는 다음 파일을 직접 수정할 수 있습니다.

- `agent_roles.json`: 역할 ID, 내장 `modelRole`, 추가 지침, 선택적 provider/model/variant
- `agent_loop.json`: stage type, stage, 성공/실패 전이, 시작·재진입·interrupt·iteration 완료 stage

`modelRole`과 executor는 감사된 enum에 한정되지만 역할 ID, stage type ID, stage ID는 스키마 범위에서 자유롭게 추가할 수 있습니다. 파일은 새 세션을 만들 때 검증·snapshot되므로 기존 세션은 바뀌지 않습니다.

- `agent_roles.schema.json`
- `agent_loop.schema.json`
- `loop_config.schema.json`

`agent-loop init`과 확장 최초 실행은 누락된 기본 역할·루프 파일을 생성합니다. 대체 파일은 CLI의 `--roles`, `--loop`로 지정할 수 있습니다.

## 개발과 검증

```powershell
npm run typecheck
npm test
npm run coverage
npm run smoke
npm run pack:check

cd vscode-extension
npm run typecheck
npm test
npm audit --audit-level=high
npm run package
```

CI는 Windows, Linux, macOS에서 코어 build/typecheck/test, 확장 typecheck/test, 플랫폼별 VSIX 생성과 번들 코어 smoke test를 수행합니다. 별도 Windows coverage job은 line 80%, branch 60%, function 70% 하한을 적용합니다.

### 실행 설정과 한도

- 새 세션의 역할별 모델·공급자·variant 선택은 설정 파일의 역할 기본값보다 우선합니다. 커스텀 역할도 `--model-mapping`, `--provider-mapping`, `--variant-mapping` JSON 옵션으로 지정할 수 있습니다. 빈 모델 값은 해당 공급자의 자동 선택, 빈 variant 값은 공급자 기본값입니다.
- 실행에 사용하는 최종 매핑과 파이프라인은 세션에 저장됩니다. 기존 세션의 **Session model assignments**는 읽기 전용이며 Resume은 저장된 설정을 사용합니다. 설정 변경은 새 세션에 적용됩니다.
- 원본 목표의 모든 요구사항과 전체 문장을 보존합니다. 증거 기록을 정리할 때도 각 요구사항의 최신 상태를 유지합니다. 기존의 잘린 요구사항은 재개 시 복원하고, 내용이 달라진 항목의 증거는 다시 검증합니다.
- 완료된 반복 횟수 외에도 전체 단계 실행을 `maxIterations × 단계 수 × 2`로 제한합니다. 단계 진입 전에 사용량을 저장하므로 검증 단계만 반복하거나 프로세스를 재시작해도 한도를 우회하지 못합니다. 한도 소진 시 `PAUSED`로 멈추며, 수동 Resume은 동일한 크기의 추가 예산을 부여합니다. 자동 복구는 이 예산을 늘리지 않습니다.
- 모든 단계는 `SUCCESS` 또는 `PAUSED`로 나갈 수 있는 경로가 있어야 합니다. 특정 결과만 반복되어 실제 종료 경로를 타지 않는 경우에는 전체 단계 한도가 작동합니다.

### 화면 동작

처음 열거나 세션이 없을 때 목표 입력 화면을 표시합니다. **New Session**으로 새 작업을 만들 수 있으며, 시작 요청이 실패하면 목표를 보존하고 오류를 표시합니다. 로그는 세션별로 분리하고, 이전 로그를 읽는 동안 자동으로 아래로 스크롤하지 않습니다. 계획 승인이 필요하면 **Review & Approve Plan**에서 해당 세션의 검토 화면을 엽니다. MCP의 환경 변수와 헤더는 문자열 값을 가진 JSON 객체만 저장할 수 있습니다.
