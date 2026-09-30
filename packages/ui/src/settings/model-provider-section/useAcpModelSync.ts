import { useRef, useState } from "react";
import type { AgentRuntimeInstallStatus } from "@zcode/services";
import { ACP_DEFAULT_MODEL_ID } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

export interface AcpSyncedModel {
  id: string;
  name: string;
  description?: string;
}

/**
 * “同步 Agent 模型”与逐个启用：模型目录由 Host 缓存所有，这里只保存本次同步结果的展示与
 * 进行中的开关状态。开关保存期间禁用其他开关，避免较晚完成的旧请求覆盖较新的选择。
 */
export function useAcpModelSync({
  status,
  workspacePath,
  workspaceIdentity,
  onSaved,
}: {
  status: AgentRuntimeInstallStatus;
  workspacePath: string;
  workspaceIdentity?: string;
  onSaved?: () => void;
}) {
  const { zcodeAgentService } = useServices();
  const [availableModels, setAvailableModels] = useState<AcpSyncedModel[] | null>(
    status.availableModels ? [...status.availableModels] : null,
  );
  const [enabledModelIds, setEnabledModelIds] = useState(
    () => new Set((status.models ?? []).map((model) => model.id)),
  );
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggleSavingRef = useRef(false);

  const sync = async () => {
    if (!workspacePath) return;
    setSaving(true);
    setSyncing(true);
    setError(null);
    try {
      const preview = await zcodeAgentService.discoverAgentRuntimeConfig({
        runtimeId: status.id,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        includeAllModelThoughtLevels: true,
      });
      const models = preview.models.length
        ? preview.models
        : [{ id: ACP_DEFAULT_MODEL_ID, name: "默认模型" }];
      setAvailableModels(models);
      setEnabledModelIds(
        (current) =>
          new Set(models.filter((model) => current.has(model.id)).map((model) => model.id)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
      setSaving(false);
    }
  };

  const toggle = async (modelId: string, checked: boolean) => {
    if (toggleSavingRef.current) return;
    toggleSavingRef.current = true;
    const previous = enabledModelIds;
    const next = new Set(previous);
    if (checked) next.add(modelId);
    else next.delete(modelId);
    setEnabledModelIds(next);
    setSaving(true);
    setError(null);
    try {
      await zcodeAgentService.saveAgentServerModels({
        runtimeId: status.id,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        modelIds: [...next],
      });
      onSaved?.();
    } catch (cause) {
      setEnabledModelIds(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      toggleSavingRef.current = false;
      setSaving(false);
    }
  };

  /** 配置路由改变后 Host 已清空目录，本地展示也必须丢弃旧 Agent 的模型。 */
  const reset = () => {
    setAvailableModels([]);
    setEnabledModelIds(new Set());
  };

  return {
    availableModels,
    enabledModelIds,
    syncing,
    saving,
    error,
    setError,
    sync,
    toggle,
    reset,
  };
}
