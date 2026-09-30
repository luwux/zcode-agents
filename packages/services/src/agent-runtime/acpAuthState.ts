import type { AuthMethod } from "@agentclientprotocol/sdk";

export type AcpAuthState = "unknown" | "auth-required" | "authenticating" | "authenticated";

export interface AcpAuthMethodSummary {
  id: string;
  name: string;
  description?: string;
  type: "terminal" | "agent";
}

export interface AcpAuthSnapshot {
  state: AcpAuthState;
  message?: string;
  methods: readonly AcpAuthMethodSummary[];
}

/** ACP 规范为 authRequired 分配的 JSON-RPC 错误码。 */
export const ACP_AUTH_REQUIRED_CODE = -32000;

export function isAcpAuthRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ACP_AUTH_REQUIRED_CODE
  );
}

export function summarizeAuthMethods(
  methods: readonly AuthMethod[] | undefined,
): AcpAuthMethodSummary[] {
  return (methods ?? []).map((method) => ({
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: "type" in method && method.type === "terminal" ? "terminal" : "agent",
  }));
}

/**
 * Host 内存中的认证状态唯一所有者，按 Runtime 配置 ID 记录。凭据由各 CLI 自己的存储持有，
 * 这里只保存状态与可用方法；重启后回到 unknown，由下一次握手/请求重新判定。
 */
export class AcpAuthStateStore {
  private readonly states = new Map<string, AcpAuthSnapshot>();
  private readonly listeners = new Set<(id: string, snapshot: AcpAuthSnapshot) => void>();

  get(id: string): AcpAuthSnapshot {
    return this.states.get(id) ?? { state: "unknown", methods: [] };
  }

  recordMethods(id: string, methods: readonly AcpAuthMethodSummary[]): void {
    this.set(id, { ...this.get(id), methods });
  }

  markAuthRequired(id: string, message: string): void {
    this.set(id, { ...this.get(id), state: "auth-required", message });
  }

  markAuthenticating(id: string): void {
    const { message: _message, ...current } = this.get(id);
    this.set(id, { ...current, state: "authenticating" });
  }

  markAuthenticated(id: string): void {
    const { message: _message, ...current } = this.get(id);
    this.set(id, { ...current, state: "authenticated" });
  }

  /** 配置或 Key 变更后回到 unknown，由下一次握手/请求重新判定。 */
  reset(id: string): void {
    this.set(id, { state: "unknown", methods: this.get(id).methods });
  }

  onDidChange(listener: (id: string, snapshot: AcpAuthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(id: string, snapshot: AcpAuthSnapshot): void {
    const previous = this.states.get(id);
    this.states.set(id, snapshot);
    if (previous?.state !== snapshot.state || previous?.message !== snapshot.message)
      for (const listener of this.listeners) listener(id, snapshot);
  }
}

export const acpAuthStateStore = new AcpAuthStateStore();
