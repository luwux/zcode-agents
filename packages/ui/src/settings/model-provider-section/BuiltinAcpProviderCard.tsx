import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  AgentModelSettings,
  AgentRuntimeInstallStatus,
  BuiltinRuntimeCatalogView,
  SaveBuiltinRuntimeConfigInput,
} from "@zcode/services";
import { TID_ACP_BUILTIN_CONTROL, testId } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { BuiltinAcpConnectionFields } from "./BuiltinAcpConnectionFields.js";
import { BuiltinAcpModelsSection, type BuiltinAcpModelActions } from "./BuiltinAcpModelsSection.js";
import { BuiltinAcpSignInPanel } from "./BuiltinAcpSignInPanel.js";
import { ProviderCardHeader } from "./ProviderCardSections.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { useBuiltinAcpConfigWriter } from "./useBuiltinAcpConfigWriter.js";
import {
  configFromStatus,
  configModels,
  currentPresetId,
  effectiveBaseUrl,
  reorderModels,
  routingKey,
  toSaveInput,
  validateBaseUrl,
  withApiFormat,
  withAuth,
  withBaseUrl,
  withEnabled,
  withModels,
  withName,
  withPreset,
  type BaseUrlIssue,
  type BuiltinAcpConfig,
  type BuiltinAcpStatus,
} from "./builtinAcpConfig.js";

type SaveTarget = { model?: string; operation?: "delete" };

/** 标题栏图标沿用供应商图标素材（Pi 无对应素材，使用通用图标）。 */
const RUNTIME_LOGOS: Partial<Record<BuiltinAcpStatus["builtin"]["runtime"], string>> = {
  "claude-code": "anthropic",
  codex: "openai",
};

/**
 * 内置 ACP Runtime 配置卡片：结构与自定义供应商卡片一致（标题栏开关与菜单、连接字段、API Key、模型列表），
 * 订阅/本机登录时以登录面板代替 Key。所有修改立即保存（与自定义供应商卡片相同的失焦/切换即保存），
 * 经同一个串行写入入口提交给 Host。
 */
export function BuiltinAcpProviderCard({
  status,
  catalog,
  workspacePath,
  workspaceIdentity,
  onStatuses,
  onRefresh,
  onDeleted,
}: {
  status: BuiltinAcpStatus;
  catalog: BuiltinRuntimeCatalogView;
  workspacePath: string;
  workspaceIdentity?: string;
  onStatuses: (statuses: AgentRuntimeInstallStatus[]) => void;
  onRefresh: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { zcodeAgentService } = useServices();
  const confirmDialog = useConfirmDialog();
  const { showFeedback } = useProviderDetailFeedback();
  const writer = useBuiltinAcpConfigWriter({ status, onStatuses });
  const entry = catalog.runtimes.find((item) => item.runtime === status.builtin.runtime)!;
  const saved = configFromStatus(status);
  const presetId = currentPresetId(saved, entry);
  const savedBaseUrl = effectiveBaseUrl(saved, entry);
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [baseUrlIssue, setBaseUrlIssue] = useState<BaseUrlIssue | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(status.name);
  const [enabledSaving, setEnabledSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const text = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.modelProvider.builtinAcp.${id}` }, values);

  // Host 状态（预设、端点、名称）改变时以已保存值为准；未提交的输入只在本次编辑内有效。
  useEffect(() => {
    setBaseUrl(savedBaseUrl);
    setBaseUrlIssue(null);
  }, [savedBaseUrl]);
  useEffect(() => {
    if (!editingName) setNameValue(status.name);
  }, [editingName, status.name]);

  const save = async (
    build: (config: BuiltinAcpConfig) => SaveBuiltinRuntimeConfigInput,
    target: SaveTarget = {},
  ) => {
    const key = target.model
      ? `builtin-acp-model:${status.id}:${target.model}`
      : `builtin-acp:${status.id}`;
    const values = { provider: status.name, model: target.model ?? "" };
    const ids = target.model
      ? target.operation === "delete"
        ? ["modelDeleting", "modelDeleteSuccess", "modelDeleteFailure"]
        : ["modelSaving", "modelSaveSuccess", "modelSaveFailure"]
      : ["providerSaving", "providerSaveSuccess", "providerSaveFailure"];
    const message = (index: number, extra: Record<string, string> = {}) =>
      intl.formatMessage({ id: `settings.modelProvider.${ids[index]}` }, { ...values, ...extra });
    showFeedback({ key, state: "pending", message: message(0), durationMs: 0 });
    try {
      await writer.write(build);
      showFeedback({ key, state: "success", message: message(1) });
    } catch (error) {
      showFeedback({
        key,
        state: "failure",
        message: message(2, { error: error instanceof Error ? error.message : String(error) }),
        durationMs: 8_000,
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      });
      throw error;
    }
  };
  const saveConfig = (patch: (config: BuiltinAcpConfig) => BuiltinAcpConfig) =>
    save((config) => toSaveInput(patch(config))).catch(() => undefined);
  const saveModels = (
    change: (models: AgentModelSettings[]) => AgentModelSettings[],
    target: SaveTarget,
  ) => save((config) => toSaveInput(withModels(config, change(configModels(config)))), target);

  const models: BuiltinAcpModelActions = {
    add: (model) => saveModels((current) => [...current, model], { model: model.id }),
    update: (originalId, model) =>
      saveModels((current) => current.map((item) => (item.id === originalId ? model : item)), {
        model: model.id,
      }),
    remove: (id) =>
      saveModels((current) => current.filter((item) => item.id !== id), {
        model: id,
        operation: "delete",
      }),
    setEnabled: (id, enabled) =>
      saveModels(
        (current) =>
          current.map((item) => {
            if (item.id !== id) return item;
            const { enabled: _previous, ...rest } = item;
            return enabled ? rest : { ...rest, enabled: false };
          }),
        { model: id },
      ),
    reorder: (ids) => saveModels((current) => reorderModels(current, ids), {}),
  };

  const commitBaseUrl = () => {
    if (baseUrl.trim() === savedBaseUrl) return;
    const issue = validateBaseUrl(entry, presetId, baseUrl);
    setBaseUrlIssue(issue);
    if (!issue) void saveConfig((config) => withBaseUrl(config, entry, baseUrl));
  };
  const commitApiKey = () => {
    const key = apiKey.trim();
    if (!key) return;
    // Key 只写：保存成功后清空输入框，界面只显示“已保存”，失败时保留输入以便重试。
    void save((config) => toSaveInput(config, { apiKey: key })).then(
      () => setApiKey(""),
      () => undefined,
    );
  };
  const commitName = () => {
    setEditingName(false);
    const name = nameValue.trim();
    if (name && name !== status.name) void saveConfig((config) => withName(config, name));
    else setNameValue(status.name);
  };
  const onNameKeyDown = (event: KeyboardEvent) => {
    if (isImeComposingKeyEvent({ nativeEvent: event.nativeEvent })) return;
    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
    if (event.key === "Escape") {
      setNameValue(status.name);
      setEditingName(false);
    }
  };

  const overridesDefault = catalog.defaultConfigIds.includes(status.id);
  const remove = async () => {
    const confirmed = await confirmDialog({
      title: overridesDefault
        ? text("resetTitle", { name: status.name })
        : intl.formatMessage(
            { id: "settings.modelProvider.deleteConfirmTitle" },
            { name: status.name },
          ),
      description: text(overridesDefault ? "resetDescription" : "deleteDescription"),
      confirmLabel: overridesDefault
        ? text("resetAction")
        : intl.formatMessage({ id: "settings.modelProvider.deleteConfirmAction" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    try {
      onStatuses(await zcodeAgentService.deleteAgentRuntimeConfig(status.id));
      onDeleted();
    } catch (error) {
      showFeedback({
        key: `builtin-acp:${status.id}`,
        state: "failure",
        message: error instanceof Error ? error.message : String(error),
        durationMs: 8_000,
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      });
    }
  };

  // 登录失败原因由登录面板展示（登录提示优先），不在卡片顶部重复。
  const showSignIn = saved.auth !== "byok" && (entry.signIn || saved.auth === "subscription");
  const enabledLabel = intl.formatMessage({
    id: saved.enabled
      ? "settings.modelProvider.disableProvider"
      : "settings.modelProvider.enableProvider",
  });

  return (
    <div className="space-y-3" data-testid={testId(TID_ACP_BUILTIN_CONTROL, "card")}>
      <ProviderCardHeader
        providerName={status.name}
        logo={
          RUNTIME_LOGOS[status.builtin.runtime]
            ? { type: "builtin", key: RUNTIME_LOGOS[status.builtin.runtime]! }
            : undefined
        }
        editingName={editingName}
        nameValue={nameValue}
        nameInputRef={nameInputRef}
        nameEditable
        onNameChange={setNameValue}
        onNameBlur={commitName}
        onNameKeyDown={onNameKeyDown}
        onStartEditName={() => {
          setEditingName(true);
          requestAnimationFrame(() => nameInputRef.current?.focus());
        }}
        // 默认配置未落盘，没有可删除的条目；覆盖默认 ID 的配置删除即恢复默认。
        onDelete={status.builtin.isDefault ? undefined : () => void remove()}
        deleteLabel={overridesDefault ? text("resetAction") : undefined}
        providerToggle={
          <ControlHintTooltip standalone title={enabledLabel}>
            <span className="inline-flex">
              <Switch
                className="after:-inset-x-1"
                data-testid={testId(TID_ACP_BUILTIN_CONTROL, "enabled")}
                aria-label={enabledLabel}
                checked={saved.enabled}
                disabled={enabledSaving}
                onCheckedChange={(enabled) => {
                  setEnabledSaving(true);
                  void saveConfig((config) => withEnabled(config, enabled)).finally(() =>
                    setEnabledSaving(false),
                  );
                }}
              />
            </span>
          </ControlHintTooltip>
        }
      />
      <p className="text-ui-sm text-foreground-subtle">
        {text("description", { runtime: entry.name, version: status.builtin.version })}
        {status.installHint ? ` ${status.installHint}` : ""}
      </p>
      {status.reason && !(showSignIn && status.builtin.authState === "auth-required") ? (
        <p
          role="alert"
          className="text-ui-sm text-warning"
          data-testid={testId(TID_ACP_BUILTIN_CONTROL, "reason")}
        >
          {status.reason}
        </p>
      ) : null}
      <BuiltinAcpConnectionFields
        entry={entry}
        auth={saved.auth}
        onAuthChange={(auth) => void saveConfig((config) => withAuth(config, auth))}
        presetId={presetId}
        onPresetChange={(id) => void saveConfig((config) => withPreset(config, id))}
        baseUrl={baseUrl}
        onBaseUrlChange={(value) => {
          setBaseUrl(value);
          setBaseUrlIssue(null);
        }}
        onBaseUrlCommit={commitBaseUrl}
        baseUrlIssue={baseUrlIssue}
        api={saved.provider?.api ?? ""}
        onApiChange={(api) => void saveConfig((config) => withApiFormat(config, api))}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        onApiKeyCommit={commitApiKey}
        hasApiKey={status.builtin.hasApiKey}
        onClearApiKey={() =>
          void save((config) => toSaveInput(config, { apiKey: null })).catch(() => undefined)
        }
      />
      {showSignIn ? (
        <BuiltinAcpSignInPanel status={status} entry={entry} onRefresh={onRefresh} />
      ) : null}
      <BuiltinAcpModelsSection
        // 认证方式或路由改变后 Host 已清空同步目录；声明模型与 Runtime 公布模型之间切换时来源也不同，
        // 模型区按新状态重新初始化，不沿用旧来源的列表。
        key={`${routingKey(saved)}:${status.builtin.models.length > 0 ? "declared" : "agent"}`}
        status={status}
        entry={entry}
        workspacePath={workspacePath}
        {...(workspaceIdentity ? { workspaceIdentity } : {})}
        actions={models}
        onSynced={() => void onRefresh()}
      />
      <p className="break-all text-ui-sm text-foreground-subtlest">
        {text("configFile", { path: status.configPath ?? "" })}
      </p>
    </div>
  );
}
