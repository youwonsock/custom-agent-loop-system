# v8 AI Agent 하네스 신뢰성 현황

이 문서는 제품 소유 TypeScript 코어와 Windows Electron 운영 콘솔, 코어 검증 증거를 포함한
8.0.0 구현 결과를 기록합니다. 구 세션과 VS Code 전역 데이터는 변환하지 않으며 현재 계약과 맞지 않는 프로필은 자동 복구하지 않습니다. 설정·인증정보·프로젝트 작업 트리는 보존합니다.

## 완료된 구조

- Agent, Task, Workflow 정의와 JSON schema
- 단일 `AgentTaskRunner`와 JSON-only `TaskResultEnvelopeV1`
- task별 input/result schema, guardrail, effect mapper registry
- compile 시 참조·권한·전이·cycle·approval·budget 검증
- activation 기반 `RunAggregate`, 제한된 `DomainEffect`, 단일 `RunReducer`
- deterministic `TransitionRouter`와 CAS/fencing repository
- 실행 전 node/attempt 예약과 mutation replay 금지
- 별도 `PLAN_APPROVAL` human gate와 동일 activation access 재개
- immutable artifact와 최신 성공 activation 입력 binding
- core command 기반 stop/interrupt/approval과 중립 operator projection
- provider-discovery-v2 및 bounded `models --json`
- Electron 44 utility process, sandboxed renderer, task-scoped preload bridge, tray lifecycle
- `%APPDATA%` 설정/%LOCALAPPDATA% 세션 분리와 safeStorage 비밀값 저장
- Windows x64 portable desktop executable, Fuses, native-module unpack, checksum/SBOM/provenance 검증
- 계획과 함께 승인되는 `VerificationContract`, 코어 순차 검증 명령, `verification_result.v1` 증거
- 검증 실패 피드백·QA/최종 승인 proof 바인딩·수렴 평가 및 재승인 후보 해시
- fingerprint와 보수적 `fs.watch`, 프로젝트 공용 lease, Windows Job Object 보조 실행기
- tools-none 형식 복구와 설치 배포물의 검증 실행 경로

## 확정된 비범위

- 병렬 node, fan-out/join, subgraph
- manager delegation과 Agent 간 자유 대화
- 장기 agent memory
- CrewAI 또는 LangGraph production dependency
- 3.x 세션·registry·정의 migration
- 코드 편집기·내장 터미널·provider 설치·자동 업데이트·코드 서명
- macOS/Linux GUI와 VS Code 데이터 마이그레이션

## 이후 변경의 승인 기준

새 기능은 다음 경계를 유지해야 합니다.

1. 모델 실행은 하나의 `AgentTaskRunner`를 통과한다.
2. provider text는 증거이며 core-authored outcome만 전이를 결정한다.
3. aggregate 변경은 `RunReducer`만 수행한다.
4. mutation 결과가 불명확한 activation은 자동 replay하지 않는다.
5. 진행 중인 run은 snapshot된 compiled definition만 사용한다.
6. UI와 외부 integration은 aggregate가 아닌 versioned command/projection protocol을 사용한다.
7. `SUCCESS`는 코어가 실행한 모든 필수 명령, 동일 proof를 참조하는 QA·최종 승인, 최신 fingerprint가
   함께 있을 때만 reducer가 커밋한다.

검증 실행은 `PLANNING → PLAN_APPROVAL → IMPLEMENTATION → TEST → VERIFY → QA_REVIEW →
MASTER_APPROVAL → SUCCESS` 순서를 따른다. 테스트 Agent는 준비·진단만 보고하고 명령 결과와
종료 코드는 코어 실행기가 기록한다. 승인된 보호 파일이나 실행 정책이 바뀌면 동일 세션에서
새 후보 해시를 승인해야 하며, 승인 범위의 새 테스트 추가만 자동 편입된다.

구체적인 병렬 graph나 autonomous delegation 요구가 생길 때만 framework 재평가를 시작합니다.
비교 실험은 `experiments/langgraph`에 격리하며 production import는 architecture test로 차단합니다.
