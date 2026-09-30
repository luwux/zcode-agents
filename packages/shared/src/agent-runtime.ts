import { z } from "zod";

/** 工作台层稳定身份。格式校验不授予执行权；Host 还必须查已校验注册表。 */
export const agentRuntimeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "Agent ID must use lowercase letters, digits and hyphens");

export type AgentRuntimeId = z.infer<typeof agentRuntimeIdSchema>;

export const ZCODE_CLI_RUNTIME_ID = "zcode-cli" satisfies AgentRuntimeId;
export const ACP_DEFAULT_MODEL_ID = "__agent_default__";
/**
 * ACP 新会话（尚未创建）粘贴附件时使用的上传会话 ID 前缀：Host 收下分片并写成本地文件，
 * 发送时以绝对路径交给新建的 ACP 会话。
 */
export const ACP_DRAFT_ATTACHMENT_SESSION_PREFIX = "acp-draft-";
