# 구현 검증 및 수정 기록

최신 기록만 둔다. 이전 기록은 [2026-10 이력](verification/2026-10-history.md)에 있다.

## 실행 엔진 구조 정리·안전망·Windows PATH 수정 — 2026-10-30

동작 고정 안전망을 먼저 추가했다. 노드 프롬프트 28종과 복구 메시지, CLI 4종의 실행 인자·앱이 바꾼 환경을 골든 파일로 고정했고(`test/golden/`, invocation은 win32/posix 계열별), 기존 시나리오가 닿지 않던 정지 경로 두 곳(`IO_UNAVAILABLE` 차단, testSourceGuard 없이 테스트 역할의 숨은 제품 변경을 해시로 반려)의 세션 상태 전체를 특성 테스트로 고정했다. V8 커버리지는 워커 프로세스 코드를 적게 집계해 해시 비교 분기를 미실행으로 보고했으며, 빌드 산출물에 probe를 넣은 전체 실행으로 실제 도달 여부를 다시 측정했다.

안전망 검토 중 Windows에서 부모 환경 변수 이름이 `Path`이면 CLI 자식에 `Path`(전체)와 `PATH`(node 폴더만)가 함께 전달되고 Codex 셸 PATH가 node 폴더로 고정되는 결함을 재현해 수정했다. 대소문자 표기 모두에 대한 회귀 테스트가 수정 전 실패·수정 후 통과하며, `PATH` 표기 환경의 골든은 변하지 않았다.

Prettier를 도입해 전체 소스를 포맷했다. `scripts/check-format-ast.js`로 변경된 TS/JS 128개 파일이 포맷 전과 같은 구문 트리임을 확인했고 포맷 커밋은 `.git-blame-ignore-revs`에 등록했다. `verify:platform`은 `format:check`를 먼저 실행한다.

`GraphRuntime.execute()`를 약 840행에서 약 110행으로 줄이고 사전 검사·시도 전 가드·호출 구성·감독 실행·결과 기록·증거 게이트·완료 판정·실패 분류를 별도 메서드로 나눴다. 정지 경로는 `halt()`에서 방문 pause·예약 복구 취소 여부를 호출부가 명시하며 기존 경로별 차이를 그대로 유지한다([ARCHITECTURE.md](ARCHITECTURE.md)). CLI 종류에 따른 자동화 결정은 `run_policy.ts`로 모았다. 그래프에 `programIoGuard`가 있으면 실행 화면이 이 호스트에서 Kilo 노드가 정지할 조건과 Kilo 외 연결의 격리 범위를 안내한다.

미사용 코드(`path_utils`, `assertSafeSessionId`, 테스트 전용 `mergeReceipts`)와 은퇴한 파일을 가리키던 ignore·패키지 누출 검사 항목을 제거했다. npm 패키지에는 사용자 문서(`AUTONOMOUS_WORKFLOW.md`, `EXECUTION_CONDITIONS.md`)만 포함하고 이 기록과 인수 기준 문서는 제외한다. 기존 stateVersion 3 스냅샷 읽기와 수동 그래프의 평문 보고 형식은 현재 기능이므로 유지했다. 마이그레이션 코드는 없었다.

Windows의 타이밍 의존 테스트를 안정화했다. 비동기 TTY 쓰기 직후 종료하던 fixture는 쓰기 완료 후 종료하고, 종료된 프로세스 핸들이 닫힐 때까지 최대 2초 기다리며, Windows 세션 대기를 45초로 늘렸다. 검사와 무관한 작업(포맷·타입 검사)을 동시에 실행하면 1초 단위 watchdog 테스트가 `phase_timeout`으로 실패하므로 검증은 단독으로 실행한다.

Windows 11 / Node 24.22.1의 `npm run verify:platform`(변경 대상 fb722bb + 문서)에서 format check, typecheck, tooling 10/10, 단위 337개 중 323 통과·0 실패·macOS 전용 14 건너뜀, smoke, pack:check 86파일, pack:smoke, audit 0건이 통과했다. 실행 화면의 격리 안내는 임시 작업 공간에서 Kilo·Codex 연결로 직접 확인했고 콘솔 오류는 없었다. 브라우저 E2E와 macOS VM 테스트, posix invocation 골든 생성은 이 환경에서 실행하지 않았으며 CI(Linux 브라우저, macOS 코어)와 Mac에서 `UPDATE_GOLDEN=1 npm test`로 확인해야 한다.

테스트 분리와 처음 실행 안내 이후 재실행한 `verify:platform`도 단위 338개 중 324 통과·0 실패·macOS 전용 14 건너뜀, tooling 10/10, pack:check 86파일, audit 0건으로 통과했다. `app.test.ts`의 73개 테스트는 본문 변경 없이 네 파일과 공통 harness로 옮겼다. 처음 실행 안내는 빈 작업 공간에서 표시와 연결 화면 이동을 직접 확인했다.

`89b1650` 푸시 후 [main CI](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40976927859)의 Windows·Ubuntu·macOS 코어와 Linux 브라우저 작업이 모두 성공했다. posix invocation 골든은 아직 없어 Linux·macOS에서 해당 테스트를 건너뛰며, macOS 러너에서 VM 테스트가 실제로 실행되는지는 로그로 확인하지 못했다. 남은 과제는 [STATUS.md](STATUS.md)에 정리했다.

## 셸 변경 판정 수정·검증 공백 보강과 실제 회귀 — 2026-10-31

브랜치 `harden/verification-gaps`, 검증 커밋 `57905e8`, macOS 26.6.2 arm64 / 공식 Node 24.22.2. 이 브랜치는 원격 CI를 실행하지 않았다.

`shellMutation`만 `canonicalCommand`를 거치지 않아 `bash -lc 'rm x'`를 파일 변경으로 보지 못했다. 먼저 73개 입력의 판정표(`shell_judgment.test.ts`)로 현재 동작을 고정했고, 수정 후 달라진 값은 `mutation` 열의 의도한 행뿐이다. `node -e`, `python -c` 같은 인터프리터 코드와 `xargs -I {} sh -c '...'`는 알려진 한계로 표에 남겼다.

| 검사 | 결과 |
| --- | --- |
| `verify:platform` | 10단계 통과. 단위 340개 중 338 통과·0 실패·Windows 전용 2 건너뜀, tooling 10/10, 실행기, pack:check 86파일, pack:smoke, audit high 이상 0건 |
| `verify:browser` | Chromium 25/25 (이전 실행은 Node 25.2.1에서도 25/25) |
| `verify:vm` | Apple container 1.6.0에서 16/16, 건너뜀 0. 런타임을 가리면 실패하는 것도 확인 |
| 호출 골든 | posix 16개 생성, 임시 경로와 환경 변수를 바꿔도 동일. 줄 커버리지 71.91% → 97.94%. Ubuntu 일치는 미확인 |
| Homebrew Node 25.2.1 | Seatbelt 8개를 사유와 함께 건너뜀. 실패 0 |

`npm audit`은 운영 의존성에 moderate 3건(`@fastify/static` → `glob` → `minimatch`)을 보고한다. 기준이 high라 통과한다.

### 실제 CLI 회귀 (`test/real-cli/slugify`)

실제 모델을 호출했다. Codex는 사용자 결정으로 제외했다.

| 실행 | 모델 | 결과 |
| --- | --- | --- |
| Claude Code 2.1.223 | `claude-haiku-4-5-20251001` | 145초, 수동 개입 없이 자연 **SUCCESS**. 계획 재시도 1회 외 모든 역할 1회 통과, 읽기 전용 역할 오탐 없음 |
| Kilo 7.4.23 + VM | `kilo/kilo-auto/free` | 35분 시간 제한으로 중지 **STOPPED / NOT_SUCCESS**. 계획~검토는 통과했고 최종 승인에서 반복 실패. 서명 VM 명령 25/25 완료, 미래핑·미확정·서명 오류 0, 컨테이너 전부 삭제 |

첫 Kilo 실행은 대상을 저장소 안에 두어 VM 마운트가 실패했고, 모델 호출 전에 `BLOCKED`로 멈췄다(스크립트 수정 `57905e8`). 세션 종료 후 관련 프로세스와 VM 잔류는 없었다.

두 실행에서 드러난 제품 문제는 STATUS.md 2단계에 올렸다. 자율 계획의 외부 경로 검사가 정규식을 경로로 오판했고, 최종 승인 모델의 `cat a; echo x; cat b`는 읽기 증거로 인정되지 않아 같은 실패를 반복했다.

## 통합 계획 2~5단계 후 실제 CLI 재실행 — 2026-10-31

macOS 26 arm64, 공식 Node 24.22.2. 고정 시나리오 `test/real-cli/slugify`, 결과는 `artifacts/real-cli/`(저장소에 포함하지 않음).

| 실행 | 결과 |
| --- | --- |
| Claude Haiku 1차 (`c9b9a74`) | `PAUSED`, 130초. 계획의 사용 예시 `// → "hello-world"`를 대상 밖 경로로 오판해 계획 단계에서 3회 반려 |
| Claude Haiku 2차 (`c783530`, 주석 표식 수정) | `SUCCESS`, 225초, 수동 개입 없음 |
| Kilo 무료 모델 (`c9b9a74`) | `SUCCESS`, 225초. VM 명령 26/26 완료, 미래핑·미확정·잘못된 receipt 0, 컨테이너 모두 삭제 |

이전 기준선과 비교: Kilo는 35분 제한으로 최종 승인에서 멈췄고, 2단계의 읽기 묶음 인정 후 처음으로 `SUCCESS`에 도달했다. Codex는 사용자 결정으로 제외했다.
