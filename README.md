# Agent Graph Studio

로컬 코딩 CLI를 에이전트 그래프로 연결하는 독립 웹 앱입니다. 브라우저에서 역할과 성공·실패 경로를 편집하고, 내 컴퓨터의 Node.js 워커가 Codex·Claude Code·OpenCode·Kilo를 실행합니다. VS Code나 VSIX는 필요하지 않습니다.

## 시작

Node.js 24 이상과 사용할 코딩 CLI의 설치·인증이 필요합니다.

macOS에서는 프로젝트 폴더의 **Agent Graph Studio.app**을 더블클릭해 실행할 수 있습니다. 실행기가 lockfile·Node 실행 환경·설치된 패키지를 확인하고 필요하면 패키지를 다시 설치한 뒤 빌드하고 브라우저를 엽니다. 동시에 실행해도 프로젝트 초기화는 한 번에 하나씩 진행합니다. 실행기 창의 **종료** 버튼 또는 Cmd+Q로 서버를 종료합니다. 이미 터미널에서 실행한 서버가 있으면 그 서버를 재사용하며, 실행기를 종료해도 기존 서버는 중지하지 않습니다.

앱 실행기를 재생성하려면 macOS에서 Xcode Command Line Tools를 설치하고 `npm run build:launcher:mac`을 실행합니다. 실행기 파일은 소스 프로젝트 폴더와 함께 사용하며 Node.js 런타임을 포함하지 않습니다. 실행 로그는 `~/Library/Logs/AgentGraphStudio/launcher.log`에 기록됩니다.

터미널에서 실행할 때는:

```sh
npm ci
npm start
```

앱은 `http://127.0.0.1:4317`에서 실행되며 브라우저를 엽니다. 브라우저를 닫아도 작업은 계속됩니다. 서버를 종료하려면 터미널에서 Ctrl+C를 누릅니다.

```sh
node dist/src/server/cli.js ui --no-open
node dist/src/server/cli.js ui --port 4320 --root /absolute/path/to/workspace
```

npm 패키지 설치 후에는 `agent-loop ui`로 실행합니다. 기본 저장 영역은 `~/.agent-loop/graph-workspace`입니다. 이전 버전의 설정과 세션은 읽거나 자동 변환하지 않습니다.

## 그래프 만들기

1. 기본 상호검증 루프를 복제하거나 새 그래프를 만듭니다.
2. 노드를 선택해 이름·역할·지침과 실행 유형을 편집합니다.
3. 성공·실패 핸들을 드래그해 연결합니다. 속성 패널의 다음 단계 선택기도 사용할 수 있습니다.
4. CLI 연결 화면에서 서비스 종류, 이름, 실행 파일을 등록하고 대상 프로젝트의 모델을 조회합니다.
5. 그래프의 공통 모델을 선택합니다. 필요한 노드는 공통 설정 사용을 해제하고 다른 연결·모델을 지정합니다.
6. 원래 목표와 대상 프로젝트를 입력하고 그래프를 실행합니다.

노드 유형은 계획·구현·테스트·검토·최종 승인·중단 처리입니다. 첫 버전은 순차 실행과 성공·실패 분기, 순환을 지원합니다. 병렬 실행·합류·범용 조건식은 지원하지 않습니다.

초안은 자동 저장됩니다. 미완성 연결도 저장할 수 있지만 실행 전에는 구조와 모델을 검증합니다. 다른 창에서 같은 그래프를 바꾸면 현재 초안을 보존하고 저장 충돌을 표시합니다. 초안을 새 그래프로 저장하거나 서버 버전을 다시 읽을 수 있습니다. 그래프 JSON 가져오기는 새 ID로 생성합니다.

## 로컬 서비스와 모델

전체 CLI 자동 스캔, 수동 모델 ID 입력, 고정 대체 모델 목록은 없습니다. 사용자가 등록한 연결에서 조회에 성공한 모델만 선택하고 실행합니다.

| 서비스 | 모델 조회 |
|---|---|
| Codex | 로컬 app-server `model/list` |
| Claude Code | 설치된 실행 파일을 지정한 SDK `supportedModels()` |
| OpenCode / Kilo | 로컬 서버 `/provider`의 연결된 공급자 모델 |

조회와 실행은 같은 CLI와 대상 프로젝트를 사용합니다. 실행·재개 전에 모델을 다시 확인합니다. 조회 실패, 인증 필요, 빈 목록, 지원되지 않는 프로토콜은 구분해 표시하며 자동으로 다른 모델을 선택하지 않습니다. 조회 성공이 실제 모델 권한·할당량을 보장하지는 않습니다.

API 키, MCP, 웹 검색, 스킬, 훅, 플러그인 설정은 해당 CLI에서 관리합니다. 앱은 자격증명이나 도구 설정을 생성·주입하지 않습니다. 역할별 접근 제한과 완료 판정은 오케스트레이터가 관리합니다.

## 실행과 승인

각 실행은 그래프 revision, 모델 지정, CLI 연결 정의를 snapshot으로 저장합니다. 실행 중 라이브러리를 편집해도 해당 세션은 바뀌지 않습니다.

노드는 방문할 때마다 새 방문 ID를 부여받습니다. 순환해서 계획 노드로 돌아오면 새 계획을 생성하고 새 승인을 받습니다. 재시도·승인 대기·재개는 동일 방문을 이어갑니다. 계획 문서는 앱 안에서 전체 내용을 읽고 수정·승인할 수 있으며, 다른 방문이나 이전 문서 revision에 대한 승인 요청은 거부됩니다.

기본 완료 조건은 정상 종료와 assistant 응답 마지막 독립 행 `[PHASE_DONE]`입니다. 테스트는 `VERDICT: PASS|FAIL`, 검토·승인은 `APPROVED|REJECTED` 및 고정 `REQ-###` 요구사항 증거를 검사합니다. 프롬프트 echo나 도구 입력은 assistant 완료로 인정하지 않습니다. 검색을 명시한 목표는 실제 완료된 검색 이벤트와 URL 근거가 필요합니다.

- `RUNNING`: 진행 중인 워커가 세션을 소유합니다.
- `WAITING_USER`: 계획·경로·인증·모델 설정 등 사용자 결정이 필요합니다.
- `RECOVERING`: 모델 사용이 관측되지 않은 일시적 실패의 복구를 예약합니다.
- `PAUSED`: 실행 예산이나 수렴 한도를 소진했습니다. 확인 후 수동 재개합니다.
- `STOPPED`: 사용자가 명시적으로 중지했습니다.
- `BLOCKED`: 프로세스 종료·소유권을 확인할 수 없어 새 실행을 차단합니다.
- `SUCCESS` / `FAILED`: 완료 또는 실패입니다.

실행 화면에서 방문·attempt·진행 시각·계획·응답·로그를 확인하고 중지, 중단 분석, 재개를 수행합니다. 읽던 로그는 새 출력이 와도 자동으로 아래로 이동하지 않습니다. 파일 변경·검색·모델 사용 증거는 로그 보존 크기와 별도로 누적합니다.

실행 오류에는 노드와 CLI 연결 이름, 실제 원인이 함께 표시됩니다. 인증 실패는 CLI의 오류 진단으로 판정하며 일반 응답·도구 출력·ID·시간 값은 인증 판정에 사용하지 않습니다. 인증 오류나 응답 미완료로 중단된 QA를 재개하면 같은 방문에서 새 시도를 시작하고 이전 단계와 승인 기록은 유지합니다.

## CLI와 데이터

```sh
agent-loop init
agent-loop graphs
agent-loop models --connection CONNECTION_ID --target /absolute/project
agent-loop run --graph GRAPH_ID --goal "목표" --target /absolute/project
agent-loop resume --session SESSION_ID
```

`--root`를 사용하면 GUI와 CLI가 같은 저장 영역을 공유합니다. 그래프는 version 2, 연결 저장소는 version 1, 실행 상태는 stateVersion 3입니다. 소유권 잠금·heartbeat와 파일 기반 제어 큐로 중복 실행과 Stop/Interrupt 요청 손실을 방지합니다.

## 개발과 검증

```sh
npm run verify:platform
npm run verify:browser

# 개별 검사
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run coverage
npm run smoke
npm run pack:check
npm run pack:smoke
```

빌드는 코어와 웹 정적 자산을 함께 생성합니다. 모델 조회와 실행 테스트는 네 CLI의 프로토콜을 구현한 결정적 가짜 CLI를 사용해 모델 비용 없이 검증합니다. 실제 설치된 CLI의 목록 조회도 별도로 검증합니다.

구현 목표와 실제 증거는 [인수 기준](docs/IMPLEMENTATION_PLAN.md)과 [검증·수정 기록](docs/VERIFICATION.md)에 기록합니다. CI는 Windows·Linux·macOS 코어 검사와 Linux 브라우저 시나리오를 수행합니다.
