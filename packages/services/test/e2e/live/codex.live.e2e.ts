import { defineLiveCases } from "./liveHarness.js";

defineLiveCases("codex", [
  { task: "website", modeId: "agent-full-access", label: "full access", maxPermissions: 0 },
  // read-only = "Ask for approval"：工作区内写入由沙箱放行，只有越权才询问；随机裁决越权请求。
  { task: "website", modeId: "read-only", label: "ask + random judge", randomJudge: true },
  // 默认 "agent" 模式：Guardian 由同一模型代审，不向用户提问。
  { task: "website", modeId: "agent", label: "guardian auto-review", maxPermissions: 0 },
  { task: "harness", modeId: "agent-full-access", label: "full access", maxPermissions: 0 },
  // 只有 full-access 沙箱允许网络。
  { task: "internet", modeId: "agent-full-access", label: "full access", maxPermissions: 0 },
]);
