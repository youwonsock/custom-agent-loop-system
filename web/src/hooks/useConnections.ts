import { useState } from "react";
import { type LocalConnection, type ModelCatalog } from "../../../src/shared/domain";
import { api, id } from "../api";
import type { StudioData } from "./useStudioData";

export function useConnections(data: Pick<StudioData, "setCatalogs" | "target" | "setTarget" | "setNotice" | "setError">) {
  const {
    setCatalogs,
    target,
    setTarget,
    setNotice,
    setError,
  } = data;
  const [connectionForm, setConnectionForm] = useState<LocalConnection>({
      id: id(),
      label: "",
      type: "codex",
      binary: "codex",
    }),
    [connectionBusy, setConnectionBusy] = useState(false);
  const [querying, setQuerying] = useState<string | null>(null);
  const query = async (connectionId: string) => {
    if (querying) return;
    setQuerying(connectionId);
    setError("");
    try {
      const value = await api<ModelCatalog>(
        `/connections/${connectionId}/models/query`,
        "POST",
        { targetProjectPath: target },
      );
      setCatalogs((values) => [
        ...values.filter(
          (c) =>
            !(
              c.connectionId === value.connectionId &&
              c.targetProjectPath === value.targetProjectPath
            ),
        ),
        value,
      ]);
      setTarget(value.targetProjectPath);
      if (value.error) setError(value.error);
      else
        setNotice(
          `${value.models.length}개 모델을 조회했습니다. 사용할 모델을 선택하세요.`,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQuerying(null);
    }
  };

  return {
    connectionForm,
    setConnectionForm,
    connectionBusy,
    setConnectionBusy,
    querying,
    query,
  };
}
export type Connections = ReturnType<typeof useConnections>;
