# Agent Loop Orchestrator for VS Code

버전 3.4.1은 플랫폼별 VSIX에 실행 가능한 Agent Loop 코어와 `node-pty` 네이티브 바이너리를 포함합니다. 별도 소스 저장소나 `dist` 경로는 필요하지 않지만 실행에는 Node.js 18 이상과 인증된 에이전트 CLI(OpenCode, Kilo, Codex, Claude) 중 하나 이상이 PATH에 설치되어야 합니다. VSIX를 직접 빌드할 때는 패키징 도구 호환성을 위해 Node.js 20.18.1 이상을 사용하십시오.

## 설치

```powershell
npm ci
npm --prefix vscode-extension ci
npm --prefix vscode-extension run package
code --install-extension agent-loop-vscode-win32-x64-3.4.1.vsix --force
```

`npm run package`는 현재 OS/CPU용 target VSIX를 만듭니다. 다른 플랫폼용 배포물은 해당 플랫폼에서 패키징하십시오.

## UI

- Models: `Models` 버튼이나 `Agent Loop: Discover Models` 명령을 명시적으로 실행했을 때만 CLI를 호출해 모델을 검색합니다.
- Stages: 파일 기반 역할·단계 구조를 확인합니다.
- Tools: 모든 에이전트에 공통인 Web Search와 MCP 서버를 설정합니다.
- Plan Review: 세 개의 전체 계획 문서를 중앙 Markdown 미리보기로 열고 승인·수정합니다.
- Session dashboard: aggregate domain event에서 파생한 현재 단계·역할·진행 요약·다음 허용 행동·정지 이유와 cycle/workflow-step/attempt/recovery 잔여 예산을 표시합니다.
- Domain Timeline: raw terminal이나 별도 history 파일이 아니라 bounded aggregate event를 최신순으로 표시합니다.

기본 데이터는 VS Code 전역 저장소에 저장됩니다. `agentLoop.rootDir`은 데이터 위치를 직접 관리해야 할 때만 설정하고, 워크스페이스 또는 대상 프로젝트 내부를 가리키지 않아야 합니다. 예를 들어 `rootDir="."`은 거부됩니다. 개발 중 외부 코어를 실행하려면 `agentLoop.orchestratorScript`를 지정하십시오.

## Workspace Trust, 접근과 비밀정보

확장은 외부 Node.js/에이전트 CLI 프로세스를 실행하므로 신뢰하지 않은 워크스페이스와 가상 워크스페이스에서는 비활성화됩니다. 신뢰 여부를 결정하기 전에는 데이터 루트 초기화, SecretStorage 마이그레이션, 세션 복구, 모델 검색을 수행하지 않습니다.

기본 `Ask when needed` 모드는 프로젝트 밖의 경로가 계획에 나타나면 구현 전에 구체적인 접근 승인을 요청합니다. `Full access`는 해당 세션 전체에만 적용됩니다. Stop은 최대 8초 동안 acknowledgement와 안전한 상태 전환을 기다린 뒤 필요한 경우에만 코어 프로세스를 종료합니다.

MCP environment/header 값은 데이터 루트별 SecretStorage namespace에 저장되고 설정 파일에는 `${secret:...}` 참조만 기록됩니다. `${env:NAME}` 참조도 지원합니다. 비밀은 코어 시작 프로세스에 한 번만 전달되고 즉시 환경에서 제거되며 PTY 로그와 assistant text에서 redaction됩니다. 인증 헤더·환경값·URL 자격 증명이 있는 원격 MCP 서버는 HTTPS를 사용해야 하며, HTTP 예외는 localhost뿐입니다.

## 파일 기반 커스텀

루프 그래프 UI는 제공하지 않습니다. 전역 데이터 루트의 다음 파일을 수정하면 새 세션에만 반영됩니다.

- `agent_roles.json`
- `agent_loop.json`
- `loop_config.json`

동일 디렉터리에 JSON schema도 자동 준비됩니다. 역할과 단계 이름은 추가할 수 있지만 실행 동작은 내장 executor와 completion contract enum에 한정됩니다.

## 상태 원칙

- `PAUSED`: 토큰을 사용한 반복 작업이 수렴하지 않아 비용 차단이 필요한 경우
- `RECOVERING`: 토큰 사용 전의 일시적 transport 장애
- `WAITING_USER`: 계획·권한·인증 등 사용자 결정 필요
- `STOPPED`: 명시적 Stop 또는 정상 VS Code 종료
- `BLOCKED`: orphan/소유권 안전을 확인할 수 없어 실행 금지

정상 deactivate는 활성 세션을 병렬로 graceful `STOPPED` 처리하며, 비정상 종료로 `RUNNING`이 남은 경우에만 lease를 검증해 자동 복구합니다.

자세한 실행 계약과 보호장치는 상위 [README](../README.md)를 참고하십시오.
