import { defineLiveCases } from "./liveHarness.js";

// Pi 没有权限系统：所有任务都不会提问。
defineLiveCases("pi", [
  { task: "website", label: "no permission system", maxPermissions: 0, steer: true },
  { task: "harness", label: "no permission system", maxPermissions: 0 },
  { task: "internet", label: "no permission system", maxPermissions: 0 },
  { task: "website", label: "openrouter preset, unrecorded", maxPermissions: 0, unrecorded: true },
]);
