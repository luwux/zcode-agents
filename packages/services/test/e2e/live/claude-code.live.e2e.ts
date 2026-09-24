import { defineLiveCases, sandboxEnvForBypass } from "./liveHarness.js";

defineLiveCases("claude-code", [
  {
    task: "website",
    modeId: "bypassPermissions",
    label: "bypass",
    configEnv: sandboxEnvForBypass(),
    maxPermissions: 0,
  },
  // 默认模式：写文件与命令需审批，随机裁决（约 1/5 拒绝）。
  { task: "website", modeId: "default", label: "ask + random judge", randomJudge: true },
  {
    task: "harness",
    modeId: "bypassPermissions",
    label: "bypass",
    configEnv: sandboxEnvForBypass(),
    maxPermissions: 0,
  },
  {
    task: "internet",
    modeId: "bypassPermissions",
    label: "bypass",
    configEnv: sandboxEnvForBypass(),
    maxPermissions: 0,
  },
]);
