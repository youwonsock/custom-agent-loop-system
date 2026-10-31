# 실행 구조

2026-10-30 기준. 사용자 기능과 조건은 [README](../README.md), [실행 조건](EXECUTION_CONDITIONS.md), [자율 실행](AUTONOMOUS_WORKFLOW.md)을 기준으로 한다. 이 문서는 코드를 수정하는 사람을 위한 내부 구조다.

## 프로세스

```mermaid
flowchart LR
  UI[web/src · React] <-->|REST · SSE| App[src/server/app.ts · Fastify]
  App --> Coord[coordinator.ts]
  Coord -->|fork · IPC| Worker[worker.ts]
  Worker --> Runtime[core/runtime.ts · GraphRuntime]
  Runtime --> Sup[process_supervisor.ts]
  Sup --> CLI[등록한 코딩 CLI]
  Runtime --> Store[(store.ts · 세션 파일)]
  App --> Store
```

세션마다 워커 프로세스 하나가 `GraphRuntime.run()`을 실행한다. 워커는 `owner.lock`/`lease.json`으로 세션을 소유하고, Stop·Interrupt는 파일 제어 큐(`resilience.ts`)로 전달된다. 상태는 저장할 때마다 `revision`이 증가하고 IPC로 서버에 전달된다.

## 방문 실행 (`GraphRuntime.execute`)

`run()`은 소유권 확보 후 `recoverStaleOwner`, `recheckModels`, `renewAutomaticRecovery`, `visitLoop` 순서로 진행한다. `visitLoop`는 현재 노드의 방문을 고르고(`openVisit`, `readyToExecute`) `execute(node, visit)`를 호출한다. 결과가 `completed`면 `applyCompletion`이 성공·실패 간선으로 이동하고, `stopped`면 세션이 이미 정지(또는 제어 요청 처리)된 것이다. 종단 노드에서는 `finishRun`이 성공 조건을 다시 확인한다.

| 단계 | 메서드 | 내용 |
| --- | --- | --- |
| 1 | `preflight` | CLI 호출 없이 판정되는 게이트: 검토·승인의 테스트 소스 snapshot, 검증 계약 잠금, runner, 필수 파일, 자동화 테스트 역할의 소스 해시 |
| 2 | `stage` | 바인딩·연결·`runPolicy`·마감·attempt 한도를 고정한 `Stage` |
| 3 | `attemptGuards` | 매 호출 전 제어 요청, 계약 변조, 세션·단계 예산 |
| 4 | `invocationOptions` → `buildInvocation` | 프롬프트(`prompt_sections.ts`)와 CLI별 인자·환경(`invocation_codex`·`_claude`·`_run_cli`·`_kilo`) |
| 5 | `newAttempt` | attempt 기록 생성·저장 |
| 6 | `supervise` | `ProcessSupervisor` 실행(자식 하나의 출력 해석·증거·타이머는 `SupervisedAttempt`). 가드 콜백이 `AttemptRun.policyReason`/`sourceChanges`에 기록 |
| 7 | `recordOutcome` | 증거(명령 receipt, 읽은 파일, 감사, 파일 변경)를 attempt·방문에 반영 |
| 8 | `evidenceGates` | 고아 프로세스, VM·범위 감사, 고정 테스트의 소스 변경, 예산, 보호 파일, 단계 예산, 해시 비교, 승인 전 소스 재검사 |
| 9 | `judge` | 자체 Node 증명, `validateCompletion`, 필수 파일, 자율 계획의 외부 경로, 환경 차단 |
| 10 | `failure` + 재시도 | 실패 분류, 비재시도·할당량 정지, 재시도·재접속·완료 복구 |

`evidenceGates`와 `judge`는 `undecided`이면 다음 단계로 진행한다.

`validateCompletion`은 역할 판정을 순서가 있는 게이트 목록(`GATES`)으로 실행하며, 앞선 게이트가 걸러 낸 조건을 뒤의 게이트가 전제로 삼으므로 순서를 바꾸지 않는다.

## 정지 경로

`GraphRuntime`에서 세션 상태는 `settle(status, reason)`에서만 쓴다. 방문 단위 정지는 `halt(visit, status, reason, { pauseVisit, clearRecovery })`로 하며 부수효과를 호출부에서 명시한다. 같은 상태라도 경로마다 다르므로 통일하지 않는다.

| 경로 | 상태 | 방문 pause | 예약 복구 취소 |
| --- | --- | --- | --- |
| 테스트 전 소스 읽기 실패 | WAITING_USER | ✅ | ❌ |
| 실행 어댑터 사용 불가 (`IO_UNAVAILABLE`) | BLOCKED | ✅ | ❌ |
| 고아 프로세스 (supervisor) | BLOCKED | ✅ | ❌ |
| VM 실행 증거 불완전 | BLOCKED | ✅ | ✅ |
| 대상 밖 native 조회 | BLOCKED | ✅ | ✅ |
| 보호 검증 파일 쓰기 | BLOCKED | ✅ | ✅ |
| 고정 테스트의 환경 제약 | WAITING_USER | ✅ | ✅ |
| 고정 테스트의 인증·권한·모델 오류 | WAITING_USER | ✅ | ❌ |
| 완료 응답의 환경 차단 | WAITING_USER | ✅ | ✅ |
| 비재시도 실패 | WAITING_USER | ✅ | ❌ |
| 유료·미확인 모델의 할당량 소진 | PAUSED | ✅ | ❌ |

예산(`budgetStop`), 단계 예산(`stageStop`), 계약 변조(`contractStop`), 소진(`exhausted`)은 별도 메서드가 처리한다. `run()` 시작 시 예약 복구는 이미 비워지므로 "취소 ❌"는 실행 중 새로 예약된 복구가 없다는 뜻이다.

## 실행 정책 (`run_policy.ts`)

그래프의 `automation` 플래그와 노드에 연결된 CLI 종류로 정해지는 결정이다. 편집기와 그래프 검증은 원래 플래그를 그대로 사용한다.

| 결정 | 조건 |
| --- | --- |
| `localHttpAccess` | Codex + `browserVerification` |
| `kiloScopeGuard` | Kilo + `targetScopeGuard` |
| `kiloProgramIo` | Kilo + `programIoGuard` |
| 나머지 | 같은 이름의 그래프 플래그 |

## 동작 고정 테스트

| 테스트 | 고정 대상 |
| --- | --- |
| `process_supervisor_characterization.test.ts` | 감독기의 시작 실패, 제어 요청, 정책 정지, 프롬프트 자동 응답, 원시 로그 제한 |
| `prompt_golden.test.ts` | 역할·자동화 조합별 노드 프롬프트와 복구 메시지 전문 |
| `invocation_golden.test.ts` | CLI·역할·옵션별 인자, 앱이 바꾼 환경 변수, transport (`win32`/`posix`). 프로그램 I/O 분기는 `prepareProgramIo`만 대체해 VM 없이 posix에서 비교 |
| `shell_judgment.test.ts` | 같은 셸 명령을 단어 분리·조회 분할·검사 키·검증 명령·파일 변경 판정이 각각 어떻게 보는지 |
| `runtime_characterization.test.ts` | 기존 시나리오가 닿지 않던 정지 경로의 전체 세션 상태 |
| `app_workflow`·`app_recovery`·`app_autonomy`·`app_contracts.test.ts` | 서버·워커·가짜 CLI를 사용한 시나리오 (기본 흐름·승인 / 재시도·복구·수명 / 자율 실행·범위 / 검증 계약·예산). 공통 서버 준비는 `app_harness.test.ts` |
| `run_policy.test.ts`, `isolation.test.ts` | 플래그·CLI 조합 결정과 격리 안내 |

VM 격리 동작은 `npm run verify:vm`이 macOS에서 확인한다. CI는 VM 런타임을 준비하지 않으므로 해당 테스트 4개를 건너뛴다. 실제 CLI 회귀는 모델 사용량이 들어 `scripts/real-cli-regression.js`로 따로 실행한다.

V8 커버리지는 워커 프로세스 코드를 적게 집계한다. 경로 도달 여부는 빌드 산출물에 probe를 넣어 확인한다.
