import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type {
  UserInputOptionPayload,
  UserInputQuestionPayload,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import { record } from "#src/agent-runtime/acpExtensionSchemas.js";

type FieldMode = "single" | "multi" | "text" | "boolean" | "number" | "integer";

interface ElicitationField {
  key: string;
  question: string;
  mode: FieldMode;
  optionValues: ReadonlySet<string>;
  companionKey?: string;
}

/** 一次 form elicitation 的呈现与回写计划；属性键顺序即问题顺序。 */
export interface AcpElicitationPlan {
  payload: UserInputRequestPayload;
  fields: ElicitationField[];
}

export interface AcpInteractionAnswer {
  optionId?: string;
  freeText?: string;
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

type ElicitationContent = Record<string, string | number | boolean | string[]>;

export type AcpFormElicitationRequest = Extract<CreateElicitationRequest, { mode: "form" }> & {
  requestedSchema: { properties?: Record<string, unknown> };
};

/** SDK 1.4 的自定义模式分支 `mode: string` 使 `mode === "form"` 无法收窄，这里同时校验 schema 在场。 */
export function isFormElicitation(
  request: CreateElicitationRequest,
): request is AcpFormElicitationRequest {
  return (
    request.mode === "form" &&
    record((request as { requestedSchema?: unknown }).requestedSchema) !== undefined
  );
}

export function planAcpElicitation(request: AcpFormElicitationRequest): AcpElicitationPlan {
  const properties = Object.entries(record(request.requestedSchema.properties) ?? {});
  const companionOf = new Map<string, string>();
  for (const [key, value] of properties) {
    const target = companionTarget(record(value));
    if (target) companionOf.set(target, key);
  }
  const companions = new Set(companionOf.values());
  const questionProps = properties.filter(([key]) => !companions.has(key));
  const single = questionProps.length === 1;
  const fields: ElicitationField[] = [];
  const questions: UserInputQuestionPayload[] = [];
  questionProps.forEach(([key, value], index) => {
    const prop = record(value) ?? {};
    const title = text(prop.title);
    const description = text(prop.description);
    // Codex 把问题放在 title、标题放在 description；Claude/Pi 反之（见 design D7）。
    const codexLayout = record(prop._meta)?.codex !== undefined;
    const question =
      (codexLayout ? (title ?? description) : (description ?? (single ? undefined : title))) ??
      text(request.message) ??
      key;
    const header = (codexLayout ? description : title) ?? `Question ${index + 1}`;
    const { mode, options } = readOptions(prop);
    fields.push({
      key,
      question,
      mode,
      optionValues: new Set(options.map((option) => option.value)),
      ...(companionOf.has(key) ? { companionKey: companionOf.get(key) } : {}),
    });
    questions.push({
      question,
      header,
      options,
      ...(mode === "multi" ? { multiSelect: true } : {}),
    });
  });
  const toolCallId = "toolCallId" in request ? request.toolCallId : undefined;
  return {
    fields,
    payload: {
      kind: "userInput",
      prompt: request.message,
      freeText: questions.length > 0,
      ...(toolCallId ? { toolCallId } : {}),
      ...(questions.length > 0
        ? { questions }
        : {
            // 无属性的表单（如 MCP 消息型确认）只能接受或拒绝。
            options: [
              { optionId: "accept", label: "Accept" },
              { optionId: "decline", label: "Decline" },
            ],
          }),
    },
  };
}

function companionTarget(prop: Record<string, unknown> | undefined): string | undefined {
  const meta = record(prop?._meta);
  const claude = record(meta?._askUserQuestionCustomAnswer);
  if (claude?.isCustomAnswer === true && typeof claude.questionId === "string")
    return claude.questionId;
  const codex = record(meta?.codex);
  if (codex?.role === "user_note" && typeof codex.questionId === "string") return codex.questionId;
  const lody = record(record(meta?.lody)?.elicitation);
  return typeof lody?.customAnswerFor === "string" ? lody.customAnswerFor : undefined;
}

function readOptions(prop: Record<string, unknown>): {
  mode: FieldMode;
  options: UserInputOptionPayload[];
} {
  if (prop.type === "boolean")
    return {
      mode: "boolean",
      options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
    };
  if (prop.type === "number" || prop.type === "integer") return { mode: prop.type, options: [] };
  const items = record(prop.items);
  const source = prop.type === "array" ? items : prop;
  const options = enumOptions(source);
  if (prop.type === "array") return { mode: "multi", options };
  return { mode: options.length > 0 ? "single" : "text", options };
}

function enumOptions(source: Record<string, unknown> | undefined): UserInputOptionPayload[] {
  const titled = source?.oneOf ?? source?.anyOf;
  if (Array.isArray(titled)) {
    return titled.flatMap((entry) => {
      const option = record(entry);
      const value = option?.const;
      if (typeof value !== "string") return [];
      const preview = record(record(option?._meta)?.["_claude/askUserQuestionOption"])?.preview;
      return [
        {
          value,
          label: text(option?.title) ?? value,
          ...(text(option?.description) ? { description: text(option?.description) } : {}),
          ...(typeof preview === "string" ? { preview } : {}),
        },
      ];
    });
  }
  const values = source?.enum;
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string")
        .map((value) => ({
          value,
          label: value,
        }))
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 把对话框答案（`answer_<i>` / `answers[question]`）写回原 schema 属性键。 */
export function answerAcpElicitation(
  plan: AcpElicitationPlan,
  answer: AcpInteractionAnswer,
): CreateElicitationResponse {
  if (answer.action === "decline") return { action: "decline" };
  if (answer.action === "cancel") return { action: "cancel" };
  if (plan.fields.length === 0)
    return answer.optionId === "accept" || answer.action === "accept"
      ? { action: "accept", content: {} }
      : { action: "decline" };
  const content: ElicitationContent = {};
  const answers = record(answer.content?.answers);
  plan.fields.forEach((field, index) => {
    let raw: unknown = answer.content?.[`answer_${index}`] ?? answers?.[field.question];
    if (raw === undefined && plan.fields.length === 1)
      raw = answer.content?.answer ?? answer.freeText;
    const values = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
      .map((value) => String(value).trim())
      .filter(Boolean);
    if (values.length > 0) writeField(content, field, values);
  });
  return { action: "accept", content };
}

function writeField(content: ElicitationContent, field: ElicitationField, values: string[]) {
  const picks = values.filter((value) => field.optionValues.has(value));
  const other = values.filter((value) => !field.optionValues.has(value));
  switch (field.mode) {
    case "multi":
      if (field.companionKey) {
        if (picks.length) content[field.key] = picks;
        if (other.length) content[field.companionKey] = other.join(", ");
      } else content[field.key] = values;
      return;
    case "single":
      if (picks[0]) content[field.key] = picks[0];
      if (other.length) {
        if (field.companionKey) content[field.companionKey] = other.join(", ");
        else if (!picks[0]) content[field.key] = other.join(", ");
      }
      return;
    case "boolean":
      content[field.key] = /^(true|yes)$/iu.test(values[0]!);
      return;
    case "number":
    case "integer": {
      const parsed = Number(values[0]);
      if (Number.isFinite(parsed))
        content[field.key] = field.mode === "integer" ? Math.trunc(parsed) : parsed;
      return;
    }
    default:
      content[field.key] = values.join(", ");
  }
}
