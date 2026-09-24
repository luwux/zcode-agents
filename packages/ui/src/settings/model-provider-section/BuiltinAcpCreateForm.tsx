import { useState, type ReactNode } from "react";
import type { AgentRuntimeInstallStatus, BuiltinRuntimeCatalogView } from "@zcode/services";
import { TID_ACP_BUILTIN_CONTROL, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { BuiltinAcpConnectionFields, authModeMessageId } from "./BuiltinAcpConnectionFields.js";
import {
  createDraft,
  createInput,
  findPreset,
  suggestIdentity,
  validateCreate,
  type CreateDraft,
  type CreateIssue,
} from "./builtinAcpConfig.js";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      {children}
    </div>
  );
}

/**
 * ACP 添加页的「内置 Runtime」分段：选择 Runtime、ID 与名称，并复用详情页的连接字段。
 * 创建以 `create: true` 提交，Host 拒绝占用已存在的 ID；成功后进入该配置的详情继续添加模型或登录。
 */
export function BuiltinAcpCreateForm({
  catalog,
  existingIds,
  onCreated,
}: {
  catalog: BuiltinRuntimeCatalogView;
  existingIds: readonly string[];
  onCreated: (id: string, statuses: AgentRuntimeInstallStatus[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const { zcodeAgentService } = useServices();
  const initial = catalog.runtimes.find((item) => !item.unsupportedReason) ?? catalog.runtimes[0]!;
  const [draft, setDraft] = useState<CreateDraft>(() => createDraft(initial));
  const [issue, setIssue] = useState<CreateIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const entry = catalog.runtimes.find((item) => item.runtime === draft.runtime) ?? initial;
  const text = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.modelProvider.builtinAcp.${id}` }, values);
  const preset = findPreset(entry, draft.preset);
  const detail =
    draft.auth === "byok"
      ? preset?.id === "custom"
        ? text("preset.custom")
        : (preset?.name ?? draft.preset)
      : intl.formatMessage({ id: authModeMessageId(draft.auth) });
  const suggestion = suggestIdentity(entry, draft, detail, existingIds);
  // 未手动修改前，ID 与名称随 Runtime / 认证方式 / 预设自动建议。
  const effective: CreateDraft = {
    ...draft,
    id: draft.idTouched ? draft.id : suggestion.id,
    name: draft.nameTouched ? draft.name : suggestion.name,
  };
  const update = (patch: Partial<CreateDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setIssue(null);
    setError(null);
  };

  const submit = async () => {
    const found = validateCreate(effective, entry, existingIds);
    setIssue(found);
    if (found || saving) return;
    setSaving(true);
    try {
      const statuses = await zcodeAgentService.saveAgentRuntimeConfig(
        createInput(effective, entry),
      );
      onCreated(effective.id.trim(), statuses);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3" data-testid={testId(TID_ACP_BUILTIN_CONTROL, "create")}>
      <p className="text-ui-sm text-foreground-subtle">{text("createHint")}</p>
      <Field label={text("runtime")}>
        <Select
          value={draft.runtime}
          onValueChange={(runtime) => {
            const next = catalog.runtimes.find((item) => item.runtime === runtime);
            if (!next) return;
            setDraft((current) => ({
              ...createDraft(next),
              id: current.id,
              name: current.name,
              idTouched: current.idTouched,
              nameTouched: current.nameTouched,
            }));
            setIssue(null);
            setError(null);
          }}
        >
          <SelectTrigger
            size="lg"
            className="w-full justify-between"
            aria-label={text("runtime")}
            data-testid={testId(TID_ACP_BUILTIN_CONTROL, "runtime")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {catalog.runtimes.map((item) => (
              <SelectItem
                key={item.runtime}
                value={item.runtime}
                disabled={Boolean(item.unsupportedReason)}
                title={item.unsupportedReason}
                data-testid={testId(TID_ACP_BUILTIN_CONTROL, `runtime-${item.runtime}`)}
              >
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={text("configId")}>
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            size="lg"
            className="font-mono"
            value={effective.id}
            data-testid={testId(TID_ACP_BUILTIN_CONTROL, "config-id")}
            onChange={(event) => update({ id: event.target.value, idTouched: true })}
          />
        </Field>
        <Field label={text("displayName")}>
          <Input
            size="lg"
            value={effective.name}
            data-testid={testId(TID_ACP_BUILTIN_CONTROL, "config-name")}
            onChange={(event) => update({ name: event.target.value, nameTouched: true })}
          />
        </Field>
      </div>
      <BuiltinAcpConnectionFields
        entry={entry}
        auth={draft.auth}
        onAuthChange={(auth) => update({ auth })}
        presetId={draft.preset}
        onPresetChange={(presetId) =>
          update({
            preset: presetId,
            baseUrl: findPreset(entry, presetId)?.baseUrl ?? "",
            api: findPreset(entry, presetId)?.defaultApi ?? "",
          })
        }
        baseUrl={draft.baseUrl}
        onBaseUrlChange={(baseUrl) => update({ baseUrl })}
        api={draft.api}
        onApiChange={(api) => update({ api })}
        apiKey={draft.apiKey}
        onApiKeyChange={(apiKey) => update({ apiKey })}
        hasApiKey={false}
        disabled={saving}
      />
      {draft.auth === "byok" ? (
        <Field label={text("model")}>
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            size="lg"
            className="font-mono"
            value={draft.model}
            placeholder={text("modelPlaceholder")}
            data-testid={testId(TID_ACP_BUILTIN_CONTROL, "create-model")}
            onChange={(event) => update({ model: event.target.value })}
          />
        </Field>
      ) : null}
      {issue || error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error ?? text(`issue.${issue}`)}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        <Button
          type="button"
          disabled={saving}
          data-testid={testId(TID_ACP_BUILTIN_CONTROL, "create-submit")}
          onClick={() => void submit()}
        >
          {saving ? text("creating") : text("create")}
        </Button>
      </div>
    </div>
  );
}
