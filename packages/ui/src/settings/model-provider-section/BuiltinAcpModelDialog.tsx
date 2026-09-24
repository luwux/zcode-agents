import { useEffect, useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import type { AgentModelSettings, BuiltinRuntimeCatalogEntry } from "@zcode/services";
import { TID_ACP_BUILTIN_CONTROL, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { BooleanModelOption } from "./ProviderModelMetadataFields.js";
import {
  ModelConfigDraftFeedback,
  ProviderModelMetadataDialogActions,
} from "./ProviderModelMetadataDialogActions.js";
import { ModelSettingsGroup } from "./ProviderModelSettingsGroups.js";
import { modelEditorControlStyle } from "./modelEditorControlStyle.js";
import {
  modelDraft,
  modelFromDraft,
  validateModelDraft,
  type ModelDraft,
  type ModelDraftIssue,
} from "./builtinAcpConfig.js";

/**
 * 内置 ACP 声明模型的添加/编辑弹窗：外观沿用自定义供应商的模型编辑器，只展示该 Runtime 真正使用的字段。
 * 提交完成（Host 保存成功）后才关闭，失败时保留草稿并显示原因。
 */
export function BuiltinAcpModelDialog({
  mode,
  entry,
  models,
  editingIndex,
  open,
  onOpenChange,
  onCommit,
}: {
  mode: "add" | "edit";
  entry: BuiltinRuntimeCatalogEntry;
  models: readonly AgentModelSettings[];
  editingIndex?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommit: (model: AgentModelSettings) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const previous = editingIndex === undefined ? undefined : models[editingIndex];
  const [draft, setDraft] = useState<ModelDraft>(() => modelDraft(entry, previous));
  const [issue, setIssue] = useState<ModelDraftIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fields = entry.modelFields;

  useEffect(() => {
    if (!open) return;
    setDraft(modelDraft(entry, previous));
    setIssue(null);
    setError(null);
    // 每次打开都从已保存的模型重新开始编辑。
  }, [open]);

  const change = (patch: Partial<ModelDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setIssue(null);
    setError(null);
  };
  const commit = async () => {
    if (saving) return;
    const found = validateModelDraft({ draft, entry, models, editingIndex });
    if (found) {
      setIssue(found);
      return;
    }
    setSaving(true);
    try {
      await onCommit(modelFromDraft(draft, entry, previous));
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || isImeComposingKeyEvent({ nativeEvent: event.nativeEvent })) return;
    event.preventDefault();
    void commit();
  };
  const message = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.modelProvider.builtinAcp.${id}` }, values);
  const issueMessage = issue
    ? message(`issue.${issue}`, { runtime: entry.name, max: entry.maxModels })
    : null;
  const editLabel = intl.formatMessage({ id: "settings.modelProvider.editModel" });
  const numberInput = (
    value: string,
    onChange: (value: string) => void,
    field: "contextWindow" | "maxTokens",
  ) => (
    <div>
      <label className="mb-1 block text-ui-base text-foreground-subtle">{message(field)}</label>
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        type="text"
        inputMode="numeric"
        size="lg"
        value={value}
        placeholder={message("runtimeDefault")}
        className={modelEditorControlStyle(false)}
        data-testid={testId(TID_ACP_BUILTIN_CONTROL, `model-${field}`)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      {mode === "edit" ? (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 p-0"
            aria-label={editLabel}
            title={editLabel}
          >
            <Pencil className="size-3.5 text-foreground-subtle" />
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        className="max-h-[min(48rem,calc(100vh-4rem))] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-clip"
        data-no-model-drag="true"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {intl.formatMessage({
              id: mode === "add" ? "settings.modelProvider.addModel" : editLabel,
            })}
          </DialogTitle>
          <DialogDescription className="sr-only">{entry.name}</DialogDescription>
        </DialogHeader>
        <div inert={saving} className="min-h-0 min-w-0 -mr-3 space-y-4 overflow-y-auto pr-4">
          <ModelSettingsGroup group="basic">
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProvider.modelId" })}
              </label>
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                type="text"
                autoFocus
                size="lg"
                className={cn("font-mono", modelEditorControlStyle(false))}
                value={draft.id}
                placeholder={message("modelPlaceholder")}
                data-testid={testId(TID_ACP_BUILTIN_CONTROL, "model-id")}
                onChange={(event) => change({ id: event.target.value })}
                onKeyDown={onKeyDown}
              />
            </div>
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {message("displayName")}
              </label>
              <Input
                type="text"
                size="lg"
                className={modelEditorControlStyle(false)}
                value={draft.name}
                placeholder={draft.id.trim() || undefined}
                onChange={(event) => change({ name: event.target.value })}
                onKeyDown={onKeyDown}
              />
            </div>
          </ModelSettingsGroup>
          {fields.contextWindow || fields.maxTokens ? (
            <ModelSettingsGroup group="tokens">
              {fields.contextWindow
                ? numberInput(
                    draft.contextWindow,
                    (contextWindow) => change({ contextWindow }),
                    "contextWindow",
                  )
                : null}
              {fields.maxTokens
                ? numberInput(draft.maxTokens, (maxTokens) => change({ maxTokens }), "maxTokens")
                : null}
            </ModelSettingsGroup>
          ) : null}
          {fields.vision ? (
            <ModelSettingsGroup group="modalities">
              <div className="flex flex-wrap gap-2">
                <BooleanModelOption
                  label={message("vision")}
                  selected={draft.vision}
                  onToggle={() => change({ vision: !draft.vision })}
                />
              </div>
            </ModelSettingsGroup>
          ) : null}
          <ModelSettingsGroup group="reasoning">
            {fields.reasoning ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-ui-base text-foreground">
                  <span>{message("reasoning")}</span>
                  <Switch
                    aria-label={message("reasoning")}
                    checked={draft.reasoning}
                    data-testid={testId(TID_ACP_BUILTIN_CONTROL, "model-reasoning")}
                    onCheckedChange={(reasoning) => change({ reasoning })}
                  />
                </div>
                {draft.reasoning ? (
                  <div>
                    <div className="mb-1 text-ui-base text-foreground-subtle">
                      {message("reasoningLevels")}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {entry.reasoningLevels.map((level) => {
                        const selected = draft.reasoningLevels.includes(level);
                        return (
                          <BooleanModelOption
                            key={level}
                            label={message(`level.${level}`)}
                            selected={selected}
                            onToggle={() =>
                              change({
                                reasoningLevels: selected
                                  ? draft.reasoningLevels.filter((item) => item !== level)
                                  : [...draft.reasoningLevels, level],
                              })
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-ui-sm text-foreground-subtle">{message("claudeReasoningHint")}</p>
            )}
          </ModelSettingsGroup>
        </div>
        <ModelConfigDraftFeedback error={error ?? issueMessage} />
        <ProviderModelMetadataDialogActions
          // 与供应商模型编辑器一致，操作按钮靠右（该弹窗没有“恢复推荐”操作）。
          leadingAction={<span aria-hidden="true" />}
          saveLabel={intl.formatMessage({ id: "common.save" })}
          cancelLabel={intl.formatMessage({ id: "common.cancel" })}
          saving={saving}
          onSave={() => void commit()}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
