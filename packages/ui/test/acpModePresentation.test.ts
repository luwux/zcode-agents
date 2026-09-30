import assert from "node:assert/strict";
import test from "node:test";
import { classifyAcpMode, presentAcpModes } from "../src/lib/acpModePresentation.js";

test("Claude Code and Codex modes map onto the same CodeZ mode categories", () => {
  // claude-agent-acp buildAvailableModes()
  const claude = presentAcpModes([
    { id: "default", name: "Manual", kind: "standard" },
    { id: "acceptEdits", name: "Accept edits", kind: "standard" },
    { id: "plan", name: "Plan", kind: "plan" },
    { id: "auto", name: "Auto", kind: "auto_review" },
    { id: "bypassPermissions", name: "Bypass permissions", kind: "full_access" },
  ]);
  assert.deepEqual(
    claude.map((entry) => [entry.mode.id, entry.category, entry.useAgentText]),
    [
      ["plan", "plan", false],
      ["default", "build", false],
      ["acceptEdits", "edit", false],
      ["auto", "autoReview", false],
      ["bypassPermissions", "yolo", false],
    ],
  );
  // codex-acp AgentMode
  const codex = presentAcpModes([
    { id: "read-only", name: "Ask for approval", kind: "standard" },
    { id: "agent", name: "Approve for me", kind: "auto_review" },
    { id: "agent-full-access", name: "Full access", kind: "full_access" },
  ]);
  assert.deepEqual(
    codex.map((entry) => [entry.mode.id, entry.category]),
    [
      ["read-only", "edit"],
      ["agent", "autoReview"],
      ["agent-full-access", "yolo"],
    ],
  );
});

test("unknown and duplicate modes keep the Agent's own text", () => {
  assert.equal(classifyAcpMode({ id: "architect" }), "custom");
  const modes = presentAcpModes([
    { id: "default", name: "Manual" },
    { id: "ask", name: "Ask twice" },
    { id: "architect", name: "Architect" },
  ]);
  assert.deepEqual(
    modes.map((entry) => [entry.mode.id, entry.useAgentText]),
    [
      ["default", false],
      ["ask", true],
      ["architect", true],
    ],
  );
});
