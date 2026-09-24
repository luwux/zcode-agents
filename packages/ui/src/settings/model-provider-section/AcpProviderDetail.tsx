import { useState } from "react";
import { ArrowLeftIcon, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { AgentRuntimeInstallStatus } from "@zcode/services";
import { TID_ACP_BUILTIN_CONTROL, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useBuiltinAcpRuntimeCatalog } from "@/hooks/useBuiltinAcpRuntimes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { disambiguateAcpModelName, extractAcpBenefitBadge } from "@/lib/modelSelectionGroups.js";
import { BuiltinAcpCreateForm } from "./BuiltinAcpCreateForm.js";
import { BuiltinAcpProviderCard } from "./BuiltinAcpProviderCard.js";
import { isBuiltinAcpStatus } from "./builtinAcpConfig.js";
import { useAcpModelSync } from "./useAcpModelSync.js";

export function AcpProviderDetail({
  status,
  configPath,
  existingIds = [],
  onSaved,
  onStatuses,
  onRefresh,
  onDeleted,
  workspacePath,
  workspaceIdentity,
  create = false,
  onBack,
}: {
  status?: AgentRuntimeInstallStatus;
  configPath?: string;
  /** 已占用的 ACP ID（内置配置、自定义 ACP Server），新增内置配置时用于前置校验。 */
  existingIds?: readonly string[];
  onSaved?: (id: string) => void;
  /** 内置配置写入后 Host 返回的最新状态列表。 */
  onStatuses?: (statuses: AgentRuntimeInstallStatus[]) => void;
  onRefresh?: () => Promise<void>;
  onDeleted?: (id: string) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  create?: boolean;
  onBack?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { catalog, error: catalogError } = useBuiltinAcpRuntimeCatalog();
  const [createKind, setCreateKind] = useState<"custom" | "builtin">("custom");
  const refresh = onRefresh ?? (async () => undefined);
  const applyStatuses = onStatuses ?? (() => undefined);
  const catalogMessage = catalogError
    ? intl.formatMessage(
        { id: "settings.modelProvider.builtinAcp.catalogUnavailable" },
        { error: catalogError },
      )
    : null;

  if (!create && isBuiltinAcpStatus(status)) {
    return (
      <section className="space-y-4" aria-label="ACP 供应商">
        {catalog ? (
          <BuiltinAcpProviderCard
            status={status}
            catalog={catalog}
            workspacePath={workspacePath}
            {...(workspaceIdentity ? { workspaceIdentity } : {})}
            onStatuses={applyStatuses}
            onRefresh={refresh}
            onDeleted={() => onDeleted?.(status.id)}
          />
        ) : catalogMessage ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {catalogMessage}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label="ACP 供应商">
      {create ? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            {onBack ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="返回"
                onClick={onBack}
              >
                <ArrowLeftIcon className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
            <h2 className="truncate text-ui-lg font-semibold text-foreground">添加 ACP 供应商</h2>
          </div>
          {/* 规格 agent-runtime-selection：选择 ACP 后仍直接展示自定义命令表单；内置 Runtime 是同页的另一分段。 */}
          <Tabs
            value={createKind}
            onValueChange={(value) => setCreateKind(value as "custom" | "builtin")}
            className="gap-4"
          >
            <TabsList className="max-w-full">
              <TabsTrigger value="custom">
                {intl.formatMessage({ id: "settings.modelProvider.builtinAcp.createTab.custom" })}
              </TabsTrigger>
              <TabsTrigger
                value="builtin"
                data-testid={testId(TID_ACP_BUILTIN_CONTROL, "create-tab")}
              >
                {intl.formatMessage({ id: "settings.modelProvider.builtinAcp.createTab.builtin" })}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="custom">
              <CustomAcpServerDetail
                create
                configPath={configPath}
                workspacePath={workspacePath}
                {...(workspaceIdentity ? { workspaceIdentity } : {})}
                {...(onSaved ? { onSaved } : {})}
              />
            </TabsContent>
            <TabsContent value="builtin">
              {catalog ? (
                <BuiltinAcpCreateForm
                  catalog={catalog}
                  existingIds={existingIds}
                  onCreated={(id, statuses) => {
                    applyStatuses(statuses);
                    onSaved?.(id);
                  }}
                />
              ) : catalogMessage ? (
                <p role="alert" className="text-ui-sm text-destructive">
                  {catalogMessage}
                </p>
              ) : null}
            </TabsContent>
          </Tabs>
        </>
      ) : (
        <CustomAcpServerDetail
          status={status}
          configPath={configPath}
          workspacePath={workspacePath}
          {...(workspaceIdentity ? { workspaceIdentity } : {})}
          {...(onSaved ? { onSaved } : {})}
          {...(onDeleted ? { onDeleted } : {})}
        />
      )}
    </section>
  );
}

/** 自定义 ACP Server（agent-servers.json）：命令与参数的编辑、删除与模型同步。 */
function CustomAcpServerDetail({
  status,
  configPath,
  onSaved,
  onDeleted,
  workspacePath,
  workspaceIdentity,
  create = false,
}: {
  status?: AgentRuntimeInstallStatus;
  configPath?: string;
  onSaved?: (id: string) => void;
  onDeleted?: (id: string) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  create?: boolean;
}) {
  const { zcodeAgentService } = useServices();
  const confirmDialog = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [id, setId] = useState(status?.id ?? "");
  const [name, setName] = useState(status?.name ?? "");
  const [command, setCommand] = useState(status?.command ?? "");
  const [argsText, setArgsText] = useState(() => JSON.stringify(status?.args ?? []));
  const [editing, setEditing] = useState(create);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = useAcpModelSync({
    status: status ?? { id: "", name: "", installed: false, command: "" },
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    onSaved: () => (status ? onSaved?.(status.id) : undefined),
  });
  const editable = create || (status?.configured === true && editing);
  const busy = saving || sync.saving;
  const shownError = error ?? sync.error;

  const cancelEdit = () => {
    setName(status?.name ?? "");
    setCommand(status?.command ?? "");
    setArgsText(JSON.stringify(status?.args ?? []));
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    setError(null);
    let args: unknown;
    try {
      args = JSON.parse(argsText) as unknown;
    } catch {
      setError('参数必须是 JSON 字符串数组，例如 ["acp"]');
      return;
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      setError("参数必须是 JSON 字符串数组");
      return;
    }
    setSaving(true);
    try {
      await zcodeAgentService.saveAgentServer({ id, name, command, args });
      // 命令身份改变后旧模型缓存失效；本地列表也不能继续显示旧 Agent 的模型。
      if (
        status &&
        (status.command !== command || JSON.stringify(status.args ?? []) !== JSON.stringify(args))
      )
        sync.reset();
      setEditing(false);
      onSaved?.(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = async () => {
    if (!status?.configured || busy) return;
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "settings.modelProvider.deleteConfirmTitle" },
        { name: status.name },
      ),
      description: intl.formatMessage({ id: "settings.modelProvider.acpDeleteDescription" }),
      confirmLabel: intl.formatMessage({ id: "settings.modelProvider.deleteConfirmAction" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await zcodeAgentService.deleteAgentServer(status.id);
      onDeleted?.(status.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {create ? null : (
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-ui-lg font-semibold text-foreground">
            {status?.name}
          </h2>
          {status?.configured && !editing ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "common.more" })}
                  disabled={busy}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                  {intl.formatMessage({ id: "settings.modelProvider.acpEdit" })}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void deleteProvider()}>
                  <Trash2 className="size-3.5" />
                  {intl.formatMessage({ id: "common.delete" })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
      <p className="text-ui-sm text-foreground-subtle">
        ACP CLI 由执行 Agent 的 Host 启动；安装与认证由该 CLI 自己管理。
      </p>
      <p className="break-all text-ui-sm text-foreground-subtle">
        {/* 修复原因：内置运行时配置保存在 agent-configs.json；列表首项的路径只适用于新建自定义 ACP Server。 */}
        配置文件：{status?.configPath ?? configPath ?? "~/.codez/v2/agent-servers.json"}
      </p>
      {status ? (
        <div className="space-y-1 text-ui-sm">
          <p role={status.reason || !status.installed ? "alert" : undefined}>
            {status.reason ?? (status.installed ? "可执行文件已找到" : "不可用")}
          </p>
          <p className="text-foreground-subtle">
            项目记忆会按记忆开关注入；ACP 自动记忆提取尚未实现，Agent 原生记忆状态未统一验证。
          </p>
        </div>
      ) : null}
      {editable ? (
        <div className="grid gap-3">
          <label className="grid gap-1 text-ui-sm">
            稳定 ID
            <Input value={id} disabled={!create} onChange={(event) => setId(event.target.value)} />
          </label>
          <label className="grid gap-1 text-ui-sm">
            显示名称
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-ui-sm">
            命令绝对路径
            <Input value={command} onChange={(event) => setCommand(event.target.value)} />
          </label>
          <label className="grid gap-1 text-ui-sm">
            参数（JSON 字符串数组）
            <Input value={argsText} onChange={(event) => setArgsText(event.target.value)} />
          </label>
          {shownError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {shownError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            {!create ? (
              <Button type="button" variant="outline" disabled={busy} onClick={cancelEdit}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            ) : null}
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {saving ? "保存中…" : "保存 ACP 供应商"}
            </Button>
          </div>
        </div>
      ) : status ? (
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            disabled={!status.installed || busy || !workspacePath}
            onClick={() => void sync.sync()}
          >
            {sync.syncing ? "同步中…" : "同步 Agent 模型"}
          </Button>
          {sync.availableModels === null && status.models?.length ? (
            <p className="text-ui-sm text-foreground-subtle">
              已启用 {status.models.length} 个模型。同步后可重新勾选。
            </p>
          ) : null}
          {sync.availableModels?.map((model) => (
            <label
              key={model.id}
              className="flex min-h-10 items-center justify-between gap-3 border-b border-border/60 px-1 py-2 text-ui-base last:border-b-0"
            >
              <span
                className="min-w-0"
                title={[model.id, model.description].filter(Boolean).join(" · ")}
              >
                <span className="break-words text-foreground">
                  {disambiguateAcpModelName(model, sync.availableModels!)}
                </span>
                {model.description && extractAcpBenefitBadge(model.description) ? (
                  <span className="ml-2 inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
                    {extractAcpBenefitBadge(model.description)}
                  </span>
                ) : null}
              </span>
              <Switch
                disabled={busy}
                checked={sync.enabledModelIds.has(model.id)}
                onCheckedChange={(checked) => void sync.toggle(model.id, checked)}
              />
            </label>
          ))}
          {shownError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {shownError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
