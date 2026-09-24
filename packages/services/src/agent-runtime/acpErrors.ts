/**
 * ACP JSON-RPC 错误的可读描述。修复原因：Agent 常以通用 message（如 "Internal error"）加
 * `data.details` 返回真实原因（例如上游 401/400），只取 message 会让卡片与 turn 错误失去可诊断性。
 */
export function describeAcpError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  const data = (error as { data?: unknown } | null)?.data;
  const details =
    data && typeof data === "object" ? (data as { details?: unknown }).details : undefined;
  if (typeof details !== "string" || !details.trim() || message.includes(details)) return message;
  // 细节只截取前 500 字符，避免上游完整响应体进入投影。
  return `${message}: ${details.trim().slice(0, 500)}`;
}
