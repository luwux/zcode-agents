import assert from "node:assert/strict";
import test from "node:test";
import { classifyAcpMode } from "../src/lib/acpModePresentation.js";

test("Claude Code and Codex modes get CodeZ's icon categories while keeping their own names", () => {
  // claude-agent-acp buildAvailableModes()
  assert.deepEqual(
    [
      { id: "default", kind: "standard" },
      { id: "acceptEdits", kind: "standard" },
      { id: "plan", kind: "plan" },
      { id: "auto", kind: "auto_review" },
      { id: "bypassPermissions", kind: "full_access" },
    ].map(classifyAcpMode),
    ["build", "edit", "plan", "autoReview", "yolo"],
  );
  // codex-acp AgentMode
  assert.deepEqual(
    [
      { id: "read-only", kind: "standard" },
      { id: "agent", kind: "auto_review" },
      { id: "agent-full-access", kind: "full_access" },
    ].map(classifyAcpMode),
    ["edit", "autoReview", "yolo"],
  );
  assert.equal(classifyAcpMode({ id: "architect" }), "custom");
});
