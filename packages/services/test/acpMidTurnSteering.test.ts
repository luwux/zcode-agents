import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpRuntimeCoordinator } from "../src/agent-runtime/acpRuntimeCoordinator.js";
import { AcpV4Bridge } from "../src/agent-runtime/acpV4Bridge.js";
import { saveAgentServerConfig } from "../src/agent-runtime/agentServersRegistry.js";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/**
 * 假 ACP Agent：
 * - STEERING=1 时在 initialize 顶层 `_meta.steering.supported` 声明 `_session/steering`；
 * - "long" prompt 运行到收到 steer 或 "release" 为止；steer 在运行中返回 injected，空闲时 promptRequired；
 * - reasoning_effort 可运行中切换；model 运行中拒绝（验证延后应用）。
 */
const AGENT = `
import { createInterface } from 'node:readline';
const steering = process.env.STEERING === '1';
let model = 'auto';
let thought = 'low';
let active = null;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'auto', name: 'Auto' }, { value: 'ultimate', name: 'Ultimate' }] },
  { id: 'reasoning_effort', name: 'Effort', category: 'model', type: 'select', currentValue: thought,
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
const chunk = (sessionId, text) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const answer = (result) => out({ jsonrpc: '2.0', id: request.id, result });
  const fail = (message) => out({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message } });
  if (request.method === 'initialize')
    answer({ protocolVersion: request.params.protocolVersion, agentCapabilities: { loadSession: true },
      ...(steering ? { _meta: { steering: { supported: true } } } : {}) });
  else if (request.method === 'session/new') answer({ sessionId: 'native-' + process.pid, configOptions: configOptions() });
  else if (request.method === 'session/load') answer({ configOptions: configOptions() });
  else if (request.method === 'session/set_config_option') {
    if (request.params.configId === 'model' && active) { fail('model cannot change during a turn'); continue; }
    if (request.params.configId === 'model') model = request.params.value;
    else thought = request.params.value;
    answer({ configOptions: configOptions() });
  } else if (request.method === '_session/steering') {
    const text = request.params.prompt.map((block) => block.text).join('');
    if (!active) { answer({ outcome: 'promptRequired', reason: 'noRunningTurn' }); continue; }
    chunk(active.sessionId, 'steered[' + thought + ']: ' + text);
    answer({ outcome: 'injected' });
    if (text === 'release') { const done = active; active = null; out({ jsonrpc: '2.0', id: done.id, result: { stopReason: 'end_turn' } }); }
  } else if (request.method === 'session/prompt') {
    const text = request.params.prompt.map((block) => block.text ?? '').join('');
    chunk(request.params.sessionId, 'reply[' + model + '/' + thought + ']: ' + text);
    if (text.includes('long')) active = { id: request.id, sessionId: request.params.sessionId };
    else answer({ stopReason: 'end_turn' });
  } else if (request.method === 'session/cancel') {
    if (active) { out({ jsonrpc: '2.0', id: active.id, result: { stopReason: 'cancelled' } }); active = null; }
  }
}
`;

async function waitFor(predicate: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(steering: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-steer-"));
  setDataBaseDir(dir);
  const agentFile = join(dir, "agent.mjs");
  await writeFile(agentFile, AGENT);
  await saveAgentServerConfig({
    id: "steer-agent",
    name: "Steer Agent",
    command: process.execPath,
    args: [agentFile],
  });
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const env = { ...process.env, STEERING: steering ? "1" : "0" };
  const coordinator = new AcpRuntimeCoordinator(repo, {}, async () => ({
    executable: process.execPath,
    args: [agentFile],
    env,
  }));
  const target = { workspacePath: dir };
  const meta = await coordinator.create({
    ...target,
    commandId: "steer-task",
    runtimeId: "steer-agent",
  });
  const task = { ...target, taskId: meta.taskId };
  const cleanup = async () => {
    await coordinator.closeAll();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { dir, repo, coordinator, task, cleanup };
}

const rowsOf = (
  coordinator: AcpRuntimeCoordinator,
  task: { workspacePath: string; taskId: string },
) =>
  coordinator.rowsRange({ ...task, limit: 1000 }).rows as Array<{
    kind: string;
    turnId?: string;
    text?: string;
    sourceCommandId?: string;
  }>;

test("a running ACP turn accepts steering and mid-turn effort changes like ZCode guide", async () => {
  const { coordinator, task, cleanup } = await setup(true);
  try {
    await coordinator.sendPrompt({ ...task, commandId: "p1", text: "long task" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase === "running", "running");
    const running = coordinator.snapshot(task)!;
    assert.equal(running.inputRouting.mode, "guide");
    assert.equal(running.availability.switchModelConfig.allowed, true);

    // 思考等级运行中立即生效；随后的 steer 在新等级下被处理。
    await coordinator.setThinkingLevel({ ...task, value: "high" });
    assert.equal(coordinator.snapshot(task)?.config.thought, "high");
    assert.equal(
      await coordinator.sendPrompt({ ...task, commandId: "p2", text: "use the other file" }),
      "accepted",
    );
    await waitFor(
      () =>
        rowsOf(coordinator, task).some((row) =>
          row.text?.includes("steered[high]: use the other file"),
        ),
      "steered reply",
    );
    // 重复命令幂等。
    assert.equal(
      await coordinator.sendPrompt({ ...task, commandId: "p2", text: "use the other file" }),
      "duplicate",
    );
    await coordinator.sendPrompt({ ...task, commandId: "p3", text: "release" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase !== "running", "turn end");

    const rows = rowsOf(coordinator, task);
    const turns = new Set(rows.filter((row) => row.kind === "turnHeader").map((row) => row.turnId));
    assert.equal(turns.size, 1, "steered inputs stay in the running turn");
    assert.deepEqual(
      rows.filter((row) => row.kind === "userInput").map((row) => row.sourceCommandId),
      ["p1", "p2", "p3"],
    );
    assert.equal(coordinator.snapshot(task)?.inputRouting.mode, "startNow");
  } finally {
    await cleanup();
  }
});

test("a model change the agent refuses mid-turn is applied when the turn settles", async () => {
  const { coordinator, task, cleanup } = await setup(true);
  try {
    await coordinator.sendPrompt({ ...task, commandId: "m1", text: "long task" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase === "running", "running");
    // AcpConnection 的模型 ID 编码：acp:model:<configId>:<value>。
    const ultimate = { id: "acp:model:model:ultimate" };
    await coordinator.setModel({ ...task, value: ultimate!.id });
    assert.notEqual(coordinator.snapshot(task)?.config.model, ultimate!.id, "not applied mid-turn");
    await coordinator.sendPrompt({ ...task, commandId: "m2", text: "release" });
    await waitFor(
      () => coordinator.snapshot(task)?.config.model === ultimate!.id,
      "deferred model",
    );
    await coordinator.sendPrompt({ ...task, commandId: "m3", text: "next" });
    await waitFor(
      () => rowsOf(coordinator, task).some((row) => row.text?.includes("reply[ultimate/")),
      "next turn uses the deferred model",
    );
  } finally {
    await cleanup();
  }
});

test("steering that races with turn end starts the input as the next turn exactly once", async () => {
  const { coordinator, task, cleanup } = await setup(true);
  try {
    await coordinator.sendPrompt({ ...task, commandId: "r1", text: "long task" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase === "running", "running");
    // 结束当前 turn 与下一条输入几乎同时到达：Agent 可能回 promptRequired。
    await coordinator.sendPrompt({ ...task, commandId: "r2", text: "release" });
    await coordinator.sendPrompt({ ...task, commandId: "r3", text: "after the race" });
    await waitFor(
      () =>
        rowsOf(coordinator, task).some((row) => row.text?.includes("after the race")) &&
        coordinator.snapshot(task)?.control.phase !== "running",
      "late input delivered",
    );
    const inputs = rowsOf(coordinator, task).filter((row) => row.kind === "userInput");
    assert.equal(inputs.filter((row) => row.sourceCommandId === "r3").length, 1);
  } finally {
    await cleanup();
  }
});

test("agents without steering keep rejecting input while running", async () => {
  const { coordinator, task, cleanup } = await setup(false);
  try {
    await coordinator.sendPrompt({ ...task, commandId: "n1", text: "long task" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase === "running", "running");
    assert.equal(coordinator.snapshot(task)?.inputRouting.mode, "reject");
    await assert.rejects(
      coordinator.sendPrompt({ ...task, commandId: "n2", text: "more" }),
      /busy/,
    );
    await coordinator.cancel(task);
  } finally {
    await cleanup();
  }
});

test("steered prompts are restored inside their turn", async () => {
  const { dir, repo, coordinator, task, cleanup } = await setup(true);
  try {
    await coordinator.sendPrompt({ ...task, commandId: "t1", text: "long task" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase === "running", "running");
    await coordinator.sendPrompt({ ...task, commandId: "t2", text: "steer me" });
    await waitFor(
      () => rowsOf(coordinator, task).some((row) => row.text?.includes("steered[low]: steer me")),
      "steer",
    );
    await coordinator.sendPrompt({ ...task, commandId: "t3", text: "release" });
    await waitFor(() => coordinator.snapshot(task)?.control.phase !== "running", "turn end");
    await coordinator.closeAll();

    const restored = new AcpRuntimeCoordinator(repo, {}, async () => ({
      executable: process.execPath,
      args: [join(dir, "agent.mjs")],
      env: { ...process.env, STEERING: "1" },
    }));
    try {
      await restored.load(task);
      const rows = rowsOf(restored, task);
      const turns = new Set(
        rows.filter((row) => row.kind === "turnHeader").map((row) => row.turnId),
      );
      assert.equal(turns.size, 1);
      assert.deepEqual(
        rows.filter((row) => row.kind === "userInput").map((row) => row.sourceCommandId),
        ["t1", "t2", "t3"],
      );
    } finally {
      await restored.closeAll();
    }
  } finally {
    await cleanup();
  }
});

test("the V4 bridge accepts mid-turn config changes and reports guide delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-steer-bridge-"));
  setDataBaseDir(dir);
  const agentFile = join(dir, "agent.mjs");
  await writeFile(agentFile, AGENT);
  await saveAgentServerConfig({
    id: "steer-agent",
    name: "Steer",
    command: process.execPath,
    args: [agentFile],
  });
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const previous = process.env.STEERING;
  // 桥使用默认启动解析（Host 进程 env）；假 Agent 通过该变量声明 steering。
  process.env.STEERING = "1";
  const bridge = new AcpV4Bridge(
    repo,
    () => {},
    () => false,
  );
  const target = { workspacePath: dir };
  try {
    const meta = await bridge.coordinator.create({
      ...target,
      commandId: "b-task",
      runtimeId: "steer-agent",
    });
    const task = { ...target, taskId: meta.taskId };
    await bridge.coordinator.sendPrompt({ ...task, commandId: "b1", text: "long task" });
    await waitFor(() => bridge.coordinator.snapshot(task)?.control.phase === "running", "running");
    const envelope = (commandId: string, type: string, payload: unknown) =>
      ({
        commandId,
        clientId: "test-client",
        sessionId: meta.taskId,
        type,
        payload,
        issuedAt: Date.now(),
      }) as never;
    const config = await bridge.command(
      target,
      envelope("b-cfg", "switchModelConfig", { provider: "acp", model: "", thought: "high" }),
    );
    assert.equal(config.status, "accepted");
    assert.equal(bridge.coordinator.snapshot(task)?.config.thought, "high");
    const steer = await bridge.command(
      target,
      envelope("b2", "sendText", { text: "steer via bridge" }),
    );
    assert.equal(steer.status, "accepted");
    assert.equal((steer.result as { delivery?: string } | undefined)?.delivery, "guide");
    await waitFor(
      () =>
        (
          bridge.coordinator.rowsRange({ ...task, limit: 100 }).rows as Array<{ text?: string }>
        ).some((row) => row.text?.includes("steered[high]: steer via bridge")),
      "bridge steer",
    );
    await bridge.coordinator.sendPrompt({ ...task, commandId: "b3", text: "release" });
    await waitFor(() => bridge.coordinator.snapshot(task)?.control.phase !== "running", "turn end");
  } finally {
    if (previous === undefined) delete process.env.STEERING;
    else process.env.STEERING = previous;
    await bridge.dispose();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
