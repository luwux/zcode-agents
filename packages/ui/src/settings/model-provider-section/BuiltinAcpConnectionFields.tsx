import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentAuthMode, BuiltinRuntimeCatalogEntry, PiEndpointApi } from "@zcode/services";
import type { ProviderApiType } from "@zcode/provider";
import { TID_ACP_BUILTIN_CONTROL, TID_MODEL_PROVIDER_BASE_URL_INPUT, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { ProviderApiFormatSelect } from "./ProviderApiFormatSelect.js";
import { ProviderApiKeySection } from "./ProviderCardSections.js";
import { findPreset, type BaseUrlIssue } from "./builtinAcpConfig.js";

// Pi 的 openai-completions 即供应商设置中的 Chat Completions；复用同一个 API 格式选择器。
const toProviderApi = (api: PiEndpointApi): ProviderApiType =>
  api === "openai-completions" ? "openai-chat-completions" : api;
const fromProviderApi = (api: ProviderApiType): PiEndpointApi =>
  api === "openai-chat-completions" ? "openai-completions" : api;

export const authModeMessageId = (mode: AgentAuthMode) =>
  `settings.modelProvider.builtinAcp.auth.${mode === "cli-login" ? "cliLogin" : mode}`;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      {children}
    </div>
  );
}

/** Enter 提交与自定义供应商卡片一致：失焦即提交，输入法确认候选的 Enter 不触发。 */
function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter" || isImeComposingKeyEvent({ nativeEvent: event.nativeEvent })) return;
  event.currentTarget.blur();
}

/**
 * 内置 ACP 配置的连接字段：认证方式、BYOK 的 Provider 预设、Base URL、API 格式（Pi 自定义端点）与 API Key。
 * 外观与自定义供应商卡片的连接区一致；Key 只写，已保存时以占位说明代替回显。
 */
export function BuiltinAcpConnectionFields({
  entry,
  auth,
  onAuthChange,
  presetId,
  onPresetChange,
  baseUrl,
  onBaseUrlChange,
  onBaseUrlCommit,
  baseUrlIssue,
  api,
  onApiChange,
  apiKey,
  onApiKeyChange,
  onApiKeyCommit,
  hasApiKey,
  onClearApiKey,
  disabled,
}: {
  entry: BuiltinRuntimeCatalogEntry;
  auth: AgentAuthMode;
  onAuthChange: (auth: AgentAuthMode) => void;
  presetId: string;
  onPresetChange: (presetId: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  onBaseUrlCommit?: () => void;
  baseUrlIssue?: BaseUrlIssue | null;
  api: PiEndpointApi | "";
  onApiChange: (api: PiEndpointApi) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  onApiKeyCommit?: () => void;
  hasApiKey: boolean;
  onClearApiKey?: () => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [keyVisible, setKeyVisible] = useState(false);
  const message = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.modelProvider.builtinAcp.${id}` }, values);
  const preset = findPreset(entry, presetId);
  const hintId =
    auth === "byok"
      ? "auth.byokHint"
      : auth === "subscription"
        ? "auth.subscriptionHint"
        : "auth.cliLoginHint";

  return (
    <>
      <Field label={message("signInMethod")}>
        <Select
          value={auth}
          disabled={disabled}
          onValueChange={(value) => onAuthChange(value as AgentAuthMode)}
        >
          <SelectTrigger
            size="lg"
            className="w-full justify-between"
            aria-label={message("signInMethod")}
            data-testid={testId(TID_ACP_BUILTIN_CONTROL, "auth")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {entry.authModes.map((mode) => (
              <SelectItem
                key={mode}
                value={mode}
                data-testid={testId(TID_ACP_BUILTIN_CONTROL, `auth-${mode}`)}
              >
                {intl.formatMessage({ id: authModeMessageId(mode) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {message(hintId, { runtime: entry.name })}
        </p>
      </Field>
      {auth === "byok" ? (
        <>
          <Field label={message("provider")}>
            <Select value={presetId} disabled={disabled} onValueChange={onPresetChange}>
              <SelectTrigger
                size="lg"
                className="w-full justify-between"
                aria-label={message("provider")}
                data-testid={testId(TID_ACP_BUILTIN_CONTROL, "preset")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {entry.presets.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    data-testid={testId(TID_ACP_BUILTIN_CONTROL, `preset-${item.id}`)}
                  >
                    {item.id === "custom" ? message("preset.custom") : item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}>
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              type="text"
              size="lg"
              disabled={disabled || preset?.baseUrlEditable === false}
              data-testid={TID_MODEL_PROVIDER_BASE_URL_INPUT}
              aria-invalid={baseUrlIssue ? true : undefined}
              value={preset?.baseUrlEditable === false ? "" : baseUrl}
              placeholder={
                preset?.baseUrlEditable === false
                  ? message("providerDefaultEndpoint")
                  : (preset?.baseUrl ??
                    intl.formatMessage({ id: "settings.modelProvider.baseUrlPlaceholder" }))
              }
              onChange={(event) => onBaseUrlChange(event.target.value)}
              onBlur={onBaseUrlCommit}
              onKeyDown={blurOnEnter}
            />
            {baseUrlIssue ? (
              <p role="alert" className="mt-1 text-ui-sm text-destructive">
                {message(baseUrlIssue)}
              </p>
            ) : null}
          </Field>
          {preset?.apiOptions ? (
            <Field label={intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}>
              <ProviderApiFormatSelect
                apiFormatOptions={preset.apiOptions.map(toProviderApi)}
                value={toProviderApi(api || preset.defaultApi || preset.apiOptions[0]!)}
                onChange={(value) => onApiChange(fromProviderApi(value))}
              />
            </Field>
          ) : null}
          <ProviderApiKeySection
            apiKeyValue={apiKey}
            apiKeyVisible={keyVisible}
            readOnly={disabled}
            placeholder={hasApiKey ? message("apiKeySavedPlaceholder") : undefined}
            inputTestId={testId(TID_ACP_BUILTIN_CONTROL, "api-key")}
            labelAction={
              hasApiKey && onClearApiKey ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto px-0 text-ui-sm text-foreground-subtle"
                  data-testid={testId(TID_ACP_BUILTIN_CONTROL, "clear-api-key")}
                  onClick={onClearApiKey}
                >
                  {message("clearApiKey")}
                </Button>
              ) : null
            }
            onApiKeyChange={onApiKeyChange}
            onApiKeyBlur={onApiKeyCommit ?? (() => undefined)}
            onApiKeyKeyDown={blurOnEnter}
            onToggleApiKeyVisibility={() => setKeyVisible((visible) => !visible)}
          />
        </>
      ) : null}
    </>
  );
}
