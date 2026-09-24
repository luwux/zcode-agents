import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACP_DEFAULT_MODEL_ID } from "@zcode/shared";
import { AcpRuntimeCoordinator } from "../src/agent-runtime/acpRuntimeCoordinator.js";
import { saveAgentServerConfig } from "../src/agent-runtime/agentServersRegistry.js";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/**
 * 假 ACP Agent，复刻 codex-acp 的模型目录：配置的自定义模型（BYOK，例如 OpenRouter 上的 MiMo）不在预设
 * 目录中，只在它是当前模型时被列出；切到预设后再选它会被拒绝（invalidParams）。
 */
const AGENT = `
import { createInterface } from 'node:readline';
const PRESETS = [{ value: 'gpt-preset', name: 'GPT preset' }, { value: 'gpt-mini', name: 'GPT mini' }];
let model = 'vendor/custom-model';
let effort = 'medium';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const configOptions = () => {
  const options = [...PRESETS];
  if (!PRESETS.some((preset) => preset.value === model)) options.unshift({ value: model, name: model });
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options },
    { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort,
      options: model === 'gpt-mini' ? [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }]
        : [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  ];
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const answer = (result) => out({ jsonrpc: '2.0', id: request.id, result });
  if (request.method === 'initialize')
    answer({ protocolVersion: request.params.protocolVersion, agentCapabilities: { loadSession: true } });
  else if (request.method === 'session/new') answer({ sessionId: 'native-' + process.pid, configOptions: configOptions() });
  else if (request.method === 'session/load') answer({ configOptions: configOptions() });
  else if (request.method === 'session/set_config_option') {
    const { configId, value } = request.params;
    if (configId === 'model') {
      if (!configOptions()[0].options.some((option) => option.value === value)) {
        out({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } });
        continue;
      }
      model = value;
      if (value === 'gpt-mini' && effort === 'high') effort = 'medium';
    } else effort = value;
    answer({ configOptions: configOptions() });
  } else if (request.method === 'session/prompt') {
    out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply[' + model + ']' } } } });
    answer({ stopReason: 'end_turn' });
  }
}
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-discovery-"));
  setDataBaseDir(dir);
  const agentFile = join(dir, "agent.mjs");
  await writeFile(agentFile, AGENT);
  await saveAgentServerConfig({
    id: "custom-model-agent",
    name: "Custom model agent",
    command: process.execPath,
    args: [agentFile],
  });
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const coordinator = new AcpRuntimeCoordinator(repo, {}, async () => ({
    executable: process.execPath,
    args: [agentFile],
    env: { ...process.env },
  }));
  const cleanup = async () => {
    await coordinator.closeAll();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { dir, coordinator, cleanup };
}

test("model sync keeps a custom model the agent only lists while it is current", async () => {
  const { dir, coordinator, cleanup } = await setup();
  try {
    const preview = await coordinator.discoverConfig({
      workspacePath: dir,
      runtimeId: "custom-model-agent",
      includeAllModelThoughtLevels: true,
    });
    const byName = new Map(preview.models.map((model) => [model.name, model]));
    assert.deepEqual([...byName.keys()], ["vendor/custom-model", "GPT preset", "GPT mini"]);
    assert.equal(preview.selectedModel, byName.get("vendor/custom-model")!.id);
    // 自定义模型的思考档位来自初始状态；预设模型逐个探测。
    assert.deepEqual(
      byName.get("vendor/custom-model")!.thoughtLevels.map((level) => level.value),
      ["medium", "high"],
    );
    assert.deepEqual(
      byName.get("GPT mini")!.thoughtLevels.map((level) => level.value),
      ["low", "medium"],
    );
  } finally {
    await cleanup();
  }
});

test("the agent-default placeholder keeps the agent's model instead of failing the send", async () => {
  const { dir, coordinator, cleanup } = await setup();
  try {
    const target = { workspacePath: dir };
    const meta = await coordinator.create({
      ...target,
      commandId: "default-model-task",
      runtimeId: "custom-model-agent",
      modelId: ACP_DEFAULT_MODEL_ID,
    });
    const task = { ...target, taskId: meta.taskId };
    const before = coordinator.snapshot(task)!.config.model;
    await coordinator.setModel({ ...task, value: ACP_DEFAULT_MODEL_ID });
    assert.equal(coordinator.snapshot(task)!.config.model, before);
    await coordinator.sendPrompt({ ...task, commandId: "p1", text: "hello" });
    const deadline = Date.now() + 5000;
    while (coordinator.snapshot(task)?.control.phase === "running" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const texts = coordinator
      .rowsRange({ ...task, limit: 100 })
      .rows.filter((row) => row.kind === "assistantText")
      .map((row) => (row.kind === "assistantText" ? row.text : ""));
    assert.deepEqual(texts, ["reply[vendor/custom-model]"]);
  } finally {
    await cleanup();
  }
});
