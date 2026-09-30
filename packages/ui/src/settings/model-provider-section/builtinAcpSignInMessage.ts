// 登录提示来自 Host 捕获的 CLI 输出（登录 URL、设备码）或失败原因；这里只做展示用的切分。
export type SignInSegment =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
  | { kind: "code"; code: string };

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CLI 在管道中通常不上色，但仍可能输出 ANSI 控制序列（颜色、光标、OSC 超链接）。
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
// 设备码形如 ABCD-1234 / ABCD-EFGH：至少两组、每组 4 位以上的大写字母或数字。
const CODE_PATTERN = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function splitCodes(text: string): SignInSegment[] {
  const segments: SignInSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CODE_PATTERN)) {
    if (match.index > last) segments.push({ kind: "text", text: text.slice(last, match.index) });
    segments.push({ kind: "code", code: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** 按行切分；每行内识别 http(s) 链接与设备码，其余保持原文。 */
export function parseSignInMessage(message: string): SignInSegment[][] {
  return message
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const segments: SignInSegment[] = [];
      let last = 0;
      for (const match of line.matchAll(URL_PATTERN)) {
        const url = match[0].replace(TRAILING_PUNCTUATION, "");
        if (match.index > last) segments.push(...splitCodes(line.slice(last, match.index)));
        segments.push({ kind: "url", url });
        last = match.index + url.length;
      }
      if (last < line.length) segments.push(...splitCodes(line.slice(last)));
      return segments;
    });
}

/** Host 在方法只能交互式运行时返回的原因（见 builtinRuntimeAuth 的 needs an interactive terminal）。 */
export function signInNeedsTerminal(message: string | undefined): boolean {
  return Boolean(message && /needs an interactive terminal/i.test(message));
}

export function signInScriptCommand(configId: string): string {
  return `node --import tsx scripts/acp-runtimes/login.ts ${configId}`;
}

/** 只允许打开 http(s) 链接；其他协议（file:、javascript: 等）不交给平台服务。 */
export function isOpenableSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
