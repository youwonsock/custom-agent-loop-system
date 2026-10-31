import { useState } from "react";
import {
  SERVICE_TYPES,
  type LocalConnection,
  type ServiceType,
} from "../../../src/shared/domain";
import { api, id } from "../api";
import { pricingNames, stamp } from "../studioTypes";
import type { ConnectionsViewModel } from "./viewModels";

const serviceLabel = (type: ServiceType) =>
  type === "claude"
    ? "Claude Code"
    : type === "codex"
      ? "Codex"
      : type === "opencode"
        ? "OpenCode"
        : "Kilo";
interface DiscoveredCli {
  type: ServiceType;
  binary: string | null;
}
export default function ConnectionsView({
  controller,
}: {
  controller: ConnectionsViewModel;
}) {
  const {
    view,
    connections,
    setConnections,
    catalogs,
    target,
    setTarget,
    attempt,
    connectionForm,
    setConnectionForm,
    connectionBusy,
    setConnectionBusy,
    querying,
    query,
  } = controller;
  const [discovered, setDiscovered] = useState<DiscoveredCli[] | null>(null);
  const discover = () =>
    attempt(async () =>
      setDiscovered(
        await api<DiscoveredCli[]>("/connections/discover", "POST"),
      ),
    );
  const register = (type: ServiceType, binary: string) =>
    attempt(async () => {
      const c = await api<LocalConnection>("/connections", "POST", {
        id: id(),
        label: serviceLabel(type),
        type,
        binary,
      });
      setConnections((values) => [...values, c]);
    });

  return (
    <>
      {view === "connections" && (
        <div className="page-scroll">
          <div className="page-heading">
            <div>
              <span className="eyebrow">LOCAL SERVICES</span>
              <h1>내 CLI 연결</h1>
              <p>
                설치하고 인증한 서비스를 등록하세요. 모델은 해당 CLI에서
                조회합니다.
              </p>
            </div>
            <span className="count-pill">{connections.length}개 연결</span>
          </div>
          <div className="connections-layout">
            <section className="panel connection-form">
              <h2>
                {connections.some((c) => c.id === connectionForm.id)
                  ? "연결 수정"
                  : "로컬 서비스 등록"}
              </h2>
              <label>
                표시 이름
                <input
                  aria-label="연결 이름"
                  value={connectionForm.label}
                  onChange={(e) =>
                    setConnectionForm((c) => ({
                      ...c,
                      label: e.target.value,
                    }))
                  }
                  placeholder="예: 내 Codex"
                />
              </label>
              <label>
                CLI 종류
                <select
                  aria-label="CLI 종류"
                  value={connectionForm.type}
                  onChange={(e) =>
                    setConnectionForm((c) => ({
                      ...c,
                      type: e.target.value as LocalConnection["type"],
                      binary: e.target.value,
                    }))
                  }
                >
                  {SERVICE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {serviceLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                실행 파일
                <input
                  aria-label="CLI 실행 파일"
                  value={connectionForm.binary}
                  onChange={(e) =>
                    setConnectionForm((c) => ({
                      ...c,
                      binary: e.target.value,
                    }))
                  }
                  placeholder="codex 또는 실행 파일의 절대경로"
                />
              </label>
              <label>
                조회 대상 프로젝트
                <input
                  aria-label="모델 조회 프로젝트"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
              <button className="button full" onClick={() => void discover()}>
                설치된 CLI 찾기
              </button>
              {discovered && (
                <ul className="discovered-clis" aria-label="찾은 CLI">
                  {discovered.map(({ type, binary }) => (
                    <li key={type}>
                      <strong>{serviceLabel(type)}</strong>
                      {!binary ? (
                        <span className="muted">PATH에서 찾지 못함</span>
                      ) : (
                        <>
                          <code>{binary}</code>
                          {connections.some(
                            (c) => c.type === type && c.binary === binary,
                          ) ? (
                            <span className="muted">등록됨</span>
                          ) : (
                            <button
                              className="button"
                              aria-label={`${serviceLabel(type)} 등록`}
                              onClick={() => void register(type, binary)}
                            >
                              등록
                            </button>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="field-hint">
                인증과 MCP·스킬·훅은 CLI에서 설정합니다. 앱은 API 키를
                요청하거나 저장하지 않습니다.
              </p>
              <button
                className="button primary full"
                disabled={
                  connectionBusy ||
                  !connectionForm.label.trim() ||
                  !connectionForm.binary.trim()
                }
                onClick={() => {
                  setConnectionBusy(true);
                  void attempt(async () => {
                    const c = await api<LocalConnection>(
                      "/connections",
                      "POST",
                      connectionForm,
                    );
                    setConnections((values) => [
                      ...values.filter((v) => v.id !== c.id),
                      c,
                    ]);
                    setConnectionForm({
                      id: id(),
                      label: "",
                      type: "codex",
                      binary: "codex",
                    });
                    await query(c.id);
                  }).finally(() => setConnectionBusy(false));
                }}
              >
                {connectionBusy ? "연결 확인 중…" : "등록하고 모델 조회"}
              </button>
              <button
                className="button subtle full"
                onClick={() =>
                  setConnectionForm({
                    id: id(),
                    label: "",
                    type: "codex",
                    binary: "codex",
                  })
                }
              >
                입력 초기화
              </button>
            </section>
            <div className="connection-cards">
              {connections.length === 0 && (
                <div className="panel empty-connection">
                  <span>◉</span>
                  <h2>연결된 CLI가 없습니다</h2>
                  <p>
                    로컬 서비스를 직접 등록하면 조회된 모델을
                    <br />
                    그래프와 노드에 지정할 수 있습니다.
                  </p>
                </div>
              )}
              {connections.map((c) => {
                const cat = [...catalogs]
                  .reverse()
                  .find(
                    (v) =>
                      v.connectionId === c.id &&
                      v.targetProjectPath === target &&
                      v.binary === c.binary,
                  );
                return (
                  <article key={c.id} className="panel connection-card">
                    <div className="connection-card-head">
                      <div className={`service-symbol ${c.type}`}>
                        {c.type === "codex"
                          ? "⌘"
                          : c.type === "claude"
                            ? "✳"
                            : "◈"}
                      </div>
                      <div>
                        <h2>{c.label}</h2>
                        <span>{c.type}</span>
                      </div>
                      <span
                        className={`status-pill ${cat?.status === "ready" ? "SUCCESS" : "WAITING_USER"}`}
                      >
                        {querying === c.id
                          ? "조회 중"
                          : cat?.status === "ready"
                            ? "모델 조회 완료"
                            : "조회 필요"}
                      </span>
                    </div>
                    <code className="binary-path">{c.binary}</code>
                    {cat?.error && <p className="field-error">{cat.error}</p>}
                    <div className="model-tags">
                      {cat?.models.slice(0, 8).map((m) => (
                        <span
                          key={m.id}
                          title={`${m.id}\n${m.pricing?.reason ?? "가격 정보가 없습니다."}`}
                        >
                          {m.label} ·{" "}
                          {pricingNames[m.pricing?.status ?? "unknown"]}
                        </span>
                      ))}
                      {cat && cat.models.length > 8 && (
                        <span>+{cat.models.length - 8}</span>
                      )}
                    </div>
                    <div className="card-actions">
                      <span>
                        {cat?.queriedAt
                          ? stamp(cat.queriedAt)
                          : "조회된 모델만 선택할 수 있습니다."}
                      </span>
                      <button
                        className="button subtle small"
                        disabled={querying === c.id}
                        onClick={() => void query(c.id)}
                      >
                        모델 다시 조회
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setConnectionForm(c)}
                      >
                        수정
                      </button>
                      <button
                        className="text-button danger"
                        onClick={() => {
                          if (
                            confirm(
                              `${c.label} 연결을 삭제할까요? 그래프의 연결 참조를 다시 지정해야 합니다.`,
                            )
                          )
                            void attempt(async () => {
                              await api(`/connections/${c.id}`, "DELETE");
                              setConnections((values) =>
                                values.filter((v) => v.id !== c.id),
                              );
                            });
                        }}
                      >
                        삭제
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
