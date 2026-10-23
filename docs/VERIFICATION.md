# 구현 검증 및 수정 기록

## 2026-10-23 실제 실행 후 완료 판정 보강

제품 코드 `508c7cb519b92927ea91950a127f938895d219e4`, GUI 회귀 추가 `28775e2`를 검증했다. 작업 브랜치는 `codex/verified-completion`이며 원격 CI는 이번 수정에 대해 실행하지 않았다. 이전 Actions 결과는 아래 해당 커밋의 기록으로만 해석한다.

- `4fce808`: HTTP/파일 경로 구분, 공백·Windows 승인 경로 보존, 네이티브 검증 명령/종료 코드 기록, 요구사항 CHECK_COMMAND 연결, 수정 후 증거 무효화, 현재 테스트 PASS에 근거한 검토/승인, 환경 차단 대기.
- `508c7cb`: 실제 Luna가 반환한 Markdown 판정·리다이렉션 명령·REQ BLOCKED 보고 호환성.
- `28775e2`: 환경 차단 이유 표시와 같은 테스트 방문의 GUI 수동 재개 검사.

| 검사 | 현재 확인 결과 |
|---|---|
| macOS arm64 / Node 25.2.1 코어·서버·CLI | 112 통과, Windows 전용 1 제외, 0 실패 |
| 개발 도구 / macOS 실행기 | 8/8, 4/4 |
| Chromium GUI | 16/16 (기존 15 + 환경 차단/재개) |
| 패키지 내용 / 설치 실행 / 운영 의존성 audit | 42개 파일 정상, 설치 실행 통과, 취약점 0 |
| 이번 변경의 Windows/Linux/Node 24 CI | 미실행, 새 Actions 링크 없음 |

플랫폼 suite는 508c7cb, GUI suite는 28775e2에서 실행했다. 두 커밋 간 제품 코드 차이는 없다. 초기 패키지 검사 실패와 최종 순차 재검증 성공을 모두 보존했다. [플랫폼 요약](../artifacts/verification/platform-darwin-arm64/summary.json), [GUI 요약](../artifacts/verification/browser-darwin-arm64/summary.json).

실제 모델 호출은 fake CLI 회귀 검사와 구분한다. 이전 게임/세션을 보존하고 바탕화면 `agent graph test/retest-20261023-175531`의 복사본에서 재검증했다.

| 실제 실행 | 결과 |
|---|---|
| GPT-6 Luna 기본 그래프 | 모델이 수정했으나 샌드박스 `listen EPERM`으로 테스트 BLOCKED / WAITING_USER. 구현을 반복하거나 성공으로 올리지 않았다. 운영자 환경의 게임 테스트는 15/15. |
| Kilo Auto Free 자율 수정 | 공급자 오류/무응답 이후 재개해 일부 수정했지만 복구 예산으로 PAUSED. 자율 완주 실패를 보존. |
| Kilo Auto Free 보완 후 검증 전용 그래프 | 운영자가 잔여 포인터/심볼릭 링크/테스트 API 오류를 보완한 뒤 같은 요청 모델로 npm test exit 0, 31/31을 관측하고 SUCCESS. 전체 자율 구현 성공과 구분. |

두 게임 모두 운영자 독립 엔진 검사 13개 묶음/4,000 비교, 저장값 경계 10개, HTTP 9개, CUA 브라우저 17개를 통과했다. 물리 터치스크린은 미검증이다. Kilo 수정 전 파일과 운영자 diff, 독립 테스트 원본, 실제 요청/라우팅 모델, 세션·attempt·로그·제품 해시를 로컬 결과 폴더에 보존했다. 네이티브 Codex가 실제 모델 ID를 보고하지 않아 요청 모델 gpt-6-luna만 확인했다. Kilo는 요청 `kilo/kilo-auto/free`를 유지했고 reflection/beam, nvidia/nemotron-3.5-super-vl:free, dots-studio/dots-3-note-preview:free 라우팅이 관측됐다.

실행 기록은 검사 실행 여부를 보강하며 테스트의 충분성을 보장하지 않는다. 모델의 코드/검사 품질, 네이티브 환경 제약, 공급자 가용성에는 여전히 감독이 필요하다. 이전 세션은 새 증거 필드 없이 읽되, 존재하지 않는 검증 기록을 통과 근거로 추정하지 않는다.

상세 로컬 결과: `/Users/supercent/Desktop/agent graph test/retest-20261023-175531/TEST_RESULTS.md`. 이번 실행의 새 CI 링크는 없으며 아래는 과거 커밋의 검증 이력이다.

## 이전 검증 이력

기준 코드: 1fc80c8. 검증일: 2026-10-13. 인수 기준은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)를 따른다.

상태: 기능 검증 완료. 계획의 24개 인수 기준을 구현·검사·수정 기록과 대조했다. 검증용 CLI를 사용하는 테스트와 실제 CLI의 모델 목록 조회를 구분했다.

## 최종 검증 결과

| 검사 | 결과 | 증거 |
|---|---|---|
| 빌드 및 타입 검사 | 통과 | backend와 frontend 타입 검사를 빌드에 포함; [빌드 로그](../artifacts/verification/build.log) |
| Node 24 단위·통합·공개 CLI | 69/69 통과 | [실행 로그](../artifacts/verification/node24-tests.log) |
| Node 24 + Chromium GUI | 9/9 통과 | [GUI 로그](../artifacts/verification/gui.log), [시나리오](../test/e2e/studio.spec.ts) |
| 데스크톱·태블릿·모바일 | 1440/800/390px 확인 | 전체 노드 화면 맞춤, 문서 및 패널 가로 넘침 검사; CUA 직접 확인 |
| npm 패키지 내용 | 통과 | 테스트·VSIX·개발 소스·실행 데이터 제외; [목록 검사](../artifacts/verification/package-contents.log) |
| 설치된 npm 패키지 | 통과 | CLI, 실제 JS/CSS 응답, 새 저장소, 네 모델 API, SDK 내장 CLI 없이 조회, IPC 정상 종료; [로그](../artifacts/verification/installed-package.log) |
| CLI 도움말 | 통과 | [로그](../artifacts/verification/cli.log) |
| 운영 의존성 audit | 알려진 취약점 0건 | [보고서](../artifacts/verification/audit.json) |
| 변경 파일 공백 검사 | 통과 | git diff --check |

실행 검증은 macOS arm64와 Node 24.21.0에서 수행했다. 호스트의 Node 25.2.1에서도 빌드·타입 검사와 앞선 회귀 시나리오를 확인했다. Windows·Linux·macOS의 Node 24 CI와 Linux 브라우저 CI를 구성했으며, 이 작업에서 원격 CI나 Windows/Linux 실기 실행 결과를 생성한 것은 아니다.

## 목표별 대조

모든 행의 결과는 통과다. 실제 제품 동작을 검사하는 시나리오와 소스 검토를 함께 사용했다.

| 인수 기준 | 구현 결과와 검증 증거 |
|---|---|
| APP-01 | Fastify 서버/세션 워커와 React/Vite/React Flow UI; Node 24 검사 및 설치된 패키지의 웹 응답 |
| APP-02 | 127.0.0.1 바인딩, 세션 쿠키, Host/Origin 검증; 인증 쿠키 누락·외부 Host·외부 Origin 거부 API 테스트 |
| APP-03 | ui/init/graphs/models/run/resume; 공개 CLI 테스트와 root/port/no-open을 사용한 설치 패키지 실행 |
| GRAPH-01 | 생성·복제·이름/설명 수정·삭제·JSON 내보내기/가져오기; 새 ID 확인 및 실행 snapshot 보존 GUI 검사 |
| GRAPH-02 | 노드 추가/드래그/삭제, 핸들 연결과 다음 단계 선택, undo/redo, 화면 맞춤과 줌 복원 GUI 검사 |
| GRAPH-03 | 6종 실행 유형, 역할명/지침, 공통 설정과 노드별 모델/추론 옵션; 바인딩 API 및 GUI 검사 |
| GRAPH-04 | 500ms 자동 저장, CAS/파일 잠금/원자 쓰기, 로컬 초안 보존; 두 창 충돌·재열기·새 그래프 저장 검사 |
| GRAPH-05 | 초안/실행 검증 분리; 부분 바인딩, 닫힌 순환, 중복 출력, 종료/재진입 구조 검사 |
| RUN-01 | 세션별 fork 워커, node/visit/attempt 분리; 정상 5단계 실행과 순환 재방문 검사 |
| RUN-02 | 방문별 계획 파일 및 session/node/visit/revision/request ID 승인; 재방문 새 승인·이전 승인 거부·중복 요청 검사 |
| RUN-03 | 그래프·연결·모델·실행 설정 snapshot; 라이브러리 변경 후 실행 snapshot 불변 검사 |
| RUN-04 | 앱 내 Markdown 미리보기·문서 수정·revision 저장·계획 선택/승인; GUI 완주 검사 |
| RUN-05 | Stop/Interrupt/Resume, lease, orphan 차단, watchdog, 재연결·완료 복구·자동 복구·반복 예산 검사 |
| RUN-06 | 브라우저 닫기/다시 열기, 정상 서버 종료, 예약 복구 취소, 계획 대기 복원, 워커 강제 종료 후 수동 재개 검사 |
| MODEL-01 | 수동 연결 등록만 제공; Codex/Claude/OpenCode/Kilo 모델 API 프로토콜 테스트와 실제 목록 조회 |
| MODEL-02 | 조회된 모델과 추론 옵션만 선택; 미등록 모델 사전 차단, 대체 목록/자동 모델 변경 없음 |
| MODEL-03 | 조회/실행에 동일 CLI와 대상 경로 사용; connection/binary/canonical target별 캐시 및 native cwd 검사 |
| MODEL-04 | 조회에 작업 프롬프트를 보내지 않음; timeout/취소 후 프로세스 사망 확인, SDK 제어 프로토콜 검사 |
| MODEL-05 | 실행/재개 전 목록 재조회; 모델 불일치와 인증 실패 WAITING_USER, 인증 복구 후 동일 방문 재개 검사 |
| TOOL-01 | MCP/웹/스킬/훅/플러그인은 CLI 설정 계승; pure/search/mcp 설정 주입 부재와 역할별 권한 인자 검사 |
| TOOL-02 | 검색 설정 사전 검사 제거; 완료된 검색과 assistant URL/사실 근거 또는 RESEARCH_BLOCKED로 판정 |
| TOOL-03 | 증거 요약을 출력 링과 별도로 누적; 파일 변경·검색·모델 사용 증거가 이벤트 폭주 후에도 유지됨 |
| UI-01 | 정상/좁은 화면 및 계획/완료 화면 확인; 모바일 메뉴·노드 선택·입력·저장·연결·버튼 동작 GUI 검사 |
| RELEASE-01 | 확장/VSIX/기존 설정 경로 제거, 새 저장 영역, README/CI/npm 갱신; 패키지 제외 목록 및 설치 실행 검사 |

## 발견한 문제와 수정·재검증

| 번호 | 발견한 문제 | 수정 | 재검증 |
|---|---|---|---|
| 1 | 계획 승인과 완료 상태가 세션 전체에 공유됨 | 방문별 계획 파일과 승인 키로 분리 | 계획 재방문, 이전 승인 거부, 중복 승인 테스트 통과 |
| 2 | 로그 이벤트 제거 시 판정 증거가 소실됨 | 독립 증거 요약을 전체 attempt 동안 누적 | 이벤트 폭주 후 mutation/search/spend 보존 통과 |
| 3 | 도구 관리 축소 후 웹 검색 설정 사전 검사가 실행을 차단함 | 실제 완료된 검색과 응답 근거로 판정 | 조사 완료/차단 및 Claude 성공 tool_result 검사 통과 |
| 4 | Claude SDK가 JS CLI 진입점을 native 바이너리로 실행함 | 실제 Node 실행 파일/prefix로 SDK spawn, Windows 래퍼 해석 | fake/실제 CLI 조회, SDK 내장 CLI 없는 설치 환경 통과 |
| 5 | 크기 변경·그래프 전환 후 노드가 잘리거나 작게 보임 | 노드 측정 후 맞춤, 그래프별 Canvas 초기화, 적용 성공 후 복원 완료 기록 | 3개 화면 크기 및 줌 저장/복원·반복 검사 통과 |
| 6 | 모바일에서 라이브러리와 노드 선택이 숨겨짐 | 모바일 그래프 선택/생성/가져오기와 노드 선택 메뉴 | 모바일 선택·역할 지침 입력·저장 통과 |
| 7 | 모바일 실행 영역의 큰 공백, minimap 겹침 | composer flex-basis와 캔버스 높이 조정, 모바일 minimap 숨김 | 스크린샷 및 가로 넘침 검사 통과 |
| 8 | 재열기 후 프로젝트 경로가 초기화됨 | 작업 공간별 대상 경로 저장/복원 | reload 후 경로 동일 검사 통과 |
| 9 | 컴파일된 테스트가 npm에 포함됨 | dist 자체 제외 규칙 생성 | 패키지 내용/설치 검사 통과 |
| 10 | 빠른 그래프 전환 중 입력·노드 선택이 유실됨 | 즉시 busy 적용, 제어 비활성화, 이전 Canvas의 지연 변경 차단 | 생성 직후 이름 입력 및 모바일 노드 선택 반복 검사 통과 |
| 11 | 프로그램 화면 맞춤이 자동 저장을 계속 미룸 | 사용자 gesture의 viewport 변경만 저장 | 노드 이동·줌·저장 검사 통과 |
| 12 | 서버 종료가 승인 대기 계획을 중지 상태로 바꿈 | 활성/예약 실행만 중지하고 대기 문서 보존 | 서버 재시작 후 문서·방문·승인 복원 통과 |
| 13 | crash 시 모델 사용 관측이 늦게 저장되고 마지막 attempt만 비용 판단에 사용됨 | 활동/사용량 변경을 즉시 저장, cycle 전체 사용량으로 판단 | 사용 관측 후 자동 재시작 방지와 crash 수동 재개 통과 |
| 14 | lease 해제 후 orphan PID 정보가 사라져 새 실행 가능 | attempt에 PID와 orphan 상태 보존, 재개/삭제 차단 | 살아 있는 orphan·외부 owner 차단 통과 |
| 15 | 모델 조회 중 Interrupt가 잘못 WAITING_USER로 전환됨 | 취소된 연결을 새 signal로 다시 검증 후 중단 노드 실행 | 조회 중 Stop/Interrupt 및 child 종료 확인 통과 |
| 16 | lease 없는 RUNNING 상태가 계속 남음 | 시작 유예 후 PAUSED로 전환하고 수동 판단 요청 | 자동 비용 사용 없이 상태 복구 통과 |
| 17 | 프런트 타입 오류가 일반 빌드에서 누락됨 | 웹 타입 검사도 build에 포함 | backend/frontend 타입 검사와 GUI 렌더링 통과 |
| 18 | Windows 패키지 검사에서 SIGTERM을 정상 종료로 오인함 | managed launcher의 IPC 종료를 같은 close 경로로 처리 | 설치 패키지 정상 종료 통과; Windows는 CI 실행 대상 |
| 19 | OpenCode 전체 접근에 지원되지 않는 CLI 옵션 사용 | 실제 도움말의 --auto 사용, 읽기 역할에는 적용하지 않음 | native 도움말 대조 및 권한 인자 테스트 통과 |
| 20 | OpenCode/Kilo API의 variant map이 누락됨 | 보고된 variant key만 정규화하고 disabled/옵션 값 제외 | 변형 목록/비밀값 제외 테스트 및 실제 API 옵션 조회 통과 |
| 21 | 워커 강제 종료 직후 젊은 state lock이 30초 동안 재개를 막음 | 종료가 확인된 owner의 잠금 즉시 회수, 회수 요청 직렬화 | 새 abandoned lock 동시 회수와 crash 재개 통과 |
| 22 | heartbeat가 child PID를 놓치면 이전 CLI가 남을 수 있음 | lease와 저장된 attempt PID를 함께 정리하고 crash attempt 기록 | lease childPid를 지운 crash 재개 검사 통과 |
| 23 | 모바일 CSS 다단 배치가 설정을 가로로 밀어 숨김 | 태블릿 2열/모바일 1열 grid 및 세로 스크롤 | 내부 scrollWidth 검사와 실제 설정/지침 입력 통과 |
| 24 | 저장 응답은 성공했는데 대기 표시가 남음 | 표시를 실제 draft dirty와 저장 실패/충돌 상태에 맞춤 | 저장 완료 후 이름/설정 읽기, 삭제, 줌 복원 검사 통과 |

검증 코드도 반복 실행에서 같은 그래프 이름을 누적하는 대신 UUID로 식별하도록 정리했다. API 오류 코드의 예상값을 실제 계약에 맞추고, 비활성화된 모바일 선택기를 조작하지 않도록 제어 상태를 명시했다.

## 실제 CLI 조회 및 검증 범위

코딩/추론 요청 없이 임시 대상 폴더에서 native 모델 API만 호출했고 조회 프로세스를 정리했다.

| CLI | 조회 상태 | 모델 수 | 보고된 추론 옵션 수 |
|---|---|---:|---:|
| Codex | ready | 3 | 17 |
| Claude Code | ready | 4 | 15 |
| OpenCode | ready | 116 | 358 |
| Kilo | ready | 441 | 1,155 |

[실제 조회 요약](../artifacts/verification/native-models.json). 목록 조회 성공은 모든 모델의 실제 할당량·추론 권한을 보증하지 않는다. 코딩 실행·복구 시나리오는 결정적 fake CLI로 검증했으며 실제 모델에 유료 코딩 작업을 보내지 않았다.

플랫폼 종료 차이의 근거는 [Node.js child process 문서](https://nodejs.org/api/child_process.html#subprocesskillsignal), 추론 variant map의 형식은 [OpenCode 모델 문서](https://opencode.ai/docs/models/#custom-variants)를 대조했다.

## 화면 증거와 재현

- [데스크톱 편집기](../artifacts/screenshots/editor-desktop.png)
- [800px 레이아웃](../artifacts/screenshots/layout-narrow.png)
- [390px 레이아웃](../artifacts/screenshots/layout-mobile.png)
- [모바일 노드 편집](../artifacts/screenshots/mobile-controls-verified.png)
- [계획 수정·승인](../artifacts/screenshots/plan-review.png)
- [실행 완료](../artifacts/screenshots/run-complete.png)

~~~sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run smoke
npm run pack:check
npm run pack:smoke
npm audit --omit=dev --audit-level=high
~~~

검증 로그·스크린샷·가짜 실행 데이터는 artifacts 아래에 보존하되 Git/npm 배포에서 제외한다. 저장소의 원래 사용자 세션은 변경하거나 변환하지 않았다.

## macOS 파일 실행기 추가 검증 — 2026-10-14

프로젝트 폴더에 `Agent Graph Studio.app` 실행기를 추가했다. AppKit 창에서 준비 상태를 표시하고 기본 브라우저를 열며, 실행 로그와 종료 버튼을 제공한다. Node.js 24 이상은 별도 설치가 필요하고 실행기는 소스 프로젝트 폴더와 함께 사용한다.

- macOS 네이티브 실행 파일 빌드 및 로컬 서명 성공.
- 실행기 통합 테스트 2/2 통과: 서버 생성·정적 자산 제공·같은 서버 재사용·소유한 서버만 종료, 다른 서비스가 사용하는 포트 거부.
- 실제 앱 실행으로 브라우저의 그래프 편집기 표시 확인. 종료 버튼과 Cmd+Q 각각 실행기·도우미·서버 프로세스 종료 확인.
- 실제 실행 환경은 macOS / Node.js 25.2.1이며, 추가 테스트는 임시 작업 공간을 사용하고 코딩 CLI를 호출하지 않았다. 이전 코어·GUI 전체 검증 횟수와 별도로 기록한다.

[빌드 로그](../artifacts/verification/macos-launcher-build.log), [테스트 로그](../artifacts/verification/macos-launcher-tests.log), [실행 창](../artifacts/screenshots/macos-launcher.png).

~~~sh
npm run build:launcher:mac
npm run test:launcher:mac
~~~

## QA 오류 판정 수정 인수 기준 — 2026-10-14

실제 Kilo QA 로그에서 ID·시간의 `401/403`이 인증 실패로 오인되고, 실행되지 않은 `ls … 2>/dev/null` 호출이 파일 변경으로 오인되는 문제를 재현했다. 수정은 CLI 진단과 일반 출력 분리, 명시적 실패 종류 우선 보존, 호출별 실행 상태 추적, 명령 입력의 따옴표·리다이렉션 구분을 대상으로 한다. 기존 사용자 데이터·승인 기록은 보존하며 임시 작업 공간과 가짜 CLI로 검증한다.

### 구현과 검증 결과

- `SupervisorResult.diagnostics`와 `Completion.failureKind`를 내부 계약에 추가했다. 오류 메시지는 비밀값을 제거하고 각각 최대 2 KiB로 제한하며 최근 이벤트 보존 한도와 별도로 유지한다. 최종 공급자 실패는 종료 코드 0과 완료 표시가 있어도 실행 실패로 처리한다.
- 중지·타임아웃·프로세스 종료 미확인·명시적 권한 오류는 보존한다. 인증은 실제 오류 코드·HTTP 상태·명시적인 실패 진단으로 판정하고, 403만으로는 로그인 필요를 단정하지 않는다. 모델 조회도 같은 판정기를 사용한다.
- 파일 변경은 알려진 CLI 이벤트와 명령 입력에서만 검사한다. 호출 ID로 요청과 결과를 연결해 실행 전 거부를 제외하고, 부분 실패·결과 미확인·완료된 변경은 보수적으로 유지한다. `/dev/null`, 스트림 연결, 따옴표·이스케이프를 구분하며 실제 쓰기가 섞인 명령과 명령 래퍼도 검사한다. QA의 native 읽기 전용 설정은 유지했다.
- macOS / Node.js **24.21.0**에서 코어·통합·CLI 테스트 **93/93** 통과(기존 69개와 추가 24개), GUI **11/11** 통과(기존 9개와 추가 2개). 타입 검사, npm 패키지 내용 검사 및 실제 임시 설치 검증도 통과했다.
- GUI에서 실제 인증 실패의 노드·연결·원인 표시, 중지·브라우저 재로드·수동 재개를 검사했다. 같은 QA 방문의 두 번째 시도로 완료되고 계획·구현·테스트 방문, 승인 참조, 이전 오류 기록이 보존됐다. 오탐 재현 이벤트는 QA를 한 번만 실행한 뒤 최종 승인으로 진행했다.
- 원래 QA 로그 두 개를 읽기 전용으로 재판정했다. 첫 로그는 파일 변경·인증 오탐이 사라졌고, 두 번째 로그는 완료 표시 누락으로 구분됐다. 로그에는 원래 종료 코드가 저장되지 않아 이 재판정은 정상 CLI 종료를 가정하며, 실제 종료 및 복구 경로는 별도의 가짜 CLI 통합 테스트로 검증했다.
- 사용자 작업 공간의 기존 18개 파일은 수정 전후 SHA-256이 동일했다. 기존 시도를 다시 판정해 저장하거나 이전 응답을 자동 승인하지 않았고 실제 모델에 코딩 요청을 보내지 않았다. 저장 데이터는 기존 stateVersion 3을 유지한다.
- macOS 더블클릭 실행기 통합 테스트도 **2/2** 통과했다. 수정된 소스로 빌드·서버 실행·기존 서버 재사용·소유한 서버만 종료하는 동작을 확인했다.

[코어·CLI 로그](../artifacts/verification/qa-core-tests.log), [GUI 로그](../artifacts/verification/qa-gui-tests.log), [설치 패키지 검증](../artifacts/verification/qa-installed-package.log), [실제 로그 재판정](../artifacts/verification/qa-real-log-replay.json), [인증 오류 표시](../artifacts/screenshots/qa-auth-error-context.png), [QA 재개 완료](../artifacts/screenshots/qa-resume-verified.png).

## Windows Node 24 환경 복원 및 실행 수명 수정 — 2026-10-23

Windows x64의 기본 Node.js를 22.20.0에서 **24.22.1 LTS**로 갱신했다. npm은 **11.14.1**이며, `npm ci`로 기존 lockfile의 311개 패키지를 복원했다. 직접 의존성 17개가 선언과 일치하고, 복원 시 audit 결과는 알려진 취약점 0건이었다. 의존성 누락 및 Node 타입 인식 오류는 복원 후 해소되어 TypeScript 설정 변경은 필요하지 않았다.

### 발견한 문제와 수정

- 모델 조회가 PID 종료만 확인하고 반환해 Windows에서 임시 작업 폴더 삭제가 `EBUSY`로 실패했다. 프로세스와 표준 입출력의 `close`까지 제한 시간 안에 기다리도록 수정하고 회귀 테스트를 추가했다.
- ConPTY는 프로세스 종료 후 출력 배출을 마친 다음 종료 이벤트를 보낸다. 이 사이 watchdog이 정상 완료를 timeout으로 오인했다. 프로세스가 이미 종료된 경우 최종 종료 이벤트를 제한된 시간 동안 기다리고, 실제 종료 코드 및 공급자 오류 진단으로 판정하도록 수정했다. Windows ConPTY에서 정상 완료와 종료 코드 0의 인증 실패를 함께 검사한다.
- ConPTY의 네이티브 핸들 때문에 완료·승인 대기 워커가 계속 살아 있어 다음 실행이 거부됐다. 런타임의 상태·로그 저장과 lease 해제가 끝나고 IPC 전송이 배출되면 단일 세션 워커를 종료하도록 수정했다.
- 인증 대기로 전환한 직후 Stop을 누르면 종료 중인 워커에 중지 요청이 남아, 수동 재개한 새 워커가 다시 STOPPED로 전환됐다. 대기 상태 워커의 종료를 확인한 뒤 중지·중단 요청을 처리하며, 종료 확인 한도를 넘기면 재시도를 요청하고 새 제어 요청을 남기지 않는다. 기존 QA 인증·Stop·동일 방문 재개 시나리오로 검증했다.
- Windows의 PTY 출력 지연을 고려해 테스트의 세션 대기 한도와 진행 갱신 검사의 시간 여유를 조정했다. 갱신 검사에서 단계 제한은 여전히 1,200ms 작업보다 짧아 실제 진행 갱신을 요구한다. 실제 실행의 timeout 기본값은 변경하지 않았다.

### 최종 검증 결과

| 검사 | 결과 | 증거 |
|---|---|---|
| Node 24에서 의존성 복원 | 통과, audit 0건 | npm ci (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-install.log`) |
| 백엔드·프런트엔드 타입 검사 | 통과 | 타입 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-typecheck.log`) |
| 코어·웹 빌드 및 코어·통합·공개 CLI | **95/95 통과** | 빌드·테스트 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-tests.log`) |
| Chromium GUI | **11/11 통과** | GUI 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-e2e.log`) |
| 공개 CLI 도움말 | 통과 | smoke (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-smoke.log`) |
| npm 패키지 내용 | 통과, 31개 파일 | 패키지 목록 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-pack-check.log`) |
| 임시 설치한 npm 패키지 | CLI·웹 자산·새 저장소·4종 모델 API·정상 종료 통과 | 설치 검사 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/windows-node24-pack-smoke.log`) |

실행과 모델 조회는 결정적 가짜 CLI를 사용했다. 이번 검증은 Windows 환경에서 수행했으며 macOS 네이티브 실행기 빌드는 포함하지 않는다. 빌드는 성공했고, 약 611kB의 웹 JavaScript 번들에 대한 크기 경고가 남는다. 로그는 기존 정책대로 Git/npm 배포에서 제외하는 `artifacts/verification`에 보존한다.

## 실제 Kilo Auto Free로 웹 2048 생성 및 검증 (2026-10-23)

위의 결정적 가짜 CLI 검사와 별도로, 로컬 Studio에서 실제 Kilo 네이티브 CLI 7.8.15에 연결해 445개 모델을 조회하고 `kilo/kilo-auto/free`를 지정했다. 승인한 계획으로 `experiments/kilo-2048-web-20261023`에 웹 2048을 생성했다. 독립 테스트에서 발견한 무효 이동의 타일 생성, 저장 데이터 검증, 첫 방문의 새 게임 버튼, 승리 후 게임 오버 표시 오류는 Kilo가 수정했다.

생성한 게임의 테스트 13/13, 별도 규칙 검사 10/10 및 독립 기준 구현과의 이동 비교 4,000건이 통과했다. 실제 브라우저에서 방향키, 새 게임, 저장 복원, 390px 렌더링을 확인했다. 터치는 이벤트 단위 테스트로 검사했으며 물리 장치에서의 스와이프 검증은 포함하지 않는다.

게임 검증은 통과했지만 **전체 자동 실행 그래프는 PAUSED**다. 구현 방문은 성공했고, 테스트 단계에서 Auto Free의 연속 잘못된 write 인자로 정지했으며 피드백을 담은 중단 분석도 초기 PTY 출력 120초 timeout으로 정지했다. QA 검토·최종 승인 노드는 실행되지 않았다. 실제 세션 ID는 `1fbcfb7e-0526-45f2-a45b-034d5c85fef1`이다.

상세 재현 방법, 모델·상태 기록, 실패 이력, 자동 검사 결과, 데스크톱·모바일 화면은 실제 실행 보고서 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/kilo-2048/VERIFICATION.md`)에 보존했다. 현재 실행 요약은 Kilo의 중첩 모델·토큰 필드를 반영하지 못하므로 실제 라우팅은 원시 CLI 로그를 기준으로 별도 확인했다.

## 실제 Auto Free 전체 루프 복구 및 최종 승인 (2026-10-23)

후속 진단에서 모델의 빈 write 인자, 무료 제공자의 용량 부족, Windows ConPTY의 긴 JSON 전송 손상, PowerShell의 npm.ps1 실행 정책, 요구사항 증거 형식 누락이 서로 다른 원인으로 확인됐다. Windows Kilo에는 stdout/stderr를 별도로 처리하는 파이프 전송을 적용했고, 실제 모델·토큰 기록과 원인별 제한된 재시도, 모든 REQ별 보고서 형식 보완을 추가했다. 실제 실패 증거에 대한 FAIL/REJECTED와 요구사항 완료 기준은 유지했다.

최신 실제 세션 `198e9de6-d065-415d-89cb-33d65e20a12c`은 **SUCCESS**다. 기승인 계획을 사용한 구현 → 테스트 PASS → QA APPROVED → 최종 APPROVED가 각각 첫 시도에 완료됐다. 모든 요청은 `kilo/kilo-auto/free`이며 테스트·QA·승인 각각에 원래 요구사항 8개의 SATISFIED 증거가 있다. 정상 네이티브 최종 응답과 Studio 기록의 정확한 일치도 확인했다.

타입 검사·빌드, 코어/서버/CLI **105/105**, GUI **11/11**, 패키지 **32개 파일** 검사가 통과했다. 게임 테스트는 Auto Free가 추가한 타일 4 생성·게임 오버 재시작 검사를 포함해 **15/15**, 별도 규칙 검사 **10/10** 및 네 방향 독립 비교 **4,000건**이 통과했다. 호스트 실행 정책을 변경하거나 저장된 성공 상태를 직접 조작하지 않았다.

복구 및 전체 루프 검증 보고서 (현재 확인 불가: 당시 로컬 자료 `../artifacts/verification/kilo-2048-recovery/VERIFICATION.md`)에 원인·회귀 검사·이전 중지 시도·최종 실제 상태·승인 화면을 보존했다. 앞 절의 PAUSED 및 모델/토큰 누락은 최초 검증 당시 상태이며 이번 후속 수정으로 보완했다.

## 검증 자료 보존 정책

`npm run verify:platform`과 `npm run verify:browser`는 검사별 stdout/stderr와 `summary.json`을 `artifacts/verification/<suite>-<platform>-<arch>/`에 기록한다. 요약은 커밋 SHA, 작업 트리 변경 여부, 실행 환경, 명령, 시작/종료 시각, 종료코드, 성공·실패·미실행 상태를 포함한다. 앞 검사가 실패하면 뒤 검사는 미실행으로 남고 최초 실패 종료코드를 반환한다.

CI는 성공·실패와 관계없이 OS·커밋·실행 ID·회차별 artifact를 90일 보존한다. 브라우저 artifact에는 스크린샷과 실패 trace도 포함한다. Git에는 결과 요약과 해당 Actions 실행 링크를 기록하며, 만료 후에도 요약은 남지만 원본 artifact는 다시 내려받을 수 없을 수 있다. 기존 `../artifacts/` 링크는 당시 로컬 기록으로 공유 저장소의 영구 증거가 아니다.

실제 CLI를 사용한 과거 기록은 실행 당시 문서이며, fake CLI 자동 검증과 구분한다. 사용자 홈의 실행 세션·인증 설정·실제 모델 로그는 수집하지 않는다.

## 실행 환경·레거시·검증 보존·프런트엔드 정리 — 2026-10-23

검증 대상 구현 커밋: `ccc44861e7f6b51d88f96315f6b7e73b158030cd`. [GitHub Actions 실행](https://github.com/youwonsock/custom-agent-loop-system/actions/runs/39915902762). 로컬 검증 커밋 `b58f46b88b475840d7242061ea1bb8c398ce1eca`와 Git tree `336d4acc821836825e960a0cad99c114f24c7652`가 동일하다. 로컬과 CI에서 같은 구현을 검사했다.

### 변경 내용

- 현재 lockfile로 로컬 설치를 복원했다. macOS 실행기는 manifest/lockfile 해시, Node major·ABI, OS·아키텍처, 직접 의존성 버전과 node-pty 로딩을 확인한다. 초기화는 프로젝트 잠금으로 직렬화하고, 설치 실패·취소 시 성공 정보를 남기지 않는다. 기존 서버 재사용과 소유한 서버만 종료하는 동작을 유지했다.
- 이전 desktop-app·native 빌드 산출물과 미사용 Tetris 데모 29개 추적 파일, 로컬 VS Code 확장 잔재를 제거했다. 현재 macOS 실행기·가짜 CLI fixture·Kilo 2048 예제는 유지했다.
- 플랫폼/브라우저 검증 명령, 실패 시에도 남는 결과 요약과 로그, OS·커밋·회차별 90일 CI artifact를 추가했다. 명시적인 실패와 실행 파일 누락이 성공으로 보고되지 않는 회귀 검사를 포함한다.
- App.tsx를 2,138줄에서 220줄로 줄이고 화면과 상태 hook을 분리했다. 화면 전환 동안 상태 소유자를 유지하며, 화면·Markdown을 지연 로딩하고 비활성 로그 요청을 취소한다. 지연 로딩 오류는 화면에 표시하고 새로고침으로 복구한다.

### 검증 결과

| 검사 | 로컬 macOS arm64 / Node 25.2.1 | Node 24 CI |
|---|---|---|
| 타입 검사·빌드 | 통과 | Windows·Linux·macOS 통과 |
| 코어·서버·CLI | 104 통과, Windows 전용 1 제외, 실패 0 | Windows 105 통과/제외 0; Linux·macOS 각각 104 통과/Windows 전용 1 제외 |
| 실행 환경·검증 기록 도구 | 8/8 통과 | Windows·Linux·macOS 각각 8/8 통과 |
| macOS 실행기 빌드·통합 | 4/4 통과 | macOS 4/4 통과 |
| Chromium GUI | 15/15 통과 | Linux 15/15 통과 |
| 패키지 내용·설치 smoke | 40개 파일, 모든 지연 로딩 자산 응답까지 통과 | Windows·Linux·macOS 통과 |
| 운영 의존성 audit | 취약점 0건 | Windows·Linux·macOS 각각 취약점 0건 |

Actions 실행은 네 작업 모두 성공했고, OS별 플랫폼 artifact 3개와 브라우저 artifact 1개의 업로드를 확인했다. 각 artifact 이름에 OS·구현 SHA·실행 ID·회차가 포함되며, 만료 예정일은 2027-01-21이다.

브라우저 검사는 기존 11개 시나리오에 화면 전환 중 저장·연결 입력 보존, SSE 단일 구독 및 로그 polling 취소, 지연 로딩 실패 복구, 초기 JS 요청 용량 검사를 추가했다. 기존 계획 승인 시나리오에서도 화면 전환 후 편집 중인 문서 보존을 확인한다. 로컬에서 기본 그래프 화면의 실제 JS 응답 합계는 압축 전 **442,952 bytes**로, 이전 단일 번들 610.60 kB보다 약 27% 줄었다. 개별 청크도 500,000 bytes 이내이며 경고 한도는 올리지 않았다.

실제 모델 작업이나 새 인증 요청은 수행하지 않았다. REST/SSE 계약, 공개 CLI 옵션, 그래프·연결·세션 버전과 localStorage 키, 의존성 lockfile 및 코어 실행 엔진은 변경하지 않았다. 네이티브 macOS 창의 수동 조작은 이번 검증에 포함하지 않으며, Swift 빌드와 실제 Node 실행기/서버 통합을 검사했다.
