import type {
  ExecutionBinding,
  LocalConnection,
  ModelCatalog,
} from "../../src/shared/domain";
export function BindingEditor({
  binding,
  connections,
  catalogs,
  target,
  onChange,
  onQuery,
  querying,
  label = "실행 설정",
}: {
  binding?: ExecutionBinding;
  connections: LocalConnection[];
  catalogs: ModelCatalog[];
  target: string;
  onChange: (value: ExecutionBinding | undefined) => void;
  onQuery: (id: string) => void;
  querying: string | null;
  label?: string;
}) {
  const connection = connections.find((c) => c.id === binding?.connectionId);
  const catalog = [...catalogs]
    .reverse()
    .find(
      (c) =>
        c.connectionId === binding?.connectionId &&
        c.targetProjectPath === target &&
        c.binary === connection?.binary,
    );
  const models = catalog?.models ?? [],
    model = models.find((m) => m.id === binding?.modelId);
  return (
    <fieldset className="binding-fields">
      <legend>{label}</legend>
      <label>
        로컬 CLI 연결
        <select
          aria-label={`${label} 연결`}
          value={binding?.connectionId ?? ""}
          onChange={(e) =>
            onChange(
              e.target.value
                ? { connectionId: e.target.value, modelId: "" }
                : undefined,
            )
          }
        >
          <option value="">연결 선택</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {c.type}
            </option>
          ))}
          {binding?.connectionId && !connection && (
            <option value={binding.connectionId}>
              삭제된 연결 · 다시 지정하세요
            </option>
          )}
        </select>
      </label>
      {connection && (
        <div className="query-row">
          <span
            className={`catalog-state ${catalog?.status === "ready" ? "ready" : ""}`}
          >
            {querying === connection.id
              ? "조회 중…"
              : catalog?.status === "ready"
                ? `${models.length}개 모델 조회됨`
                : "모델 조회 필요"}
          </span>
          <button
            type="button"
            className="button subtle small"
            onClick={() => onQuery(connection.id)}
            disabled={querying === connection.id}
          >
            {querying === connection.id ? "조회 중" : "모델 조회"}
          </button>
        </div>
      )}
      <label>
        모델
        <select
          aria-label={`${label} 모델`}
          value={binding?.modelId ?? ""}
          disabled={!connection || !models.length}
          onChange={(e) =>
            onChange({
              connectionId: binding!.connectionId,
              modelId: e.target.value,
            })
          }
        >
          <option value="">조회된 모델 선택</option>
          {binding?.modelId && !model && (
            <option disabled value={binding.modelId}>
              목록에 없는 모델 · {binding.modelId}
            </option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.id}
            </option>
          ))}
        </select>
      </label>
      {model && model.variants.length > 0 && (
        <label>
          추론 강도
          <select
            aria-label={`${label} 추론 강도`}
            value={binding?.variant ?? ""}
            onChange={(e) =>
              onChange({
                connectionId: binding!.connectionId,
                modelId: binding!.modelId,
                ...(e.target.value ? { variant: e.target.value } : {}),
              })
            }
          >
            <option value="">CLI 기본값</option>
            {model.variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      {catalog?.error && <p className="field-error">{catalog.error}</p>}
      {!connection && (
        <p className="field-hint">
          CLI 연결 화면에서 설치한 서비스를 등록하세요.
        </p>
      )}
    </fieldset>
  );
}
