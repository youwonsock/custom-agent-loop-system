import { BindingEditor } from "../Binding";
import type { GraphInspectorModel } from "./viewModels";
import { autonomousDefaults } from "../../../src/shared/graph_defaults";

export default function GraphSettings({
  controller,
}: {
  controller: GraphInspectorModel;
}) {
  const { draft, change, connections, catalogs, target, query, querying } =
    controller;
  if (!draft) return null;
  return (
    <>
      <p className="inspector-intro">
        노드를 선택하면 역할과 연결을 편집할 수 있습니다. 공통 모델은 모든
        노드가 기본으로 사용합니다.
      </p>
      <label>
        그래프 설명
        <textarea
          aria-label="그래프 설명"
          rows={3}
          value={draft.description}
          onChange={(e) =>
            change((g) => {
              g.description = e.target.value;
            })
          }
          placeholder="이 그래프의 목적을 적어주세요."
        />
      </label>
      <fieldset>
        <legend>자율 실행</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            aria-label="자동 수정 루프"
            checked={Boolean(draft.automation)}
            onChange={(e) =>
              change((g) => {
                if (e.target.checked) g.automation = autonomousDefaults(false);
                else delete g.automation;
              })
            }
          />
          검증 실패를 자동 수정한 뒤 다시 검사
        </label>
        {draft.automation && (
          <>
            <p className="muted">
              검증 계약:{" "}
              {draft.automation.verificationContract
                ? "보호 파일·필수 검사 고정"
                : "기존 그래프 정책"}
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="자체 Node 테스트 계약 필수"
                checked={Boolean(draft.automation.authoredNodeTests)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.authoredNodeTests = e.target.checked;
                    if (e.target.checked)
                      g.automation!.verificationContract = true;
                  })
                }
              />
              npm 테스트에 자체 영역·결함 탐지 계약 필수
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="테스트 소스 수정 차단"
                checked={Boolean(draft.automation.testSourceGuard)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.testSourceGuard = e.target.checked;
                  })
                }
              />
              테스트는 소스 고정·실패 즉시 구현으로 반환
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="검토 승인 예산 보존"
                checked={Boolean(draft.automation.reserveFinalizationBudget)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.reserveFinalizationBudget = e.target.checked;
                  })
                }
              />
              단계별 마감으로 후속 검토·승인 시간 보존
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="일괄 프로세스 종료 차단"
                checked={Boolean(draft.automation.guardOwnedProcesses)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.guardOwnedProcesses = e.target.checked;
                  })
                }
              />
              프로세스 이름에 의한 일괄 종료 차단
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="Kilo 대상 밖 조회 차단"
                checked={Boolean(draft.automation.targetScopeGuard)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.targetScopeGuard = e.target.checked;
                    if (!e.target.checked) g.automation!.programIoGuard = false;
                  })
                }
              />
              Kilo 모든 역할의 대상 밖 파일 조회 차단
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="Kilo 프로그램 I/O 커널 격리"
                checked={Boolean(draft.automation.programIoGuard)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.programIoGuard = e.target.checked;
                    if (e.target.checked) g.automation!.targetScopeGuard = true;
                  })
                }
              />
              Kilo 프로그램·자식 프로세스의 파일 I/O 격리 (미지원 환경은 실행
              중단)
            </label>
            <label>
              자동 수정 횟수
              <input
                aria-label="자동 수정 횟수"
                type="number"
                min={1}
                max={20}
                value={draft.automation.maxRepairCycles}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.maxRepairCycles = Number(e.target.value);
                  })
                }
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="실제 브라우저 검증 필수"
                checked={Boolean(draft.automation.browserVerification)}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.browserVerification = e.target.checked;
                  })
                }
              />
              웹 화면의 실제 브라우저 검증 필수
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                aria-label="네이티브 자동 승인 검토"
                checked={draft.automation.nativeApprovalReview}
                onChange={(e) =>
                  change((g) => {
                    g.automation!.nativeApprovalReview = e.target.checked;
                  })
                }
              />
              Codex의 명령별 자동 승인 검토 사용
            </label>
            <p className="muted">
              계획 승인은 계획 노드 설정을 따릅니다. 인증·권한·명시적 사람
              승인은 대기하며, 실패한 검사를 성공으로 바꾸지 않습니다.
            </p>
          </>
        )}
      </fieldset>
      <BindingEditor
        label="기본 실행 설정"
        binding={draft.defaultBinding}
        connections={connections}
        catalogs={catalogs}
        target={target}
        onChange={(b) =>
          change((g) => {
            if (b) g.defaultBinding = b;
            else delete g.defaultBinding;
          })
        }
        onQuery={(value) => void query(value)}
        querying={querying}
      />
      <fieldset>
        <legend>실행 지점</legend>
        {(
          Object.keys(draft.entrypoints) as Array<
            keyof typeof draft.entrypoints
          >
        ).map((key) => (
          <label key={key}>
            {
              {
                start: "시작",
                reentry: "재진입",
                interrupt: "중단 처리",
                cycleCompletion: "사이클 완료",
              }[key]
            }
            <select
              aria-label={`${key} 실행 지점`}
              value={draft.entrypoints[key] ?? ""}
              onChange={(e) =>
                change((g) => {
                  g.entrypoints[key] = e.target.value || null;
                })
              }
            >
              <option value="">노드 선택</option>
              {draft.nodes
                .filter((n) => key !== "interrupt" || n.type === "interrupt")
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name || n.id}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </fieldset>
    </>
  );
}
