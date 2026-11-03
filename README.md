# Agent Graph Studio

[English](README.en.md)

로컬 코딩 CLI를 에이전트 그래프로 연결하는 웹 앱입니다. 브라우저에서 역할과 성공·실패 경로를 편집하면, 내 컴퓨터의 Node.js 워커가 Codex·Claude Code·OpenCode·Kilo를 실행합니다. 화면은 한국어와 영어를 제공합니다(상단 언어 버튼). 실행 사유, 모델 프롬프트, `docs/` 문서는 한국어입니다.

## 시작

Node.js 24 이상과, 설치·로그인된 코딩 CLI가 하나 이상 필요합니다.

```sh
npm ci
npm start
```

앱은 `http://127.0.0.1:4317`에서 열립니다. 브라우저를 닫아도 실행은 계속되고, 서버는 터미널에서 Ctrl+C로 끕니다.

```sh
node dist/src/server/cli.js ui --no-open
node dist/src/server/cli.js ui --port 4320 --root /absolute/path/to/workspace
```

- npm 패키지로 설치했다면 `agent-loop ui`로 실행합니다.
- 데이터는 `~/.agent-loop/graph-workspace`에 저장합니다.
- 이전 버전의 데이터는 읽거나 변환하지 않습니다. 파일은 디스크에 남지만 목록에 나타나지 않습니다.
- macOS 실행기: `npm run build:launcher:mac`으로 **Agent Graph Studio.app**을 만들어 더블클릭합니다. Xcode Command Line Tools가 필요하고, 로그인 셸의 Node.js를 씁니다.

## 검증 범위

- **Claude Code**(Haiku 5.5)만 실제 모델로 전 과정을 검증했습니다.
- Codex와 Kilo는 작은 시나리오만 통과했습니다.
- OpenCode는 무료 모델로 끝까지 간 적이 없어 미검증입니다.

자세한 결과는 [검증 기록](docs/VERIFICATION.md)에 있습니다.

## 격리

**Claude 실행에는 기본으로 OS 격리가 없습니다.** 앱이 넘기는 도구 허용 목록은 무인 실행을 위한 것이고, `node`를 허용하므로 임의 코드를 막지 못합니다. 신뢰할 수 있는 프로젝트에서 실행하고, Claude Code의 Bash 샌드박스를 함께 쓰세요.

그래프 설정의 **Claude 명령 VM 실행**을 켜면 Claude의 Bash 명령이 Kilo와 같은 VM에서 실행됩니다.

- 훅이 모든 도구 호출을 먼저 보고, 파일 도구는 대상 프로젝트 안으로 제한하며, 나머지 도구는 거부합니다.
- VM에는 네트워크가 없습니다. 병렬 작업은 쓸 수 없고, 의존성도 VM 안에서 설치할 수 없습니다.

| 환경 | 격리 방식 |
| --- | --- |
| Apple Silicon macOS 26 | Apple container 1.6.0의 VM |
| Linux | rootless Podman 컨테이너. 호스트 커널을 공유하므로 VM보다 경계가 약합니다 |

`container` 또는 `podman`을 설치한 뒤 `npm run sandbox:prepare`를 실행합니다. 네트워크와 8GiB 이상의 여유 공간이 필요합니다. 준비되지 않았으면 Kilo 노드는 모델 호출 전에 멈춥니다. 자세한 내용은 [격리 설정](docs/AUTONOMOUS_WORKFLOW.md#kilo-프로그램-내부-io-격리)에 있습니다.

## 그래프 만들기

1. 기본 상호검증 루프를 복제하거나 새 그래프를 만듭니다.
2. 노드를 골라 이름·역할·지침과 실행 유형을 편집합니다.
3. 성공·실패 핸들을 끌어 노드를 연결합니다.
4. **CLI 연결**에서 서비스를 등록하고 대상 프로젝트의 모델을 조회합니다. **설치된 CLI 찾기**를 누르면 PATH에서 CLI 위치를 찾아 줍니다.
5. 그래프 공통 모델을 고릅니다. 노드마다 다른 연결과 모델을 지정할 수도 있습니다.
6. 목표와 대상 프로젝트를 입력하고 실행합니다.

노드 유형은 계획·구현·테스트·검토·최종 승인·중단 처리이며, 노드는 한 번에 하나씩 실행합니다.

구현 노드에는 **병렬 작업**을 2~4개 지정할 수 있습니다.
- 첫 방문에서 작업마다 별도 Git 체크아웃에서 동시에 실행하고, 결과를 커밋하지 않은 변경으로 합칩니다.
- 이어서 일반 구현 시도가 마무리하며, 판정은 이 시도를 기준으로 합니다.
- 커밋하지 않은 변경이 있거나, Git 저장소가 아니거나, Kilo에서 대상 범위 보호를 켰으면 한 번의 시도로 실행합니다.

모델은 등록한 연결에서 조회에 성공한 것만 고를 수 있습니다. 앱은 다른 모델로 자동으로 바꾸지 않으며, API 키·MCP·스킬 같은 설정은 각 CLI에서 관리합니다.

## 자율 제작

**↻ 자율 제작 그래프**는 무인 실행용입니다.
- 계획 하나를 자동으로 고릅니다.
- `.agent-graph/verification.json`의 검사를 고정합니다.
- 검사 실패는 구현으로 돌려보내 정해진 횟수 안에서 고칩니다.

`SUCCESS`의 조건:
- 모든 필수 요구사항에 대한 증거가 있어야 합니다.
- 실제로 실행한 테스트가 성공해야 합니다.
- 최종 승인을 받아야 합니다.

기존 프로젝트에도 쓸 수 있습니다. 프로젝트에 자체 `test` 스크립트가 있으면 덮어쓰지 않습니다. 자세한 내용은 [자율 실행 안내](docs/AUTONOMOUS_WORKFLOW.md)와 [성공·실패·재시도 조건](docs/EXECUTION_CONDITIONS.md)에 있습니다.

## 실행 한도

| 한도 | 설명 |
| --- | --- |
| 전체 시간·전체 시도 | 다 쓰면 세션을 `PAUSED`로 멈춥니다 |
| 도구 실행 제한 | 자율 그래프는 기본 5분입니다. 테스트가 긴 프로젝트는 늘리세요 |
| 금액 한도 | CLI가 보고한 비용을 시도 사이에 확인합니다. 한 시도가 한도를 넘을 수 있고, 비용을 보고하지 않는 Codex에는 쓸 수 없습니다 |

반복 한도를 다 쓴 뒤의 추가 자동 복구는 무료로 확인된 모델에만 적용합니다. 유료이거나 가격을 모르는 모델은 멈추고 확인을 기다립니다.

## 실행 상태

| 상태 | 뜻 |
| --- | --- |
| `RUNNING` | 진행 중 |
| `WAITING_USER` | 계획 승인, 경로 접근, 인증, 환경 문제 등 사용자 결정이 필요함 |
| `RECOVERING` | 무료 모델의 추가 복구를 예약함 |
| `PAUSED` | 한도를 다 썼거나 성공 조건을 채우지 못함. 확인 후 재개 |
| `STOPPED` | 사용자가 중지함 |
| `BLOCKED` | 프로세스나 격리 증거를 확인할 수 없어 실행을 막음 |
| `SUCCESS` | 요구사항 증거, 현재 테스트, 최종 승인을 모두 통과함 |
| `FAILED` | 처리하지 못한 런타임 오류 |

## CLI

```sh
agent-loop init
agent-loop graphs
agent-loop models --connection CONNECTION_ID --target /absolute/project
agent-loop run --graph GRAPH_ID --goal "목표" --target /absolute/project
agent-loop resume --session SESSION_ID
agent-loop verify-node-tests --target /absolute/project
```

`--root`로 GUI와 같은 저장 영역을 지정할 수 있습니다.

## 개발

```sh
npm run verify:platform   # 포맷, 타입, 단위 테스트, 패키지 검사
npx playwright install chromium
npm run verify:browser    # 브라우저 시나리오
npm run verify:vm         # macOS에서 실제 VM 테스트
```

- **가짜 CLI:** 테스트는 네 CLI의 프로토콜을 흉내 내는 가짜 CLI를 쓰므로 모델 비용이 들지 않습니다.
- **실제 모델 회귀:** `node scripts/real-cli-regression.js claude|codex|opencode|kilo`로 따로 실행합니다.
- **골든 파일:** `test/golden/`은 프롬프트와 CLI 인자를 고정합니다. 의도한 변경일 때만 `UPDATE_GOLDEN=1 npm test`로 갱신합니다.
- **VM 결과:** CI는 macOS VM을 돌릴 수 없습니다. 실행·격리 코드를 바꾼 PR은 본문에 `verify:vm N/N @ <커밋>`을 적어야 합니다.
- **Seatbelt 검사:** nodejs.org의 공식 Node 24 빌드가 필요하며, Homebrew Node에서는 건너뜁니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [자율 실행](docs/AUTONOMOUS_WORKFLOW.md) | 자율 그래프의 준비, 검증 계약, 격리 |
| [실행 조건](docs/EXECUTION_CONDITIONS.md) | 성공·실패·재시도 조건과 기본 한도 |
| [아키텍처](docs/ARCHITECTURE.md) | 코드를 고치는 사람을 위한 내부 구조 |
| [용어 사전](docs/GLOSSARY.md) | 용어와 제한값 |
| [작업 현황](docs/STATUS.md) | 현재 상태, 남은 위험 |
| [검증 기록](docs/VERIFICATION.md) | 최신 검증 결과. 이전 기록은 `docs/verification/` |

## 라이선스

[MIT](LICENSE)
