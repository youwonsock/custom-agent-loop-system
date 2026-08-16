# Agent Loop Orchestrator for VS Code

버전 4.0.0 확장은 플랫폼별 VSIX에 v4 Agent Loop 코어와 `node-pty` 바이너리를 포함합니다.
실행에는 Node.js 18 이상과 인증된 provider CLI(OpenCode, Kilo, Codex, Claude) 중 하나 이상이
PATH에 필요합니다.

## 설치

```powershell
npm ci
npm --prefix vscode-extension ci
npm --prefix vscode-extension run package
code --install-extension vscode-extension\agent-loop-vscode-win32-x64-4.0.0.vsix --force
```

## v4 동작

- 코어가 `agents.json`, `tasks.json`, `workflow.json`을 compile하고 run에 snapshot합니다.
- 확장은 `run_projection.json`과 version 4 session index만 읽습니다.
- 계획 승인, 접근 승인, 재개, Stop, Interrupt는 versioned core command로 요청합니다.
- 확장은 aggregate, control queue, checksum 또는 WAL을 직접 작성하지 않습니다.
- 계획 승인은 별도 node이므로 승인 후 planning provider가 다시 실행되지 않습니다.
- provider permission 대기는 현재 activation에 연결되고 승인 후 새 attempt로 재개됩니다.

UI는 모델 선택, Agent/Task/Workflow 구조 확인, 공통 도구 설정, 계획 검토, session 상태와 domain
event timeline을 제공합니다. 그래프 편집과 구형 3.x 세션 migration은 제공하지 않습니다.

## 정의 파일

전역 config root의 다음 파일은 새 run에만 반영됩니다.

- `agents.json` / `agents.schema.json`
- `tasks.json` / `tasks.schema.json`
- `workflow.json` / `workflow.schema.json`
- `loop_config.json` / `loop_config.schema.json`

기본 데이터는 VS Code global storage에 저장됩니다. `agentLoop.rootDir`을 직접 설정할 때는 대상
프로젝트 밖의 절대 경로를 사용해야 합니다. 외부 개발 코어를 사용할 때만
`agentLoop.orchestratorScript`를 지정하십시오.

## 보안

확장은 외부 프로세스를 실행하므로 untrusted/virtual workspace에서 비활성화됩니다. MCP secret은
데이터 루트별 SecretStorage namespace에 저장되고 config에는 참조만 남습니다. `Full access`는
현재 OS 사용자 권한의 비격리 모드이므로 별도 확인을 요구합니다.

자세한 계약은 상위 [README](../README.md)와 [security model](../docs/SECURITY_MODEL.md)을
참고하십시오.
