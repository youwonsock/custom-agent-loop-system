# 작업 현황과 남은 과제

2026-10-31 기준. 실행 구조는 [ARCHITECTURE.md](ARCHITECTURE.md), 검사 결과의 전체 기록은 [VERIFICATION.md](VERIFICATION.md)를 기준으로 한다. 이 문서는 다음 작업자가 무엇을 끝냈고 무엇을 이어야 하는지 확인하는 용도이며, 과제를 끝내면 이 문서에서 옮기거나 지운다. npm 패키지에는 포함하지 않는다.

## 현재 상태

| 항목 | 상태 |
| --- | --- |
| 기준 커밋 | `89b1650` (이 문서 이전의 `main`) |
| 원격 CI | [run 40976927859](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/40976927859): Windows·Ubuntu·macOS 코어와 Linux 브라우저 시나리오 모두 성공 |
| 로컬 검사 (Windows 11, `verify:platform`) | 단위 338개 중 324 통과·0 실패·macOS 전용 14 건너뜀, tooling 10/10, smoke, pack:check 86파일, pack:smoke, audit 0건 |
| 로컬에서 실행하지 않은 검사 | 브라우저 E2E(Chromium 미설치, CI에서 통과), macOS VM 테스트, posix invocation 골든 생성 |
| 실제 모델 호출 | 이번 작업에서는 수행하지 않음. 모두 가짜 CLI 기준 |

## 완료한 작업 (2026-10-29 ~ 10-30)

모든 구조 변경은 판정 동작을 바꾸지 않는 것을 원칙으로 했고, Windows PATH 수정만 의도한 동작 변경이다.

| 영역 | 내용 | 커밋 |
| --- | --- | --- |
| 안전망 | 노드 프롬프트 28종과 복구 메시지, CLI 4종의 인자·환경을 골든으로 고정. 기존 시나리오가 닿지 않던 정지 경로 2곳의 세션 상태 전체를 특성 테스트로 고정 | `67d62fd`, `e9fa7bd` |
| 버그 수정 | Windows에서 부모 환경 변수가 `Path`일 때 CLI 자식의 PATH가 node 폴더로 고정되던 결함 | `9f6f4b7` |
| 포맷 | Prettier 도입, 포맷 전후 구문 트리 동일성 검사, blame 제외 등록, `verify:platform`에 `format:check` 추가 | `c797ed0`, `d6315cd`, `30db678` |
| 런타임 구조 | `GraphRuntime.execute()`를 단계별 메서드로 분해(약 840행 → 약 110행). 정지는 `halt()`에서 부수효과를 명시. CLI별 자동화 결정을 `run_policy.ts`로 분리 | `0fa08ec` |
| 테스트 안정화 | Windows 타이밍 의존 테스트 3종 수정. 73개 서버 시나리오를 분야별 파일 4개와 공통 harness로 분할 | `7aa1bd1`, `0ddbcc4` |
| 사용성 | 실행 전 프로그램 I/O 격리 범위 안내, 연결이 없을 때 처음 실행 안내 | `f69ef8f`, `89b1650` |
| 정리 | 미사용 코드(`path_utils`, `assertSafeSessionId`, `mergeReceipts`)와 은퇴한 ignore·패키지 항목 제거. 머신 경로가 든 개발 기록을 npm 패키지에서 제외 | `fb722bb` |
| 문서 | `ARCHITECTURE.md` 신설, README·실행 조건·자율 실행·검증 기록 갱신 | `49417cb` |

유지하기로 결정한 것: stateVersion 3 스냅샷 읽기와 수동 그래프의 평문 보고 형식은 현재 기능이다. 마이그레이션 코드는 없었다.

## 남은 과제 (통합 계획)

숨은 결함을 먼저 고치고 안전망을 실제로 작동시킨 뒤, 판정 규칙을 한곳으로 모으고, 마지막으로 큰 함수를 분해한다. 동작 불변 커밋과 동작 변경 커밋은 섞지 않는다.

| 게이트 | 내용 | 적용 |
| --- | --- | --- |
| G1 기본 | 공식 Node 24에서 `verify:platform`, `verify:browser` 통과, CI 3개 OS 성공 | 모든 PR |
| G2 동작 고정 | 프롬프트·호출 골든과 셸 판정표 diff 0 | 동작 불변 커밋 |
| G3 VM | `verify:vm` 통과, 건너뜀 0 | 실행·호출·격리 코드 변경 |
| G4 실제 CLI | Claude Haiku: 수동 개입 없이 `SUCCESS`. Kilo 무료 모델: 서명된 VM 명령의 시작·종료·삭제가 모두 맞고 격리 이탈 0건(`SUCCESS`는 요구하지 않음). 공급자 할당량으로 중단되면 판정을 보류하고 재실행 | 1단계 끝, 5단계 끝 |

동작 불변 커밋에서 G2가 달라지면 수정하지 않고 되돌린 뒤 원인부터 찾는다.

### 0·1단계: 환경과 안전망

| 작업 | 완료 기준 |
| --- | --- |
| 공식 빌드 Node 24 설치. Homebrew Node는 `libuv`를 외부에 두어 Seatbelt 테스트와 맞지 않는다 | `node -v`가 v24 |
| `~/.npm-cache` 소유권 복구 (`sudo`는 사용자 작업) | 기본 캐시로 `npm ci` 성공 |
| 셸 판정표 테스트 후 `shellMutation` 수정. 다른 모듈은 `canonicalCommand`로 셸 래퍼를 풀지만 이 함수만 풀지 않아 `bash -lc 'rm x'`를 변경으로 보지 못한다 | 표의 해당 행만 변경. 인터프리터 코드 실행(`node -e` 등)은 범위 밖 |
| posix 골든 커밋 | macOS·Ubuntu CI 통과. 다르면 계열 분리 |
| 가짜 정책으로 VM 분기 골든 추가. `prepareProgramIo`만 대체하므로 모든 OS CI에서 실행된다 | 호출 골든 줄 커버리지 95% 이상 |
| 프롬프트 골든 누락 사례 추가 | 미검증 구간 해소 |
| VM 런타임 상태 판별(`ready`/`missing`/`stale`)과 `verify:vm` | 오래된 런타임은 일반 테스트에서 사유와 함께 건너뛰고, `verify:vm`에서는 실패 |
| Seatbelt 테스트 전제 조건 | Homebrew Node는 사유 표시 후 건너뜀, CI에서 건너뛰면 실패 |
| 실제 CLI 시나리오 작성과 G4 기준선 실행 | 기록 저장. Codex는 사용자 결정으로 G4에서 제외했으므로 Codex 경로는 가짜 이벤트로만 검증된다 |

### 2단계: 작은 보정

- 오래된 런타임 안내 문구를 실행 화면에 표시.
- `npm audit`의 moderate 3건(`@fastify/static` → `glob` → `minimatch`)은 앱이 `wildcard: false`를 쓰지 않아 `glob` 호출 경로가 아니므로 사유를 기록하고 수용.
- 보존 태그 재생성: 일부 복사본에는 아래 태그가 없다. `9f39ebf`는 원격 `refs/pull/7/head`에 남아 있으나 `87f2b2c`는 원격 참조가 없다.
- README의 `.app` 빌드와 검증용 Node 안내, 이 문서의 수치 갱신.

### 3단계: 규칙 공통화

| 작업 | 유형 | 주의점 |
| --- | --- | --- |
| 역할 집합과 `isReadOnly`를 공용 모듈로 이동(약 19곳) | 불변 | `completion`의 `invocation` 의존 제거 |
| `obj`/`object`, `sha` 도우미 통합 | 불변 | `node_test_worker`의 배열 허용 변형은 호출부 확인 후 판단 |
| 명령 성공 판정을 함수 하나로 통합(현재 7곳) | 불변 후 변경 | 조건 차이를 인자로 보존해 모은 뒤, 차이 제거는 항목별 별도 커밋 |
| 경로 포함 판정 통합(`path.relative` 방식과 접두사 방식) | 불변 후 변경 | 심볼릭 링크 검사 유지, Windows CI 필수 |
| 공통 토크나이저로 셸 파서 3개 통합 | 불변 | 판단 규칙은 파서별 유지, 판정표 diff 0 |
| 프로세스 내부 `IO_UNAVAILABLE`을 타입 오류로 변경 | 불변 | 프로세스 경계의 문자열 표식은 유지 |

### 4단계: 판정·실행 엔진 분해

- 도달 불가 분기 제거: `failure`의 고아 프로세스 분기(`classifyFailure` 자체는 유지). 특성 테스트 주석과 `ARCHITECTURE.md`도 수정.
- `validateCompletion`(복잡도 102, 인자 11개)을 옵션 객체로 전환 후 역할별 분리. 복잡도 30 이하.
- `GraphRuntime.run`(복잡도 79, 323행)을 소유자 복구, 모델 재조회, 자동 복구 예약, 종단 판정, 방문 루프로 분리. 복잡도 30 이하.
- `status` 직접 쓰기(15곳)를 공통 경로로 통합, `Completion | null | undefined` 반환을 명명된 결과로 교체.

### 5단계: 호출·프롬프트·감독기 분해

- `invocation.ts`를 Codex, Claude, OpenCode·Kilo 공용, Kilo 격리 모듈로 분리. `__dirname` 경로 때문에 `src/core`에 평면 배치.
- `prompt.ts` 분리. 긴 문자열을 템플릿 리터럴 여러 줄로 풀면 모델 입력이 바뀌므로 다시 감싸지 않는다.
- `buildInvocation`의 정책 적용 재판단. `buildNodePrompt`는 CLI 종류를 받지 않으므로 `prompt.ts`에는 적용하지 않는다.
- `ProcessSupervisor.run`(632행) 특성 테스트 작성 후 분해. 150행 이하.
- G4 재실행.

### 6단계: 데이터 모델과 화면 정리

- 세션 스키마에 `programIoAudit`, `scopeAudit` 검증 추가(값이 있을 때만 검사).
- 그래프 플래그 검증을 표 방식으로 전환하고 오류 메시지를 항목별로 분리.
- `authoredNodeTests → verificationContract` 규칙을 실행 진단으로 서버에 추가(지금은 화면에서만 맞춘다).
- 기본 노드 생성 공통화(간격은 인자로 유지), 제한값·용어 사전 작성(저장 필드 이름은 유지).
- `resilience.ts` 분할, `GraphInspector`와 `useGraphEditor` 분리, `VERIFICATION.md` 분리와 머신 경로 정리.

### 7단계: 사용성

| 과제 | 결정 |
| --- | --- |
| 화면 전환 지연 | 메뉴 호버·포커스 시 미리 로드. 번들 제한 E2E 유지 |
| CLI 찾기 제안 | 버튼을 눌렀을 때만 CLI 4종을 PATH에서 찾고, 확인한 경로만 등록. "자동 스캔 없음" 원칙 유지 |
| 캔버스 휠 | 현재 동작을 유지하고 과제 종료 |

### 범위 밖

리팩터링과 섞지 않으며, 7단계 후 착수 여부를 따로 정한다.

- Linux·Windows용 프로그램 I/O 격리 백엔드. 지금은 macOS 26 + Apple container에서만 강한 격리가 성립하고, 다른 환경에서는 화면 안내만 제공한다.
- 병렬 노드 실행과 금액 기준 예산.
- 문서와 화면의 영어 지원. 지금은 한국어만 제공한다.

보류: 테스트 시간 단축(macOS·Ubuntu는 CI 작업 전체가 2.5~3.5분이고 Windows만 약 9분이다), 자동화 플래그 제거, `src/core` 폴더 재구성, 테스트 fixture 통합, 저장 필드 이름 변경.

## 브랜치

2026-10-31에 작업 브랜치를 모두 정리해 `main`만 남겼다. 원격에도 `main`만 있다.

병합하지 않은 이전 브랜치 2개는 삭제 전에 로컬 태그로 보존했다. 둘 다 지금은 제거된 VS Code 확장·데스크톱 앱 구조의 코드이며(`8.0.0`, `3.4.1`), 현재 `main`(`4.0.0` 구조)에 그대로 병합할 수 없다. 태그는 원격에 올리지 않았으므로 해당 복사본에만 있다.

| 태그 | 내용 |
| --- | --- |
| `archive/codex/integrate-dependabot-branches` | `9f39ebf` (2026-09-12), `main`에 없는 커밋 23개 |
| `archive/codex/security-hotfix-3.4.1` | `87f2b2c` (2026-08-10), `main`에 없는 커밋 1개 |

