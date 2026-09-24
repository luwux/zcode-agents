import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpRuntimeCoordinator } from "../src/agent-runtime/acpRuntimeCoordinator.js";
import { AcpAuthStateStore } from "../src/agent-runtime/acpAuthState.js";
import { AcpStartupGate } from "../src/agent-runtime/acpStartupGate.js";
import { saveAgentServerConfig } from "../src/agent-runtime/agentServersRegistry.js";
import {
  isInteractiveOnlyMethod,
  logoutBuiltinRuntime,
  selectAuthMethod,
  startBuiltinLogin,
} from "../src/agent-runtime/builtin/builtinRuntimeAuth.js";
import type { AgentConfig } from "../src/agent-runtime/builtin/agentConfigRegistry.js";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/**
 * 假 ACP Agent：仅当 Client 声明 auth.terminal 时公布终端登录；登录进程（--login）写标记文件；
 * 标记缺失时 session/new 返回 authRequired，标记为 expired 时 prompt 返回 authRequired。
 */
const AGENT = `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const marker = process.argv[2];
if (process.argv.includes('--login')) { writeFileSync(marker, 'ok'); console.log('Open https://login.example/device to continue'); process.exit(0); }
if (process.argv.includes('--logout')) { writeFileSync(marker, 'expired'); process.exit(0); }
const state = () => { try { return readFileSync(marker, 'utf8'); } catch { return ''; } };
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  const answer = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\\n');
  const authRequired = () => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32000,message:'Authentication required'}})+'\\n');
  if (request.method === 'initialize') {
    const terminal = request.params.clientCapabilities?.auth?.terminal === true;
    answer({protocolVersion:request.params.protocolVersion, agentCapabilities:{loadSession:true},
      authMethods: terminal ? [
        {id:'console-login',name:'Console',type:'terminal',args:['--login']},
        {id:'claude-ai-login',name:'Subscription',type:'terminal',args:['--login']},
      ] : []});
  }
  if (request.method === 'session/new') state() ? answer({sessionId:'native-'+process.pid}) : authRequired();
  if (request.method === 'session/load') state() ? answer({}) : authRequired();
  if (request.method === 'session/prompt') {
    if (state() !== 'ok') { authRequired(); continue; }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello'}}}})+'\\n');
    answer({stopReason:'end_turn'});
  }
}
`;

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("subscription method selection prefers the subscription login and honours explicit choices", () => {
  const claude: AgentConfig = { id: "c", name: "C", runtime: "claude-code", auth: "subscription" };
  const methods = [
    { id: "console-login", name: "Console", type: "terminal" as const },
    { id: "claude-ai-login", name: "Subscription", type: "terminal" as const },
  ];
  assert.equal(selectAuthMethod(claude, methods).id, "claude-ai-login");
  assert.equal(selectAuthMethod(claude, methods, "console-login").id, "console-login");
  assert.throws(() => selectAuthMethod(claude, methods, "gateway"), /not offered/);
  const codex: AgentConfig = { id: "x", name: "X", runtime: "codex", auth: "subscription" };
  assert.equal(
    selectAuthMethod(codex, [
      { id: "api-key", name: "Key" },
      { id: "chat-gpt", name: "ChatGPT" },
    ]).id,
    "chat-gpt",
  );
  assert.throws(
    () => selectAuthMethod(codex, [{ id: "api-key", name: "Key" }]),
    /subscription sign-in/,
  );
});

test("startup gate admits two handshakes at a time in FIFO order", async () => {
  const gate = new AcpStartupGate(2);
  const order: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const releases: Array<() => void> = [];
  const job = (name: string) =>
    gate.run(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(name);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
    });
  const jobs = ["a", "b", "c", "d"].map(job);
  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(gate.pending, 2);
  releases.shift()!();
  await waitFor(() => order.length === 3);
  assert.deepEqual(order, ["a", "b", "c"]);
  while (releases.length || order.length < 4) {
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.all(jobs);
  assert.equal(maxRunning, 2);
  assert.equal(gate.running, 0);
});

test("authRequired flips the config to auth-required, login recovers it, expiry never falls back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-auth-"));
  setDataBaseDir(dir);
  const agentFile = join(dir, "agent.mjs");
  const marker = join(dir, "login-state");
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const states = new AcpAuthStateStore();
  const launch = async () => ({
    executable: process.execPath,
    args: [agentFile, marker],
    env: process.env,
  });
  const coordinator = new AcpRuntimeCoordinator(repo, {}, launch, () => false, states);
  const target = { workspacePath: dir };
  try {
    await writeFile(agentFile, AGENT);
    await saveAgentServerConfig({
      id: "auth-agent",
      name: "Auth Agent",
      command: process.execPath,
      args: [agentFile, marker],
    });

    await assert.rejects(
      coordinator.create({ ...target, commandId: "t1", runtimeId: "auth-agent" }),
      /Sign-in required/,
    );
    assert.equal(states.get("auth-agent").state, "auth-required");
    // 仅在声明 auth.terminal 时才会公布终端方法；记录到的方法证明握手带上了该能力。
    assert.deepEqual(
      states.get("auth-agent").methods.map((method) => [method.id, method.type]),
      [
        ["console-login", "terminal"],
        ["claude-ai-login", "terminal"],
      ],
    );

    const config: AgentConfig = {
      id: "auth-agent",
      name: "Auth Agent",
      runtime: "claude-code",
      auth: "subscription",
    };
    const output: string[] = [];
    const login = startBuiltinLogin(
      config,
      {},
      {
        resolveLaunch: launch,
        cwd: dir,
        authStates: states,
        onOutput: (chunk) => output.push(chunk),
      },
    );
    assert.match((await login.started).message ?? "", /https:\/\/login\.example\/device/);
    assert.equal((await login.completion).state, "authenticated");
    assert.equal(await readFile(marker, "utf8"), "ok");

    const meta = await coordinator.create({ ...target, commandId: "t2", runtimeId: "auth-agent" });
    assert.equal(
      await coordinator.sendPrompt({ ...target, taskId: meta.taskId, commandId: "p1", text: "hi" }),
      "accepted",
    );
    await waitFor(
      () => coordinator.snapshot({ ...target, taskId: meta.taskId })?.control.phase !== "running",
    );
    assert.equal(states.get("auth-agent").state, "authenticated");

    // 登录过期：turn 以明确错误结束，状态翻回 auth-required，不重试也不切换执行者。
    await writeFile(marker, "expired");
    await coordinator.sendPrompt({
      ...target,
      taskId: meta.taskId,
      commandId: "p2",
      text: "again",
    });
    await waitFor(
      () => coordinator.snapshot({ ...target, taskId: meta.taskId })?.control.phase !== "running",
    );
    const snapshot = coordinator.snapshot({ ...target, taskId: meta.taskId });
    assert.equal(snapshot?.control.phase, "error");
    assert.match(JSON.stringify(snapshot), /Sign-in required/);
    assert.equal(states.get("auth-agent").state, "auth-required");
    assert.equal(meta.runtimeId, "auth-agent");
  } finally {
    await coordinator.closeAll();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("login and logout are refused where they would touch the wrong credentials", async () => {
  const byok: AgentConfig = { id: "b", name: "B", runtime: "claude-code", auth: "byok" };
  assert.throws(
    () =>
      startBuiltinLogin(
        byok,
        {},
        { resolveLaunch: async () => ({ executable: "x", args: [] }), cwd: "/" },
      ),
    /API key/,
  );
  const global: AgentConfig = { id: "g", name: "G", runtime: "claude-code", auth: "cli-login" };
  await assert.rejects(
    logoutBuiltinRuntime(global, {
      resolveLaunch: async () => ({ executable: "x", args: [] }),
      cwd: "/",
    }),
    /global CLI login/,
  );
  const failed = new AcpAuthStateStore();
  const handle = startBuiltinLogin(
    { id: "f", name: "F", runtime: "codex", auth: "subscription" },
    { deviceAuth: true },
    {
      resolveLaunch: async () => ({ executable: "x", args: [], env: {} }),
      cwd: "/",
      authStates: failed,
    },
  );
  assert.equal((await handle.completion).state, "auth-required");
  assert.match(failed.get("f").message ?? "", /Managed Codex binary is unavailable/);
});

test("the TUI-only Claude login is detected and refused without a terminal", () => {
  assert.equal(
    isInteractiveOnlyMethod({
      id: "claude-login",
      name: "Log in",
      type: "terminal",
      args: ["--cli"],
    }),
    true,
  );
  assert.equal(
    isInteractiveOnlyMethod({
      id: "claude-ai-login",
      name: "Subscription",
      type: "terminal",
      args: ["--cli", "auth", "login", "--claudeai"],
    }),
    false,
  );
  assert.equal(isInteractiveOnlyMethod({ id: "chat-gpt", name: "ChatGPT" }), false);
});

test("concurrent logins for one config share a single flow", () => {
  const states = new AcpAuthStateStore();
  let launches = 0;
  const deps = {
    resolveLaunch: async () => {
      launches += 1;
      throw new Error("stop here");
    },
    cwd: "/",
    authStates: states,
  };
  const config: AgentConfig = { id: "dup", name: "Dup", runtime: "codex", auth: "subscription" };
  const first = startBuiltinLogin(config, {}, deps);
  const second = startBuiltinLogin(config, {}, deps);
  assert.equal(first, second);
  return first.completion.then(() => assert.equal(launches, 1));
});

test("a rejected BYOK key is reported as a key problem, not a sign-in prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-byok-auth-"));
  setDataBaseDir(dir);
  const agentFile = join(dir, "agent.mjs");
  const marker = join(dir, "never-logged-in");
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const states = new AcpAuthStateStore();
  const launch = async () => ({
    executable: process.execPath,
    args: [agentFile, marker],
    env: process.env,
  });
  const coordinator = new AcpRuntimeCoordinator(repo, {}, launch, () => false, states);
  try {
    await writeFile(agentFile, AGENT);
    const { saveAgentConfig } = await import("../src/agent-runtime/builtin/agentConfigRegistry.js");
    await saveAgentConfig({
      id: "claude-byok",
      name: "Claude BYOK",
      runtime: "claude-code",
      auth: "byok",
      provider: { preset: "openrouter" },
    });
    await assert.rejects(
      coordinator.create({ workspacePath: dir, commandId: "b1", runtimeId: "claude-byok" }),
      /API key rejected by the provider: Authentication required/,
    );
    assert.equal(states.get("claude-byok").state, "auth-required");
    assert.match(states.get("claude-byok").message ?? "", /API key rejected/);
  } finally {
    await coordinator.closeAll();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
