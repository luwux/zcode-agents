import { useState } from "react";
import { InfoIcon, Plus, RefreshCwIcon, Trash2 } from "lucide-react";
import type { AgentModelSettings, BuiltinRuntimeCatalogEntry } from "@zcode/services";
import {
  TID_ACP_BUILTIN_CONTROL,
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
import { disambiguateAcpModelName, extractAcpBenefitBadge } from "@/lib/modelSelectionGroups.js";
import { BuiltinAcpModelDialog } from "./BuiltinAcpModelDialog.js";
import { SortableProviderModelList } from "./SortableProviderModelList.js";
import { useAcpModelSync } from "./useAcpModelSync.js";
import type { BuiltinAcpStatus } from "./builtinAcpConfig.js";

export interface BuiltinAcpModelActions {
  add: (model: AgentModelSettings) => Promise<void>;
  update: (originalId: string, model: AgentModelSettings) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
}

const ROW = "flex items-center gap-2 px-3 py-2";
const NAME = "min-w-0 truncate font-mono text-ui-base text-foreground";

function ConfiguredModelRow({
  model,
  index,
  entry,
  models,
  actions,
}: {
  model: AgentModelSettings;
  index: number;
  entry: BuiltinRuntimeCatalogEntry;
  models: readonly AgentModelSettings[];
  actions: BuiltinAcpModelActions;
}) {
  const { intl, locale } = useZCodeIntl();
  const [editOpen, setEditOpen] = useState(false);
  const context = model.contextWindow
    ? formatModelContextWindowLabel(model.contextWindow, locale)
    : null;
  const contextLabel = context
    ? intl.formatMessage(
        { id: "settings.modelProvider.contextWindowBadgeLabel" },
        { value: context },
      )
    : null;
  const enabled = model.enabled !== false;
  return (
    <div className={ROW} data-testid={testId(TID_ACP_BUILTIN_CONTROL, `model-${index}`)}>
      {/* 手机或窄窗口下徽标不收缩，会挤掉模型名并压到操作按钮上；行宽不足时只显示名称（详情见编辑弹窗）。 */}
      <div className="@container/acp-model flex min-w-0 flex-1 items-center gap-2">
        <span className={NAME} title={model.name ? `${model.name} · ${model.id}` : model.id}>
          {model.name ?? model.id}
        </span>
        {context ? (
          <span
            className="hidden h-5 max-w-20 shrink-0 items-center truncate rounded-md border border-border bg-surface px-1.5 font-mono text-ui-sm text-foreground-subtle @xs/acp-model:inline-flex"
            aria-label={contextLabel ?? undefined}
            title={contextLabel ?? undefined}
          >
            {context}
          </span>
        ) : null}
        {model.vision ? (
          <ModelInputCapabilityBadge className="hidden @xs/acp-model:inline-flex" />
        ) : null}
      </div>
      <BuiltinAcpModelDialog
        mode="edit"
        entry={entry}
        models={models}
        editingIndex={index}
        open={editOpen}
        onOpenChange={setEditOpen}
        onCommit={(next) => actions.update(model.id, next)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-foreground-subtle"
        aria-label={intl.formatMessage({ id: "settings.modelProvider.delete" })}
        title={intl.formatMessage({ id: "settings.modelProvider.delete" })}
        data-testid={testId(TID_ACP_BUILTIN_CONTROL, `model-${index}-delete`)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void actions.remove(model.id).catch(() => undefined)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <Switch
        size="sm"
        checked={enabled}
        data-testid={testId(TID_ACP_BUILTIN_CONTROL, `model-${index}-enabled`)}
        aria-label={intl.formatMessage({
          id: enabled
            ? "settings.modelProvider.disableAction"
            : "settings.modelProvider.enableAction",
        })}
        onCheckedChange={(checked) =>
          void actions.setEnabled(model.id, checked).catch(() => undefined)
        }
      />
    </div>
  );
}

/**
 * 模型列表：BYOK 声明了模型时列出声明的模型（添加、编辑、删除、启停、拖动排序，保存到配置）；
 * 否则列出 Runtime 自己公布的模型（“同步 Agent 模型”后逐个启用）。
 */
export function BuiltinAcpModelsSection({
  status,
  entry,
  workspacePath,
  workspaceIdentity,
  actions,
  onSynced,
}: {
  status: BuiltinAcpStatus;
  entry: BuiltinRuntimeCatalogEntry;
  workspacePath: string;
  workspaceIdentity?: string;
  actions: BuiltinAcpModelActions;
  onSynced: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [addOpen, setAddOpen] = useState(false);
  const sync = useAcpModelSync({ status, workspacePath, workspaceIdentity, onSaved: onSynced });
  const byok = status.builtin.authMode === "byok";
  const configured = status.builtin.models;
  const showConfigured = byok && configured.length > 0;
  const synced = sync.availableModels ?? [];
  const text = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.modelProvider.builtinAcp.${id}` }, values);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.models" })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {showConfigured ? null : (
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              disabled={!status.installed || sync.saving || !workspacePath}
              data-testid={testId(TID_ACP_BUILTIN_CONTROL, "sync-models")}
              onClick={() => void sync.sync()}
            >
              <RefreshCwIcon
                data-icon="inline-start"
                className={sync.syncing ? "animate-spin" : undefined}
                aria-hidden="true"
              />
              {sync.syncing ? text("syncing") : text("syncModels")}
            </Button>
          )}
          {byok ? (
            <Button
              type="button"
              variant="secondary"
              className="rounded-lg"
              data-testid={TID_MODEL_PROVIDER_ADD_MODEL_BUTTON}
              onClick={() => setAddOpen(true)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelProvider.addModel" })}
            </Button>
          ) : null}
        </div>
      </div>
      {showConfigured ? (
        <div className="overflow-hidden rounded-lg border border-input-border bg-input">
          <SortableProviderModelList
            modelIds={configured.map((model) => model.id)}
            onReorder={(ids) => void actions.reorder(ids).catch(() => undefined)}
            renderModel={(_id, index) => (
              <ConfiguredModelRow
                model={configured[index]!}
                index={index}
                entry={entry}
                models={configured}
                actions={actions}
              />
            )}
          />
        </div>
      ) : synced.length ? (
        <>
          <p className="mb-2 text-ui-sm text-foreground-subtle">
            {text("agentModelsHint", { runtime: entry.name })}
          </p>
          <div className="overflow-hidden rounded-lg border border-input-border bg-input">
            <SortableProviderModelList
              modelIds={synced.map((model) => model.id)}
              renderModel={(_id, index) => {
                const model = synced[index]!;
                const badge = model.description
                  ? extractAcpBenefitBadge(model.description)
                  : undefined;
                return (
                  <label className={ROW}>
                    <span
                      className="flex min-w-0 flex-1 items-center gap-2"
                      title={[model.id, model.description].filter(Boolean).join(" · ")}
                    >
                      <span className="min-w-0 truncate text-ui-base text-foreground">
                        {disambiguateAcpModelName(model, synced)}
                      </span>
                      {badge ? (
                        <span className="inline-flex shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
                          {badge}
                        </span>
                      ) : null}
                    </span>
                    <Switch
                      size="sm"
                      disabled={sync.saving}
                      checked={sync.enabledModelIds.has(model.id)}
                      onCheckedChange={(checked) => void sync.toggle(model.id, checked)}
                    />
                  </label>
                );
              }}
            />
          </div>
        </>
      ) : (
        <div className="mt-1 flex min-h-12 items-center justify-start gap-2 rounded-lg border border-dashed border-border px-4 py-2 text-left text-ui-base text-foreground-subtle">
          <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
          {sync.availableModels === null && status.models?.length
            ? text("enabledCount", { count: String(status.models.length) })
            : byok
              ? intl.formatMessage({ id: "settings.modelProvider.modelsEmpty" })
              : text("agentModelsHint", { runtime: entry.name })}
        </div>
      )}
      {sync.error ? (
        <p role="alert" className="mt-2 text-ui-sm text-destructive">
          {sync.error}
        </p>
      ) : null}
      {byok ? (
        <BuiltinAcpModelDialog
          mode="add"
          entry={entry}
          models={configured}
          open={addOpen}
          onOpenChange={setAddOpen}
          onCommit={actions.add}
        />
      ) : null}
    </div>
  );
}
