# v4 작업 구조 확정 현황

이 문서는 CrewAI·LangGraph 참고 구조를 제품 소유 TypeScript 코어로 확정한 4.0.0 구현 결과를
기록합니다. 3.x 데이터와 API 호환은 의도적으로 제공하지 않습니다.

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
- core command 기반 stop/interrupt/approval과 read-only VS Code projection
- architecture, integration, provider boundary, package/VSIX 검증
- 구형 executor, text completion parser, state migration, extension aggregate writer 제거

## 확정된 비범위

- 병렬 node, fan-out/join, subgraph
- manager delegation과 Agent 간 자유 대화
- 장기 agent memory
- CrewAI 또는 LangGraph production dependency
- 3.x 세션·registry·정의 migration
- VS Code UI 전면 재설계

## 이후 변경의 승인 기준

새 기능은 다음 경계를 유지해야 합니다.

1. 모델 실행은 하나의 `AgentTaskRunner`를 통과한다.
2. provider text는 증거이며 core-authored outcome만 전이를 결정한다.
3. aggregate 변경은 `RunReducer`만 수행한다.
4. mutation 결과가 불명확한 activation은 자동 replay하지 않는다.
5. 진행 중인 run은 snapshot된 compiled definition만 사용한다.
6. UI와 외부 integration은 aggregate가 아닌 versioned command/projection protocol을 사용한다.

구체적인 병렬 graph나 autonomous delegation 요구가 생길 때만 framework 재평가를 시작합니다.
비교 실험은 `experiments/langgraph`에 격리하며 production import는 architecture test로 차단합니다.
