# 구현 검증 및 수정 기록

최신 기록만 둔다. 이전 기록은 [2026-10 이력](verification/2026-10-history.md)에 있다.

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

## 통합 계획 6·7단계와 앱 실행기 — 2026-10-31

macOS 26 arm64, 공식 Node 24.22.2. 6·7단계 이후 실제 모델은 호출하지 않았으며, 코드 변경 후의 실제 CLI 재실행은 후속 계획에서 한다.

| 검사 대상 | 결과 |
| --- | --- |
| 6단계 (`stage6/data-model-and-ui`) | 저장된 실제 세션 6개, 감사가 있는 시도 18개를 새 스키마로 읽음. Windows CI에서 드러난 첫 출력 1초 제한은 Windows만 3초로 수정 |
| 7단계 (`stage7/usability`) | `verify:platform`: 단위 360개 중 358 통과·0 실패·Windows 전용 2 건너뜀. `verify:browser` 27/27, `verify:vm` 17/17. CLI 찾기는 실제 앱에서 버전별 경로를 제안하는 문제를 발견해 PATH 항목을 제안하도록 고쳤고, 수정 후에는 서버 테스트로 확인 |
| 앱 실행기 (PR #24) | `verify:platform` 통과(실행기 5/5), `verify:browser` 27/27, `verify:vm` 17/17, CI 8/8. 실제 앱을 열어 실행기와 서버 프로세스가 공식 Node로 시작하고 앱 종료 후 포트가 닫히는 것을 확인 |
