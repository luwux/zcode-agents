import { useEffect, useState } from "react";
import { CircleIcon, CopyIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import type { BuiltinRuntimeAuthResult, BuiltinRuntimeCatalogEntry } from "@zcode/services";
import { TID_ACP_BUILTIN_CONTROL, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { BuiltinAcpStatus } from "./builtinAcpConfig.js";
import {
  isOpenableSignInUrl,
  parseSignInMessage,
  signInNeedsTerminal,
  signInScriptCommand,
} from "./builtinAcpSignInMessage.js";

const PASTE_CODE_PROMPT = /paste code here/i;
const PASTE_CODE_LINE = /^.*paste code here.*$/gim;

const STATE_PRESENTATION = {
  authenticated: { id: "state.authenticated", color: "text-success" },
  authenticating: { id: "state.authenticating", color: "text-foreground-subtle" },
  "auth-required": { id: "state.authRequired", color: "text-warning" },
  unknown: { id: "state.unknown", color: "text-foreground-subtlest" },
} as const;

/**
 * 订阅 / 本机 CLI 登录：状态来自 Host（AcpAuthStateStore），登录进行中与结束后由认证事件触发刷新。
 * 登录返回的 URL 经平台服务打开，设备码可选中与复制；需要交互式终端时给出脚本命令。
 */
export function BuiltinAcpSignInPanel({
  status,
  entry,
  onRefresh,
}: {
  status: BuiltinAcpStatus;
  entry: BuiltinRuntimeCatalogEntry;
  onRefresh: () => Promise<void> | void;
}) {
  const { zcodeAgentService } = useServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState<"sign-in" | "device" | "sign-out" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const auth = status.builtin.authMode;
  const state = status.builtin.authState;
  const text = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.modelProvider.builtinAcp.${id}` }, values);

  // 登录完成后不再需要登录 URL/设备码。
  useEffect(() => {
    if (state === "authenticated") setMessage(null);
  }, [state]);

  const run = async (
    kind: "sign-in" | "device" | "sign-out",
    action: () => Promise<BuiltinRuntimeAuthResult>,
  ) => {
    setPending(kind);
    setError(null);
    try {
      const result = await action();
      setMessage(result.message ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
      await onRefresh();
    }
  };
  const signIn = (deviceAuth: boolean) =>
    void run(deviceAuth ? "device" : "sign-in", () =>
      zcodeAgentService.loginAgentRuntime({
        runtimeId: status.id,
        ...(deviceAuth ? { deviceAuth: true } : {}),
      }),
    );
  const signOut = () =>
    void run("sign-out", () => zcodeAgentService.logoutAgentRuntime({ runtimeId: status.id }));
  const submitCode = async () => {
    const value = code.trim();
    if (!value) return;
    setSubmittingCode(true);
    setError(null);
    try {
      await zcodeAgentService.submitAgentRuntimeLoginCode({ runtimeId: status.id, code: value });
      setCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmittingCode(false);
    }
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch (cause) {
      logger.warn("[BuiltinAcpSignIn] 复制设备码失败", cause);
    }
  };

  const busy = pending !== null || state === "authenticating";
  const presentation = STATE_PRESENTATION[state];
  // 失败原因由 Host 放在 reason 中（如 “Sign-in failed: …”）；登录返回的提示优先展示。
  const shown = message ?? (state === "auth-required" ? status.reason : undefined);
  // 修复原因：Claude 登录在浏览器显示授权码时，CLI 输出 “Paste code here if prompted >” 并从 stdin
  // 读取；这里把该提示行替换为输入框，授权码经 Host 写入登录进程。
  const awaitingCode = state === "authenticating" && !!shown && PASTE_CODE_PROMPT.test(shown);
  const displayed = awaitingCode ? shown.replace(PASTE_CODE_LINE, "").trim() : shown;

  return (
    <div className="space-y-2" data-testid={testId(TID_ACP_BUILTIN_CONTROL, "account")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-ui-base text-foreground-subtle">{text("account")}</span>
          <span
            role="status"
            data-auth-state={state}
            data-testid={testId(TID_ACP_BUILTIN_CONTROL, "auth-state")}
            className="inline-flex min-w-0 items-start gap-1.5 text-ui-base text-foreground"
          >
            {/* 状态文字换行时图标对齐首行，而不是垂直居中在多行之间。 */}
            <span className="flex h-lh shrink-0 items-center">
              {state === "authenticating" ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CircleIcon className={`size-2 fill-current ${presentation.color}`} aria-hidden />
              )}
            </span>
            <span className="min-w-0 break-words">{text(presentation.id)}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {entry.signIn ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              disabled={busy}
              data-testid={testId(TID_ACP_BUILTIN_CONTROL, "sign-in")}
              onClick={() => signIn(false)}
            >
              {pending === "sign-in" ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : null}
              {pending === "sign-in" ? text("signInStarting") : text("signIn")}
            </Button>
          ) : null}
          {entry.deviceSignIn ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              disabled={busy}
              data-testid={testId(TID_ACP_BUILTIN_CONTROL, "sign-in-device")}
              onClick={() => signIn(true)}
            >
              {pending === "device" ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : null}
              {text("signInDevice")}
            </Button>
          ) : null}
          {auth === "subscription" ? (
            <Button
              type="button"
              variant="ghost"
              className="rounded-lg"
              disabled={busy}
              data-testid={testId(TID_ACP_BUILTIN_CONTROL, "sign-out")}
              onClick={signOut}
            >
              {text("signOut")}
            </Button>
          ) : null}
        </div>
      </div>
      {auth === "cli-login" ? (
        <p className="text-ui-sm text-foreground-subtle">
          {text("cliLoginSignOutHint", { runtime: entry.name })}
        </p>
      ) : null}
      {displayed ? (
        <div
          className="space-y-1 rounded-lg border border-input-border bg-input px-3 py-2 text-ui-sm text-foreground"
          data-testid={testId(TID_ACP_BUILTIN_CONTROL, "sign-in-message")}
        >
          {signInNeedsTerminal(displayed) ? (
            <>
              <p className="break-words">{displayed}</p>
              <p className="text-foreground-subtle">{text("terminalHint")}</p>
              <code className="block select-all break-all rounded-sm bg-surface px-2 py-1 font-mono">
                {signInScriptCommand(status.id)}
              </code>
            </>
          ) : (
            parseSignInMessage(displayed).map((segments, line) => (
              <p key={line} className="break-words">
                {segments.map((segment, index) =>
                  segment.kind === "text" ? (
                    <span key={index}>{segment.text}</span>
                  ) : segment.kind === "url" ? (
                    <Button
                      key={index}
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto max-w-full whitespace-normal break-all px-0 text-left text-ui-sm text-icon-blue"
                      aria-label={`${text("openSignInPage")}: ${segment.url}`}
                      disabled={!isOpenableSignInUrl(segment.url)}
                      onClick={() => platform.openExternal(segment.url)}
                    >
                      {segment.url}
                      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden="true" />
                    </Button>
                  ) : (
                    <span key={index} className="inline-flex items-center gap-1">
                      <code className="select-all rounded-sm bg-surface px-1.5 font-mono text-ui-base font-semibold">
                        {segment.code}
                      </code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={text("copyCode")}
                        title={copied === segment.code ? text("codeCopied") : text("copyCode")}
                        onClick={() => void copy(segment.code)}
                      >
                        <CopyIcon aria-hidden="true" />
                      </Button>
                    </span>
                  ),
                )}
              </p>
            ))
          )}
        </div>
      ) : null}
      {awaitingCode ? (
        <form
          className="flex flex-wrap items-center gap-2"
          data-testid={testId(TID_ACP_BUILTIN_CONTROL, "sign-in-code")}
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode();
          }}
        >
          <Input
            className="min-w-0 flex-1 font-mono"
            value={code}
            autoComplete="off"
            spellCheck={false}
            placeholder={text("signInCodePlaceholder")}
            aria-label={text("signInCodePlaceholder")}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            className="rounded-lg"
            disabled={submittingCode || !code.trim()}
          >
            {submittingCode ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            {text("signInCodeSubmit")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
