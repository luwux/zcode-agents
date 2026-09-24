import { useRef, useState } from "react";
import { ArrowLeftIcon, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { AgentRuntimeInstallStatus } from "@zcode/services";
import { ACP_DEFAULT_MODEL_ID } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { disambiguateAcpModelName, extractAcpBenefitBadge } from "@/lib/modelSelectionGroups.js";

export function AcpProviderDetail({
  status,
  configPath,
  onSaved,
  onDeleted,
  workspacePath,
  workspaceIdentity,
  create = false,
  onBack,
}: {
  status?: AgentRuntimeInstallStatus;
  configPath?: string;
  onSaved?: (id: string) => void;
  onDeleted?: (id: string) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  create?: boolean;
  onBack?: () => void;
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
  const [syncing, setSyncing] = useState(false);
  const toggleSavingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<Array<{
    id: string;
    name: string;
    description?: string;
  }> | null>(status?.availableModels ? [...status.availableModels] : null);
  const [enabledModelIds, setEnabledModelIds] = useState(
    () => new Set((status?.models ?? []).map((model) => model.id)),
  );
  const editable = create || (status?.configured === true && editing);

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
      if (
        status &&
        (status.command !== command || JSON.stringify(status.args ?? []) !== JSON.stringify(args))
      ) {
        // 命令身份改变后旧模型缓存失效；本地列表也不能继续显示旧 Agent 的模型。
        setAvailableModels([]);
        setEnabledModelIds(new Set());
      }
      setEditing(false);
      onSaved?.(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = async () => {
    if (!status?.configured || saving) return;
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

  const syncModels = async () => {
    if (!status || !workspacePath) return;
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

  const toggleModel = async (modelId: string, checked: boolean) => {
    if (!status || toggleSavingRef.current) return;
    toggleSavingRef.current = true;
    const previous = enabledModelIds;
    const next = new Set(previous);
    if (checked) next.add(modelId);
    else next.delete(modelId);
    // 保存期间禁用其他开关，避免较晚完成的旧请求覆盖较新的选择。
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
      onSaved?.(status.id);
    } catch (cause) {
      setEnabledModelIds(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      toggleSavingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4" aria-label="ACP 供应商">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {create && onBack ? (
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
            <h2 className="truncate text-ui-lg font-semibold text-foreground">
              {create ? "添加 ACP 供应商" : status?.name}
            </h2>
          </div>
          {status?.configured && !editing ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "common.more" })}
                  disabled={saving}
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
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          ACP CLI 由执行 Agent 的 Host 启动；安装与认证由该 CLI 自己管理。
        </p>
      </div>
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
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            {!create ? (
              <Button type="button" variant="outline" disabled={saving} onClick={cancelEdit}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            ) : null}
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? "保存中…" : "保存 ACP 供应商"}
            </Button>
          </div>
        </div>
      ) : status ? (
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            disabled={!status.installed || saving || !workspacePath}
            onClick={() => void syncModels()}
          >
            {syncing ? "同步中…" : "同步 Agent 模型"}
          </Button>
          {availableModels === null && status.models?.length ? (
            <p className="text-ui-sm text-foreground-subtle">
              已启用 {status.models.length} 个模型。同步后可重新勾选。
            </p>
          ) : null}
          {availableModels?.map((model) => (
            <label
              key={model.id}
              className="flex min-h-10 items-center justify-between gap-3 border-b border-border/60 px-1 py-2 text-ui-base last:border-b-0"
            >
              <span
                className="min-w-0"
                title={[model.id, model.description].filter(Boolean).join(" · ")}
              >
                <span className="break-words text-foreground">
                  {disambiguateAcpModelName(model, availableModels)}
                </span>
                {model.description && extractAcpBenefitBadge(model.description) ? (
                  <span className="ml-2 inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
                    {extractAcpBenefitBadge(model.description)}
                  </span>
                ) : null}
              </span>
              <Switch
                disabled={saving}
                checked={enabledModelIds.has(model.id)}
                onCheckedChange={(checked) => void toggleModel(model.id, checked)}
              />
            </label>
          ))}
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
