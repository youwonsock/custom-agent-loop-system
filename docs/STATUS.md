# 작업 현황과 남은 과제

2026-10-31 기준. 실행 구조는 [ARCHITECTURE.md](ARCHITECTURE.md), 검사 결과의 기록은 [VERIFICATION.md](VERIFICATION.md)를 기준으로 한다. 이 문서는 다음 작업자가 무엇을 끝냈고 무엇을 이어야 하는지 확인하는 용도이며, 과제를 끝내면 이 문서에서 옮기거나 지운다. npm 패키지에는 포함하지 않는다.

## 현재 상태

| 항목 | 상태 |
| --- | --- |
| 기준 커밋 | `main` `23b2854` (통합 계획과 앱 실행기 수정 완료) |
| 원격 CI | PR #16~#24 병합 전 3개 OS와 브라우저 통과, `23b2854` main CI 성공 |
| 로컬 검사 (macOS 26 arm64, 공식 Node 24.22.2) | `verify:platform` 10단계 통과: 단위 360개 중 358 통과·0 실패·Windows 전용 2 건너뜀, tooling 10/10, audit high 이상 0건(moderate 3건은 아래 "수용한 위험"). `verify:browser` 27/27. `verify:vm` 17/17 |
| 실제 모델 호출 | G4 재실행 통과(5단계). Claude Haiku와 Kilo 무료 모델 모두 수동 개입 없이 `SUCCESS`, Kilo VM 명령 26/26 정상. 브라우저 검증과 자체 테스트를 끈 시나리오이며 6·7단계 이후에는 재실행하지 않았다 |

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

2026-10-31 (브랜치 `harden/verification-gaps`, 통합 계획 0·1단계):

| 영역 | 내용 | 커밋 |
| --- | --- | --- |
| 결함 수정 | `shellMutation`이 `bash -lc 'rm x'` 등 셸 래퍼, `eval`, `{ }`, `<( )`, `xargs`, `find -delete`, `git clean`의 쓰기를 보지 못하던 결함. 셸 판정표를 먼저 고정하고 `mutation` 열의 해당 행만 변경 | `4581ccc`, `8a31c7f` |
| 안전망 | posix 호출 골든, VM 없는 프로그램 I/O 분기 골든(호출 골든 줄 커버리지 71.91% → 97.94%), 프롬프트 골든 누락 사례(줄 커버리지 100%) | `f68512c`, `f332f70` |
| VM 게이트 | 런타임 상태 판별(`ready`/`missing`/`stale`)과 `verify:vm`, Seatbelt 테스트 전제 조건. 오래된 런타임이면 실행 화면 안내도 표시된다 | `4fe97ba` |
| 실제 회귀 | 고정 시나리오 `test/real-cli/slugify`와 `scripts/real-cli-regression.js` | `319e080`, `57905e8` |

2026-10-31 (브랜치 `stage2/small-corrections`, 통합 계획 2단계):

| 영역 | 내용 | 커밋 |
| --- | --- | --- |
| 계획 오판 | 계획에 인용된 정규식(`/[^a-z0-9]+/g`, `/slugify\(/`)을 대상 밖 경로로 판정해 재작성시키던 결함. 알려진 파일 루트와 `FILE_ACCESS`는 그대로 경로로 본다 | `af805df` |
| 읽기 증거 | `&&`·`;` 읽기 묶음과 `echo`·`printf` 구분자를 인정. 종료 코드는 마지막 `;` 뒤만 증명하므로 그 앞의 읽기는 실제로 읽을 수 있는 일반 파일일 때만 인정한다. 파이프·리디렉션·다른 명령이 섞이면 인정하지 않는다 | `8f160c4` |
| VM 오류 | 대상 프로젝트가 앱 설치 폴더 안에 있으면 `errno 30` 대신 원인을 알린다. 모델 호출 전에 멈추는 것은 같다 | `3368c0d` |

2026-10-31 (브랜치 `stage3/shared-rules`, 통합 계획 3단계):

| 영역 | 내용 | 커밋 |
| --- | --- | --- |
| 역할 | 역할 집합을 `shared/node_roles.ts`로 이동. `completion`의 `invocation` 의존 제거 | `d41672d` |
| 도우미 | `obj`·`isObj`·`sha`를 `values.ts`로 통합. `node_test_worker`는 배열도 순회하고 Kilo 플러그인 코드는 CLI 프로세스 안에서 실행되므로 자체 사본을 유지한다 | `5ca7f4e` |
| 성공 판정 | `commandSucceeded` 하나로 통합. PASS 경로의 환경 오류 예외 2곳은 앞선 게이트에서 이미 걸러지므로 동작 변화 없이 제거 | `0008744`, `0f45daf` |
| 경로 포함 | `isWithin` 하나로 통합. `verification_sources`만 의도한 변경으로, Windows에서 대소문자만 다른 경로를 같은 폴더로 인정한다. 심볼릭 링크 검사는 유지하고 테스트를 추가했다 | `6ebd8bb`, `de35b8c` |
| 셸 파서 | 인용·이스케이프 처리를 `shell_scan.ts`로 통합. 판단 규칙은 파서별 유지. 판정표 diff 0, 무작위 명령 40만 개에서 이전 파서와 결과 동일 | `592b358` |
| 격리 오류 | 프로세스 내부 판정을 `IoUnavailable` 타입으로 변경. 메시지의 문자열 표식은 프로세스 경계를 위해 유지 | `6ba3c95` |

2026-10-31 (브랜치 `stage4/judge-and-runtime`, 통합 계획 4단계):

| 영역 | 내용 | 비고 |
| --- | --- | --- |
| 도달 불가 분기 | `failure`의 고아 프로세스 분기 제거. `classifyFailure`는 유지 | 정지 경로 표와 특성 테스트 주석 수정 |
| 판정 | `validateCompletion`을 옵션 객체와 순서 있는 게이트 13개로 분리. 복잡도 102 → 15 미만 | 무작위 입력 30만 건에서 이전 판정과 결과 동일 |
| 실행 루프 | `GraphRuntime.run`을 소유자 복구, 모델 재조회, 자동 복구 갱신, 방문 루프, 종단 판정으로 분리. 복잡도 79 → 15 미만 | 서버 시나리오와 특성 테스트 통과 |
| 상태 쓰기 | `status` 직접 쓰기를 `settle`로 통합(`GraphRuntime` 안). `Completion \| null \| undefined`를 `stopped`·`completed`·`undecided`로 교체 | `session_transitions.ts`의 상태 전이 함수는 그대로 |

2026-10-31 (브랜치 `stage5/invocation-prompt-supervisor`, 통합 계획 5단계):

| 영역 | 내용 | 비고 |
| --- | --- | --- |
| 호출 | `invocation.ts`를 Codex, Claude, OpenCode·Kilo 공용, Kilo 격리 모듈로 분리. `__dirname` 경로 때문에 `src/core`에 평면 배치 | 호출 골든 diff 0 |
| 프롬프트 | `buildNodePrompt`를 순서 있는 섹션 함수 10개(`prompt_sections.ts`)로, 복구 메시지를 `prompt_recovery.ts`로 분리. 문자열은 다시 감싸지 않았다 | 프롬프트 골든 diff 0 |
| 정책 재판단 | `buildInvocation`의 `c.type === "kilo"` 분기는 `run_policy`로 옮기지 않는다. 그 분기는 정책 판단이 아니라 해당 CLI만 지원하는 호출 형식이며, `prompt.ts`는 CLI 종류를 받지 않는다 | 변경 없음 |
| 감독기 | 특성 테스트 8개를 먼저 추가한 뒤 `ProcessSupervisor.run`(632행)을 `SupervisedAttempt`와 `BoundedRawLog`로 분해. `run`은 100행 미만 | 기존 감독기 테스트 수정 없음 |
| 계획 오판 | G4에서 발견: 사용 예시의 `// 결과` 주석을 대상 밖 경로로 판정해 Claude 실행이 멈췄다. 주석 표식은 경로로 보지 않고, `FILE_ACCESS`와 표식 뒤의 경로는 그대로 본다 | `c783530` |
| G4 | Claude Haiku(`claude-haiku-4-5-20251001`) 225초 `SUCCESS`, Kilo 무료 모델 225초 `SUCCESS`(VM 명령 26/26 정상, 격리 이탈 0). Kilo 실행은 주석 표식 수정 전 커밋에서 했으며 그 수정은 Kilo 경로의 판정을 좁히지 않는다 | 이전에 Kilo는 최종 승인에서 35분 제한으로 멈췄다 |

2026-10-31 (브랜치 `stage6/data-model-and-ui`, 통합 계획 6단계):

| 영역 | 내용 | 비고 |
| --- | --- | --- |
| 세션 스키마 | `programIoAudit`, `scopeAudit`을 값이 있을 때만 검사 | 저장된 실제 세션 6개(감사가 있는 시도 18개) 읽기 확인 |
| 그래프 검증 | 플래그를 표로 검사하고 오류를 항목별로 분리. 저장 시 알려진 플래그만 남긴다 | 저장 순서 유지 |
| 실행 진단 | `authoredNodeTests`에 `verificationContract`가 없으면 서버에서 차단 | 의도한 변경. 화면에서만 맞추던 규칙이며, 이 조합으로 저장된 그래프는 시작 전에 진단이 뜬다 |
| 공통화 | 기본 노드(`defaultNode`, 간격은 인자)와 자율 기본 플래그(`autonomousDefaults`) | |
| 파일 분리 | `resilience.ts`를 `file_lock`, `session_ownership`, `control_queue`로, `GraphInspector`를 `NodeInspector`·`GraphSettings`로, `useGraphEditor`를 `useGraphDraft`·`graphLibraryActions`·`graphNodeActions`로 분리 | 저장 필드 이름 유지 |
| 문서 | [용어·제한값 사전](GLOSSARY.md) 추가, `VERIFICATION.md`를 최신 기록과 [이력](verification/2026-10-history.md)으로 분리하고 머신 경로 제거 | |

2026-10-31 (브랜치 `stage7/usability`, 통합 계획 7단계):

| 과제 | 결과 |
| --- | --- |
| 화면 전환 지연 | 메뉴에 마우스를 올리거나 포커스하면 해당 화면을 미리 불러온다. 초기 번들 제한 E2E는 그대로 통과 |
| CLI 찾기 | **설치된 CLI 찾기** 버튼을 눌렀을 때만 CLI 4종을 PATH에서 찾아 경로를 보여 준다. 링크를 따라간 버전별 경로가 아니라 PATH 항목을 제안해 CLI를 업데이트해도 연결이 깨지지 않는다. CLI를 실행하지 않고, 등록은 항목별로 직접 누른다. 자동 스캔 없음 원칙 유지 |
| 캔버스 휠 | 현재 동작을 유지하고 과제 종료 |

통합 계획은 이 단계로 끝났다. 아래 범위 밖 항목은 착수 여부를 따로 정한다.

수용한 위험: `npm audit`의 moderate 3건(`@fastify/static` → `glob` → `minimatch`). `@fastify/static`은 `wildcard: false`일 때만 `glob`을 호출하고 이 앱은 그 옵션을 쓰지 않는다. `audit fix --force`는 주 버전을 낮추므로 적용하지 않는다.

유지하기로 결정한 것: stateVersion 3 스냅샷 읽기와 수동 그래프의 평문 보고 형식은 현재 기능이다. 마이그레이션 코드는 없었다.

## 통합 계획의 기준

숨은 결함을 먼저 고치고 안전망을 실제로 작동시킨 뒤, 판정 규칙을 한곳으로 모으고, 마지막으로 큰 함수를 분해한다. 동작 불변 커밋과 동작 변경 커밋은 섞지 않는다.

| 게이트 | 내용 | 적용 |
| --- | --- | --- |
| G1 기본 | 공식 Node 24에서 `verify:platform`, `verify:browser` 통과, CI 3개 OS 성공 | 모든 PR |
| G2 동작 고정 | 프롬프트·호출 골든과 셸 판정표 diff 0 | 동작 불변 커밋 |
| G3 VM | `verify:vm` 통과, 건너뜀 0 | 실행·호출·격리 코드 변경 |
| G4 실제 CLI | Claude Haiku: 수동 개입 없이 `SUCCESS`. Kilo 무료 모델: 서명된 VM 명령의 시작·종료·삭제가 모두 맞고 격리 이탈 0건(`SUCCESS`는 요구하지 않음). 공급자 할당량으로 중단되면 판정을 보류하고 재실행 | 1단계 끝, 5단계 끝 (완료) |

동작 불변 커밋에서 G2가 달라지면 수정하지 않고 되돌린 뒤 원인부터 찾는다.

### 사용자 환경

공식 Node 24.22.2를 `~/.local/opt/node-24`에 설치하고 `~/.zprofile`의 PATH 앞에 두었다. `.git/config`의 빈 `user.name`을 지웠고, 이 저장소의 push는 `gh` 계정을 쓰도록 저장소 설정에만 등록했다. `~/.npm-cache`의 root 소유 캐시는 `_cacache.root-owned-backup`으로 옮겨 두었고, 지우려면 `sudo`가 필요하다.

앱 실행기는 로그인 셸의 `node`를 먼저 쓰고 Homebrew 빌드는 다른 Node 24 이상이 없을 때만 쓴다(PR #24).

Codex는 사용자 결정으로 G4에서 제외했다. Codex 경로는 가짜 이벤트로만 검증되었고, 실제 Codex가 명령을 셸로 감싸는지도 확인하지 못했다.

### 범위 밖

리팩터링과 섞지 않으며, 착수 여부를 따로 정한다.

- Linux·Windows용 프로그램 I/O 격리 백엔드. 지금은 macOS 26 + Apple container에서만 강한 격리가 성립하고, 다른 환경에서는 화면 안내만 제공한다.
- 병렬 노드 실행과 금액 기준 예산.
- 문서와 화면의 영어 지원. 지금은 한국어만 제공한다.

보류: 테스트 시간 단축(macOS·Ubuntu는 CI 작업 전체가 2.5~3.5분이고 Windows만 약 9분이다), 자동화 플래그 제거, `src/core` 폴더 재구성, 테스트 fixture 통합, 저장 필드 이름 변경.

## 후속 계획 (2026-10-31)

프로젝트 재분석에서 나온 약점을 고친다. 단계마다 PR을 만들어 CI 통과 후 병합한다. 라이선스는 사용자 선택 전이라 넣지 않았고, Codex는 G4 제외를 유지한다.

| 단계 | 내용 | 완료 기준 |
| --- | --- | --- |
| 0 | 문서 갱신, CI 중복 실행 제거 | 문서가 현재 상태와 일치, PR 검사 4개 |
| 1 | 서버와 화면이 있는 고정 시나리오로 기본 자율 프리셋을 실제 모델로 실행 | Claude 수동 개입 없이 `SUCCESS`. Kilo VM 명령 전부 정상, 격리 이탈 0건 |
| 2 | 제어 큐 ack 실패, 재시작 복구, 잠금 가드 회수 | ack 실패에도 실행 중 세션의 STOP이 처리됨 |
| 3 | `testSourceGuard`를 끈 그래프의 검토·승인과 계획·중단 역할의 파일 변경 판정 | `node -e`로 파일을 바꾼 읽기 전용 역할이 반려됨 |
| 4 | `MutationTracker.observe`, `evidenceGates`, `judge` 분해 | 복잡도 15 이하, `runtime.ts` 1,200행 미만, 골든 diff 0 |
| 5 | VM 테스트의 CI 실행 또는 PR 강제, 실제 CLI 최종 재실행 | VM 검사가 CI에서 돌거나 PR에서 강제됨 |

## 브랜치

통합 계획 전에 작업 브랜치를 모두 정리했다. 그 후 병합된 `harden/verification-gaps`, `stage2/`~`stage7/`, `docs/status-after-plan`, `fix/launcher-official-node`는 원격에 남아 있으며 모두 `main`에 포함되어 지워도 된다.

병합하지 않은 이전 브랜치 2개는 삭제 전에 로컬 태그로 보존했다(2단계에서 이 복사본의 태그를 다시 만들었다). 둘 다 지금은 제거된 VS Code 확장·데스크톱 앱 구조의 코드이며(`8.0.0`, `3.4.1`), 현재 `main`(`4.0.0` 구조)에 그대로 병합할 수 없다. 태그는 원격에 올리지 않았으므로 해당 복사본에만 있다. 다른 복사본에서는 `9f39ebf`를 원격 `refs/pull/7/head`에서 받을 수 있지만 `87f2b2c`는 원격 참조가 없다.

| 태그 | 내용 |
| --- | --- |
| `archive/codex/integrate-dependabot-branches` | `9f39ebf` (2026-09-12), `main`에 없는 커밋 23개 |
| `archive/codex/security-hotfix-3.4.1` | `87f2b2c` (2026-08-10), `main`에 없는 커밋 1개 |

