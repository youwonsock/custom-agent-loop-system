import type { PlanReviewModel } from "./viewModels";
import { lazy } from "react";
const Markdown = lazy(() => import("../components/Markdown"));

export default function PlanReview({
  controller,
}: {
  controller: PlanReviewModel;
}) {
  const {
    planText,
    setPlanText,
    planEditing,
    setPlanEditing,
    setPlanChoice,
    actionBusy,
    run,
    pendingVisit,
    plan,
    act,
  } = controller;
  if (!run) return null;

  return (
    <>
      {pendingVisit && plan && (
        <section className="panel plan-review">
          <div className="plan-review-head">
            <div>
              <span className="eyebrow">PLAN APPROVAL</span>
              <h2>계획을 검토하고 승인하세요</h2>
              <p>
                {
                  run.graph.nodes.find((n) => n.id === pendingVisit.nodeId)
                    ?.name
                }{" "}
                · 방문 {pendingVisit.number} · 문서 rev {plan.revision}
              </p>
            </div>
            <div>
              <button
                className="button subtle"
                onClick={() => {
                  setPlanEditing(!planEditing);
                  setPlanText(plan.body);
                }}
              >
                {planEditing ? "편집 취소" : "문서 수정"}
              </button>
              {planEditing ? (
                <button
                  className="button primary"
                  disabled={actionBusy || !planText.trim()}
                  onClick={() =>
                    void act({
                      type: "edit_plan",
                      nodeId: pendingVisit.nodeId,
                      visitId: pendingVisit.id,
                      choiceId: plan.id,
                      expectedRevision: plan.revision,
                      body: planText,
                    })
                  }
                >
                  문서 저장
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={actionBusy}
                  onClick={() =>
                    void act({
                      type: "approve_plan",
                      nodeId: pendingVisit.nodeId,
                      visitId: pendingVisit.id,
                      choiceId: plan.id,
                      expectedRevision: plan.revision,
                    })
                  }
                >
                  {actionBusy ? "처리 중…" : "이 계획 승인 후 계속"}
                </button>
              )}
            </div>
          </div>
          <div className="plan-tabs">
            {pendingVisit.plans.map((p) => (
              <button
                className={p.id === plan.id ? "active" : ""}
                key={p.id}
                onClick={() => {
                  setPlanChoice(p.id);
                  setPlanEditing(false);
                }}
              >
                선택지 {p.id} · {p.title}
              </button>
            ))}
          </div>
          {planEditing ? (
            <textarea
              className="plan-editor"
              aria-label="계획 문서"
              value={planText}
              onChange={(e) => setPlanText(e.target.value)}
            />
          ) : (
            <div className="markdown">
              <Markdown>{plan.body}</Markdown>
            </div>
          )}
        </section>
      )}
    </>
  );
}
