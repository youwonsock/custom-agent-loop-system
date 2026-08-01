# Custom Agent Loop System

## Configurable autonomous pipeline

The loop is no longer limited to a hard-coded sequence. Edit
[`agent_pipeline.json`](./agent_pipeline.json) (validated by
[`agent_pipeline.schema.json`](./agent_pipeline.schema.json)) to control:

- how many stages run and the graph followed on success or failure;
- which specialized role owns each stage;
- whether a stage plans, implements, tests, reviews, approves, or produces an interrupt briefing;
- which built-in model slot—or explicit model and variant—a custom role uses;
- which stage counts as an implementation/verification iteration;
- whether planning pauses for approval (`requiresPlanApproval`) or selects the first plan automatically.

Each stage has `onSuccess` and `onFailure` targets. Targets may be another stage
ID, `SUCCESS`, or `PAUSED`. `startStageId`, `interruptStageId`, and
`reentryStageId` define startup, bounded failure handling, and post-revision
re-entry. Role and stage IDs must be safe single path segments.

By default, planning enters `WAITING_USER` after producing three options so the user can review
the full Markdown documents and approve one before implementation starts. To use
a different pipeline file:

```powershell
node dist/loop_orchestrator.js run --goal "..." --target "..." --pipeline C:\path\pipeline.json
```

By default, a session enters `WAITING_USER` and asks for approval when an implementation plan
needs a path outside the primary target. Approve the pending request on resume,
or opt into full filesystem access for the session:

```powershell
node dist/loop_orchestrator.js resume --session <id> --approve-access
node dist/loop_orchestrator.js run --goal "..." --target "C:\repo" --full-access
```

VS Code exposes the same file through `agentLoop.pipelineConfigPath` and the
**Agent Loop: Open Pipeline Configuration** command.

## Execution resilience

Every session uses a long-lived owner lock plus an atomic lease heartbeat,
short state/registry write locks, and a queued Stop/Interrupt control channel.
Each agent attempt is supervised by activity-aware watchdogs: 2 minutes for the
initial CLI connection, 5 minutes while the model is generating, 10 minutes
while an announced tool call is running, and a 15-minute progress-renewable
attempt window. Meaningful progress extends that window, but never beyond the
persisted 48-minute role recovery budget.
Failed network/transport attempts can reconnect once to the captured CLI
session, then retry with a fresh session under a persisted 48-minute recovery
budget.

Hold states are intentionally distinct. `PAUSED` is reserved for repeated,
token-consuming attempts that do not converge, so it acts as the guard against
meaningless AI spend. Token-free transient transport failures enter
`RECOVERING` and are retried later using 1/5/15-minute backoff by default;
after the configured recovery cycles they enter `WAITING_USER` without invoking
another AI briefing. Plan/access/auth decisions use `WAITING_USER`, an explicit
Stop uses `STOPPED`, and an unsafe orphan/ownership condition uses `BLOCKED`.
The dashboard shows the reason and scheduled recovery time.

If the final normal attempt exits with code 0 but misses the completion
contract, the loop may use one additional fresh-session completion recovery.
This recovery is bounded by the remaining role budget and at most five minutes,
reuses existing artifacts, and verifies work instead of accepting a missing
sentinel as success. Set `maxCompletionRecoveryAttempts` to `0` to disable it.

Only assistant JSON text containing `[PHASE_DONE]` on its own line satisfies the
common completion contract. Planning, test, review, and approval stages also
enforce their stage-specific structured verdicts. Raw terminal output and
prompt echoes cannot complete an attempt.

> 대화형 코딩 CLI(`opencode`, `kilo` 등)를 자식 프로세스로 통제하여, 다수의 AI 에이전트가 자율적으로 목표를 달성하는 **동적 멀티 모델 지정형 멀티 세션 오케스트레이터**.
> Node.js/TypeScript 코어 엔진 + VS Code 확장 패널로 구성됩니다.

---

## 1. 요구사항

### 런타임
- **Node.js ≥ 18.0.0**
- 지원 코딩 CLI 중 하나 이상이 설치되어 PATH에 등록되어 있고, 인증/자격증명이 완료되어 있어야 함:
  - **opencode** — `npm install -g opencode` → 모델 탐색: `opencode models`
  - **kilo** — `npm install -g @kilocode/cli` → 모델 탐색: `kilo models`
- 운영체제: Windows / macOS / Linux (Windows는 `useConpty`, PATHEXT 기반 바이너리 해석 적용).
- `node-pty` prebuild `spawn-helper` 바이너리(macOS/Linux) 실행 권한 필요. `npm install` 시 자동으로 `postinstall` 스크립트(`scripts/fix-pty-permissions.js`)가 권한을 수정합니다.

### 의존성 (Core 엔진)
- `fs-extra` — 원자적 파일 쓰기/디렉터리 보장.
- `node-pty` — 대화형 코딩 CLI를 가상 터미널(PTY) 자식 프로세스로 실행.
- 그 외 Node 표준 모듈(`child_process`, `fs`, `path`, `crypto`).

### 의존성 (VS Code 확장, `vscode-extension/`)
- `@types/vscode` ≥ 1.85.0
- VS Code ≥ 1.85.0
- 빌드 도구: `typescript`, `@vscode/vsce`

---

## 2. 아키텍처 개요

Core 엔진은 **명시적 함수 호출 체인(Explicit Function Call Chain)** 패러다임으로 동작합니다. `fs.watch` 같은 반응형 방식의 불안정성을 배제하고, Core가 제어권을 쥐고 순차적으로 다음 페이즈 함수를 호출합니다.

사용자의 원본 프로젝트 소스를 안전하게 보존하기 위해, 모든 상태/기억/에이전트 제어 파일은 **Core 자체 실행 디렉터리 내부의 `.goal/` 공간**에만 기록됩니다.

### 디렉터리 트리
```
<rootDir>/
├── loop_orchestrator.ts              # 전체 시스템 메인 엔진 코어 클래스
├── sessions_registry.json            # [글로벌] 전체 세션 및 CLI 가용 모델 목록 마스터 파일
└── .goal/
     └── sessions/
          └── [sessionId]/            # 발급된 고유 세션 ID 디렉터리
               ├── loop_state.json    # 세션 글로벌 상태, 에이전트 모델 매핑, 에러 큐
               ├── progress_notes.txt # 누적 시행착오 요약 노트 (롤링 서머리)
               ├── final_summary.json # 대성공 마감 리포트 (인간 감사용)
               ├── loop_history/      # 턴(Iteration)별 데이터 독립 보관 폴더
               │    └── loop_N_<phase>_<role>.json
               ├── 0_planner/         # [플래너 방] state, skills, in/out payload
               ├── 1_implementer/     # [구현가 방]
               ├── 2_tester/          # [테스터 방] output.json 에 테스트 산출물+verdict 저장
               ├── 3_qa_lead/         # [검증가 방]
               ├── 4_master/          # [마스터 방]
               └── 5_interrupter/     # [인터럽터 방]
```

각 에이전트 "방(room)"은 4개 파일로 구성됩니다:
- `state.json` — 동작 상태(idle/running/completed/failed), lastExitCode, lastRunAt.
- `skills.json` — 허용 도구(`allowedTools`), 절대적 행동 제약(`enforcedRules`), `systemPrompt`.
- `input.json` — 해당 페이즈에 주입된 HandoffPayload.
- `output.json` — 에이전트 산출물 (테스터는 verdict 포함).

---

## 3. 핵심 데이터 인터페이스

- **SessionRegistry** — 활성 세션 ID 배열, 외부 CLI에서 동적 획득한 가용 모델 배열(`availableModels`), 탐색 시각, 세션 메타 정보 목록, 수동 모델 오버라이드.
- **LoopState** — 세션 고유 ID, 실행 상태(`RUNNING`/`PAUSED`/`WAITING_USER`/`RECOVERING`/`STOPPED`/`BLOCKED`/`SUCCESS`/`FAILED`), 현재 페이즈, 루프 카운트, 에이전트별 모델 매핑, Lookback-5 에러 서명 큐, 에이전트별 동작 상태, 타임아웃/최대 반복 설정, `cliBinary` + `cliProfile`.
- **HandoffPayload** — 정제된 최종 목표, 대상 프로젝트 경로, progressNotes 문자열, 역방향 회귀 시 주입될 직전 실패 다이제스트.
- **AgentSkills** — 역할, 허용 도구 목록, `enforcedRules`(절대 어기면 안 되는 제약) 배열, systemPrompt.
- **CliProfile** — CLI 바이너리 이름, 모델 탐색 인자(`modelsArgs`), 실행 인자 빌더(`buildRunArgs`), 상호작용 화이트리스트. `opencode`·`kilo` 내장 프로파일 제공.

---

## 4. 작동 방식

### 4.0 다중 CLI 프로파일 시스템 (`CliProfile`)
본 시스템은 특정 CLI에 종속되지 않습니다. `CliProfile` 인터페이스로 각 CLI의 명령 규약을 추상화합니다:

| 프로파일 | 바이너리 | 실행 명령 | 자율 모드 플래그 | 모델 탐색 |
|----------|---------|-----------|-----------------|-----------|
| `opencode` | `opencode` | `opencode run --format json --model <m> --dir <p> --dangerously-skip-permissions <prompt>` | `--dangerously-skip-permissions` | `opencode models` |
| `kilo` | `kilo` | `kilo run --auto --format json --model <m> --dir <p> <prompt>` | `--auto` | `kilo models` |

- `--profile <name>` CLI 플래그로 명시 지정 가능.
- 미지정 시 `--binary` 이름에서 자동 감지(`resolveCliProfile`).
- 각 프로파일은 고유의 `interactionWhitelist`(자동 `y` 응답 패턴)를 가짐. kilo는 `Action Required`/`Run Command (y)` 등 kilo 고유 프롬프트 추가.
- `LoopState.cliProfile`에 저장되어 resume 시에도 유지.
- VS Code 확장 설정(`agentLoop.cliProfile`) 및 composer 드롭박스로 UI에서 선택 가능.

### 4.1 CLI 가용 모델 동적 검색 (`discoverCliModels`)
Core 기동/초기화 시 활성 프로파일의 `modelsArgs`를 사용해 시스템 쉘에서 `<binary> models`를 실행해 터미널 출력을 파싱합니다. `provider/model` 형식의 라인을 정규식으로 추출해 글로벌 마스터 파일(`sessions_registry.json`)에 저장합니다. VS Code 웹뷰는 이 목록을 드롭다운(공급자별 optgroup 그룹화)으로 실시간 인지합니다.

### 4.2 node-PTY 자식 프로세스 다중 모델 인젝션
각 에이전트 페이즈 함수 실행 시, 글로벌 상태에서 해당 에이전트용 지정 모델명을 조회합니다. `node-pty`로 자식 프로세스를 띄울 때 활성 프로파일의 `buildRunArgs()`로 인자를 조립해 주입합니다:

```
# opencode 프로파일
opencode run --format json --model <지정모델명> --dir <targetProjectPath> --dangerously-skip-permissions "<프롬프트>"

# kilo 프로파일
kilo run --auto --format json --model <지정모델명> --dir <targetProjectPath> "<프롬프트>"
```

- PTY의 `cwd`는 유저의 실제 워크스페이스 경로(`targetProjectPath`).
- 환경변수로 세션 컨텍스트 전파: `AGENT_LOOP_SESSION_ID`, `AGENT_LOOP_AGENT_ROLE`, `AGENT_LOOP_PHASE`.
- 실시간 출력 스트림을 파싱하여 CLI가 대화형 컨피그를 요구하며 멈추는 패턴(`Apply changes? [y/n]`, `Continue? [y/n]`, `Action Required` 등 프로파일별 화이트리스트)을 포착 시 즉시 `y\n` 가상 입력을 주입하여 **무인 자율 구동**을 실현합니다.
- 페이즈 종료 sentinel 토큰 `[PHASE_DONE]` 감지로 에이전트 완료를 판정합니다.

### 4.3 Lookback-5 다중 진동 감지 가드레일 (`pushAndCheckOscillation`)
동일 에러나 순환형 복수 진동(A→B→A) 늪에 빠져 자원을 탕진하는 것을 방어합니다.
- 에러 히스토리를 최대 5개 큐로 관리.
- 입력된 에러 로그에서 정규식으로 파일명/에러 종류의 핵심 **지문(Signature)** 추출(경로는 `<PATH>`, 줄번호는 `<LN>` 등으로 정규화).
- 최근 5개 중 동일 지문이 **3회 이상** 발견되면 진동 확정 → 루프를 `PAUSED`로 잠그고 인터럽터 에이전트 자동 실행 → 유저에게 브리핑.
- 4개 이상일 땐 순환 패턴(최근 반쪽 = 이전 반쪽)도 진동으로 판정.

### 4.4 슬라이딩 윈도우 및 롤링 서머리 (`prepareHandoff`)
장기 루프 시 LLM 컨텍스트 폭증과 환각을 원천 차단합니다.
- 매 턴의 전체 raw 페이로드는 `loop_history/`에 영구 아카이빙(인간 디버깅 자산으로 격리).
- 검증 실패 후 구현가로 역방향 회귀하는 문맥에서만 **직전 회차의 실패 다이제스트 1개**를 주입해 프롬프트 크기를 O(1) 수준으로 다이어트.
- Core는 매 턴의 결론을 한 줄 요약 노트(`progress_notes.txt`)에 지속 누적해 에이전트들에게 최소한의 이정표로 공급.

### 4.5 누적 수정 정책 (비파괴)
유저 워크스페이스의 코드를 유실시키는 파괴적 명령(`git clean`, `git checkout --`, `git reset --hard`)은 **사용하지 않습니다**. 구현가는 이전 실패 코드를 안고 고쳐나가는 **누적 수정 방식**만 사용합니다(`enforcedRules`로 강제).

> 참고: 이전 버전의 쉘 테스트 명령(`npm test`) 실행 기반 검증과 포트 좀비 세정(`cleanPorts`) 기능은 제거되었습니다. 테스트는 이제 테스터 에이전트가 구현 내용을 기반으로 **AI가 직접 수행**합니다.

### 4.6 모델 Variant(Thinking Level) 시스템

각 모델에 대해 **thinking level**(variant)을 지정할 수 있습니다. variant는 `--variant <level>` 형태로 CLI에 전달되어 사고 깊이/리소스 사용량을 제어합니다.

#### 공급자별 기본 Variant

| 공급자 | 지원 Variant |
|--------|-------------|
| anthropic | `high`, `max` |
| openai | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| google / gemini | `low`, `high` |
| opencode / opencode-go / kilo | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| deepseek | `low`, `medium`, `high`, `max` |

#### 사용자 정의 Variant (`model_variants.json`)

Core 루트 디렉터리에 `model_variants.json` 파일을 배치하면 공급자별 기본값을 **모델 ID 단위**로 오버라이드할 수 있습니다:

```json
{
  "anthropic/claude-sonnet-4-5": ["low", "medium", "high", "xhigh", "max"],
  "openai/gpt-4o": ["low", "high"]
}
```

#### UI 적용 방식 (VS Code 확장)

웹뷰의 **Model Mapping** 그리드에서:
- 각 에이전트 역할별 variant 드롭다운 제공 (현재 선택된 모델에 맞는 variant 목록 자동 갱신)
- **"Apply to all"** variant 드롭다운: 일괄 선택 시 모든 역할에 동일 variant 전파
- 모델 선택 변경 시 기존 variant 선택값을 index 기반으로 보존(`mapVariantByIndex()`)

#### CLI 적용 방식

```bash
node dist/loop_orchestrator.js run \
  --goal "..." --target ./my-project \
  --planner-variant xhigh \
  --implementer-variant high \
  --tester-variant medium
```

variant 플래그는 resume 시에도 유지되며, 미지정 시 CLI 기본값(없음)을 사용합니다.

---

## 5. 파이프라인 설계 (중앙 제어 루프)

Core는 자율 순환 루프와 페이즈 전환 스위치를 결합한 **유한 상태 머신**으로 작동합니다. 루프 카운트가 `maxIterations`에 도달하면 `FAILED`로 종결합니다.

```
                    ┌──────────────────────────────────────────────┐
                    │  (루프 카운트 >= maxIterations → FAILED 종결)   │
                    └──────────────────────────────────────────────┘
 PLANNING ──► IMPLEMENTATION ──► TEST_GENERATION ──► VERIFICATION ──► MASTER_APPROVAL ──► SUCCESS
   (1회)         ▲                  (테스터 AI)        (QA 교차검증)      (최종 인수)        │
                 │                      │                  │                  │            │
                 │                      │           실패+진동미발생           반려           │ final_summary.json
                 └────── 역방향 회귀 ◄──┴──────────────────┘                  │            │  (1회 발행)
                                           실패+진동발생                       │            ▼
                                              → INTERRUPT(PAUSED) ◄────────────┘        루프 탈출
                                              인터럽터 브리핑 → 유저 개입
```

### 페이즈 명세

| # | 페이즈 | 담당 에이전트 | 동작 | 전진 조건 |
|---|--------|--------------|------|-----------|
| 1 | `PLANNING` | planner | 초기 1회만. 목표 분석 → 구현 계획 + 에이전트별 매핑 모델 확정. | 계획 산출 시 `planningComplete=true` → IMPLEMENTATION |
| 2 | `IMPLEMENTATION` | implementer | 지정 모델 플래그·세션 ID·스킬 명세 래핑해 PTY 가동. 소스코드 누적 수정. | 코드 수정 완료(`[PHASE_DONE]`) → TEST_GENERATION |
| 3 | `TEST_GENERATION` | tester | **구현가가 변경한 파일을 읽고**, 그 구현에 맞는 테스트를 직접 설계·작성·실행(bash 도구). `VERDICT: PASS/FAIL` 출력. 산출물을 `2_tester/output.json`에 저장(verdict 포함). | 테스트 수행 완료 → VERIFICATION |
| 4 | `VERIFICATION` | qa_lead | 테스터의 verdict와 출력을 교차 검증(치팅/목킹/빈 assertion/스킵 탐지) + 목표 충족 여부 확인. `APPROVED`/`REJECTED`. | APPROVED → MASTER_APPROVAL / REJECTED → 진동 감지 후 IMPLEMENTATION 역회귀 또는 INTERRUPT |
| 5 | `MASTER_APPROVAL` | master | 최종 인수 테스트. | 승인 → `final_summary.json` 1회 발행 + `SUCCESS` 종결 / 반려 → IMPLEMENTATION 회귀 |
| - | `INTERRUPT` | interrupter | 진동 감지 시 자동 진입. 에러 히스토리+progress notes 분석 → 유저에게 원인과 해결책 브리핑. | 유저 개입 후 `resume` |

### 역방향 회귀 핸드오프
VERIFICATION 실패 시:
1. `extractFailureDigest()`로 QA 출력 + 테스터 출력에서 실패 다이제스트 추출.
2. Lookback-5 진동 감지 가동.
   - 진동 미발생 → 직전 실패 다이제스트만 들고 `IMPLEMENTATION`으로 역방향 회귀.
   - 진동 발생 → `INTERRUPT` 진입, `PAUSED` 잠금.

### 에이전트별 스킬 요약
| 역할 | 허용 도구 | 핵심 제약 |
|------|-----------|----------|
| planner | read, glob, grep, bash, webfetch | 소스 수정 금지. 실행 가능한 계획만 산출. |
| implementer | read, write, edit, glob, grep, bash | 파괴적 git 금지. 누적 수정만. target 경로 내 파일만. |
| tester | read, write, edit, glob, grep, bash | **구현 내용 기반** 테스트 설계·실행. 프로덕션 코드 수정 금지(테스트 파일만). `VERDICT: PASS/FAIL` 필수. |
| qa_lead | read, glob, grep, bash | 파일 수정 금지. 테스트 치팅 탐지. `APPROVED`/`REJECTED` 출력. |
| master | read, glob, grep, bash | 파일 수정 금지. 최종 인수 테스트. `APPROVED`/`REJECTED`. |
| interrupter | read, glob, grep | 파일 수정 금지. 진동 분석 + 유저 브리핑. |

---

## 6. CLI 사용법

```bash
# 빌드
npm install
npm run build      # tsc → dist/loop_orchestrator.js

# 초기화 (현재 디렉터리에 .goal/ + sessions_registry.json 생성)
node dist/loop_orchestrator.js init

# 가용 모델 탐색 (프로파일 지정 가능)
node dist/loop_orchestrator.js models [--binary opencode|kilo] [--profile opencode|kilo] [--root <path>]

# 새 세션 실행 (opencode, variant 포함)
node dist/loop_orchestrator.js run \
  --goal "Add JWT auth to the Express app" \
  --target ./my-project \
  --binary opencode \
  --profile opencode \
  --max-iterations 20 \
  --phase-timeout 600000 \
  --idle-timeout 90000 \
  [--planner-model <m>] [--planner-variant <v>] \
  [--implementer-model <m>] [--implementer-variant <v>] \
  [--tester-model <m>] [--tester-variant <v>] \
  [--qa-model <m>] [--qa-variant <v>] \
  [--master-model <m>] [--master-variant <v>] \
  [--interrupter-model <m>] [--interrupter-variant <v>]

# 새 세션 실행 (kilo)
node dist/loop_orchestrator.js run \
  --goal "Add JWT auth to the Express app" \
  --target ./my-project \
  --binary kilo \
  --profile kilo \
  [--planner-model <m>] [--planner-variant <v>] ...

# 일시정지된 세션 재개
node dist/loop_orchestrator.js resume --session <sessionId> [--root <path>] [--binary <name>] [--profile <name>]
```

`--profile` 미지정 시 `--binary` 이름에서 자동 감지합니다. 모델 미지정 시 발견된 가용 모델 중 첫 번째를 자동 할당하며, 발견 실패 시 폴백 모델(`anthropic/claude-sonnet-4-5`)을 사용합니다.

---

## 7. VS Code 확장 (Kilo Code 스타일 UI)

`vscode-extension/` 에 별도 패키지로 제공되는 확장이 Core 엔진을 GUI로 제어합니다.

### 빌드 및 설치
```bash
cd vscode-extension
npm install
npm run compile
npx vsce package            # → agent-loop-vscode-<ver>.vsix
code --install-extension agent-loop-vscode-<ver>.vsix --force
```
개발/재설치 시 이전 버전 vsix 및 확장 디렉터리는 삭제 후 새 버전만 유지합니다.

### 기능
- **액티비티바 "Agent Loop" 아이콘** → Sessions 트리 뷰 + 뷰 헤더 버튼(New Session / Show Panel / Discover Models / Refresh).
- **웹뷰 컨트롤 패널**: Kilo Code 스타일 하단 composer(goal textarea + target 경로 + **CLI 프로파일 드롭박스** + Start Session), 상단 툴바(세션 선택/Resume/Stop/Models/Notes), 메인 그리드(Status / Model Mapping / Progress Notes / Loop History / Live Log Stream).
- **CLI 프로파일 선택**: composer에서 `opencode`/`kilo` 프로파일 선택. 세션 시작 시 VS Code 설정에 자동 저장.
- **모델 드롭다운**: 공급자별 `<optgroup>` 그룹화, 역할별(Planner/Implementer/Tester/QA Lead/Master/Interrupter) 모델 지정 + **"Apply to all" 일괄 설정 드롭박스**.
- **Variant(Thinking Level) 드롭다운**: 각 에이전트 역할별 variant 선택 + **"Apply to all" 일괄 variant 전파**. 선택된 모델에 따라 variant 목록 자동 갱신. 모델 변경 시 기존 variant를 index 기반으로 보존.
- **세션 삭제**: 세션 목록에서 `Delete Session`으로 세션 파일, 디렉터리, 레지스트리 항목 완전 제거.
- **드롭다운 자동 닫힘 방지**: 폴링 기반 재렌더 시 상호작용 가드 + 상태 시그니처 스킵으로 열려 있는 `<select>`가 파괴되지 않음.
- **Codex 스타일 계획 검토**: 계획 생성 시 전체 옵션을 `plan_options.md`와
  옵션별 Markdown 문서로 저장해 중앙 에디터의 렌더링된 Markdown 미리보기로 자동으로 열고, Plan Review
  사이드바에는 옵션 제목과 선택·수정·승인 컨트롤만 표시.
- **Compose 모드**: "New Session" 클릭 시 기존 세션 유무와 무관하게 composer 뷰 고정(ESC/Cancel로 취소).
- **실시간 로그 스트리밍**: Core 자식 프로세스 stdout/stderr를 가로채 패널에 출력.
- **설정(`agentLoop.*`)**: `cliBinary`, `cliProfile`(`opencode`|`kilo`), `rootDir`, `nodeBinary`, `orchestratorScript`, `maxIterations`, `phaseTimeoutMs`, `idleTimeoutMs`, `pollIntervalMs`.

> 참고: 테스트 명령(`testCommand`)과 포트 세정(`portsToClean`) 설정은 AI 주도 테스트 전환에 따라 제거되었습니다.

### 현재 버전
- **VS Code 확장**: `3.0.11`
- **Core 엔진**: `1.1.3`

---

## 8. 안정성 설계

- **원자적 쓰기(Atomic Write)**: 모든 JSON 상태 파일은 `.tmp.<pid>.<ts>.<rand>` 임시 파일 작성 후 rename. Windows EPERM/EBUSY/EACCES 시 지수 백오프 재시도(`renameWithRetry`). 손상 감지 시 `.corrupt.<ts>` 백업 후 재생성.
- **프로세스 좀비 방지**: PTY 종료 시 자식 프로세스 트리까지 정리(Windows `taskkill /T /F`, POSIX `pkill -TERM -P`).
- **타임아웃 이중 가드**: 페이즈 타임아웃(`phaseTimeoutMs`) + 유휴 타임아웃(`idleTimeoutMs`).
- **신호 핸들러**: SIGINT/SIGTERM 수신 시 현재 PTY 정리 후 상태 저장 후 종료.
- **세션 격리**: 각 세션은 독립 디렉터리 + 독립 룸 파일 세트로 완전 격리, 다중 세션 동시 구동 지원.
