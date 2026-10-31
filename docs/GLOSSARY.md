# 용어와 제한값

코드를 수정하는 사람을 위한 사전이다. 저장 필드 이름은 호환성 때문에 바꾸지 않으므로, 화면 표현과 다를 수 있다.

## 용어

| 용어 | 뜻 | 저장 필드·코드 |
| --- | --- | --- |
| 그래프 | 역할 노드와 성공·실패 경로로 이루어진 실행 설계 | `AgentGraphDocument` |
| 세션 | 그래프 하나를 목표와 대상 프로젝트에 대해 실행한 기록 | `SessionState` |
| 방문 | 세션이 한 노드에 들어가 완료 판정까지 진행한 한 번 | `NodeVisit` |
| 시도(attempt) | 방문 안에서 CLI를 한 번 실행한 것 | `AttemptRecord` |
| 역할 | 노드의 실행 유형: 계획, 구현, 테스트, QA 검토, 최종 승인, 중단 분석 | `node.type` |
| 검증 역할 | 테스트, QA 검토, 최종 승인. 판정이 관측된 증거에 근거해야 한다 | `isVerifierRole` |
| 감사 역할 | QA 검토와 최종 승인. 기존 증거만 판단하고 검사를 실행하지 않는다 | `isAuditRole` |
| 읽기 전용 역할 | 계획, QA 검토, 최종 승인, 중단 분석 | `isReadOnly` |
| receipt | CLI 이벤트에서 관측한 명령과 종료 코드. 모델의 보고가 아니다 | `CommandReceipt` |
| 검증 계약 | 필수 검사와 보호 파일을 고정한 `.agent-graph/verification.json` | `verificationContract` |
| 보호 파일 | 계약 잠금 후 해시가 바뀌면 세션을 차단하는 파일 | `protectedFiles` |
| 고정 테스트 | 테스트 역할이 소스를 바꾸지 못하게 하는 정책 | `testSourceGuard` |
| 대상 범위 보호 | Kilo의 파일 도구를 대상 프로젝트로 제한 | `targetScopeGuard` |
| 프로그램 I/O 격리 | Kilo의 명령을 VM에서 실행 | `programIoGuard` |
| 재진입 지점 | 검증 실패 후 자동 수정이 돌아가는 노드 | `entrypoints.reentry` |
| 완료 복구 | 표준 시도가 끝난 뒤 보고만 보완하는 추가 시도 | `completion_recovery` |
| 자동 복구 | 무료로 확인된 모델만 받는, 시간을 두고 다시 시작하는 복구 | `automaticRecovery` |
| 정지(halt) | 방문 단위로 세션을 멈추는 내부 경로. [정지 경로](ARCHITECTURE.md#정지-경로) 참고 | `halt` |

## 세션 상태

| 상태 | 뜻 |
| --- | --- |
| `RUNNING` | 실행 중 |
| `RECOVERING` | 자동 복구 대기 중 |
| `WAITING_USER` | 사용자 판단이나 환경 조치가 필요함 |
| `PAUSED` | 예산 소진 등으로 멈춤. 수동 재개 가능 |
| `BLOCKED` | 안전 조건 위반이나 프로세스 종료 미확인으로 차단 |
| `STOPPED` | 사용자가 중지 |
| `SUCCESS` | 요구사항, 실제 테스트 증거, 최종 승인을 모두 확인 |
| `FAILED` | 예상하지 못한 오류 |

## 제한값

기본값은 `runtime_defaults.json`, 허용 범위는 `src/core/settings.ts`와 `src/core/graph.ts`가 기준이다. 자율 프리셋의 값은 `autonomousExecutionSettings`가 덮어쓴다.

| 값 | 기본 | 자율 프리셋 | 허용 범위 |
| --- | --- | --- | --- |
| `sessionTimeoutMs` | 3600000 | 같음 | 7일 이하 |
| `maxSessionAttempts` | 24 | 같음 | 10000 이하 |
| `maxIterations` | 20 | 10 | 1~1000 |
| `phaseTimeoutMs` | 900000 | 600000 | 양수 |
| `idleTimeoutMs` | 300000 | 같음 | `phaseTimeoutMs` 이하 |
| `toolTimeoutMs` | 600000 | 300000 | `phaseTimeoutMs` 이하 |
| `pollIntervalMs` | 1000 | 같음 | 검사하지 않음 |
| `transportTimeoutMs` | 120000 | 같음 | `phaseTimeoutMs` 이하 |
| `phaseRecoveryBudgetMs` | 2880000 | 1860000 | 모든 시도와 재시도 지연 이상 |
| `maxAgentAttempts` | 3 | 같음 | 1~10 |
| `maxCompletionRecoveryAttempts` | 1 | 같음 | 0~3 |
| `maxAutomaticRecoveryCycles` | 3 | 1 | 0~10 |
| `automaticRecoveryBackoffMs` | `[60000, 300000, 900000]` | `[15000]` | 양수 |
| `retryBackoffMs` | `[5000, 30000]` | 같음 | `maxAgentAttempts - 1`개 이상 |
| `terminationGraceMs` | 3000 | 같음 | 양수 |
| `killTimeoutMs` | 5000 | 같음 | 양수 |
| `heartbeatIntervalMs` | 5000 | 같음 | `leaseTtlMs` 미만 |
| `leaseTtlMs` | 20000 | 같음 | 양수 |
| `maxInMemoryOutputBytes` | 1048576 | 같음 | 1KiB~16MiB |
| `maxRepairCycles` (그래프) | - | 5 | 1~20 |
| `optionsCount` (계획 선택지, 그래프) | 3 | 1 | 1~20 |
| 그래프 노드 수 | - | - | 250 이하 |
| 그래프 연결 수 | - | - | 500 이하 |

세션 시작 시 `iterationLimit`은 `maxIterations`이고 `visitLimit`은 `maxIterations × 노드 수 × 2`이다.
