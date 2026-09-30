import { defineLiveCases, sandboxEnvForBypass } from "./liveHarness.js";

defineLiveCases("claude-code", [
  {
    task: "website",
    modeId: "bypassPermissions",
    label: "bypass",
    configEnv: sandboxEnvForBypass(),
    maxPermissions: 0,
    steer: true,
  },
  // 默认模式：写文件与命令需审批，随机裁决（约 1/5 拒绝）。
  {
    task: "website",
    modeId: "default",
    label: "ask + random judge",
    randomJudge: true,
    minPermissions: 1,
  },
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
  // 录制用：看图、子代理、后台命令与中途打断（视觉模型；仅在录制任务中运行）。
  ...(process.env.CODEZ_LIVE_FEATURES === "1"
    ? [
        {
          task: "features" as const,
          modeId: "bypassPermissions",
          label: "features",
          configEnv: sandboxEnvForBypass(),
          maxPermissions: 0,
          model: process.env.CODEZ_LIVE_VISION_MODEL ?? "qwen/qwen3.7-flash",
        },
      ]
    : []),
]);
