import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpRuntimeCoordinator } from "../src/agent-runtime/acpRuntimeCoordinator.js";
import { AcpV4Bridge } from "../src/agent-runtime/acpV4Bridge.js";
import { saveAgentServerConfig } from "../src/agent-runtime/agentServersRegistry.js";
import { getZCodeDataRootDir, setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { AcpTranscriptStore } from "../src/agent-runtime/acpTranscriptStore.js";

const AGENT = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
let model = 'auto';
let thought = 'low';
let mode = 'default';
const configOptions = () => [
  {id:'model',name:'Model',category:'model',type:'select',currentValue:model,
    options:[{value:'auto',name:'Auto'},{value:'ultimate',name:'Ultimate'}]},
  {id:'reasoning_effort',name:'Effort',category:'model',type:'select',currentValue:thought,
    options:[{value:'low',name:'Low'},{value:'high',name:'High'}]},
  {id:'permission-mode',name:'Permission Mode',category:'mode',type:'select',currentValue:mode,
    options:[{value:'default',name:'Default'},{value:'bypass',name:'Bypass Permissions'}]}
];
for await (const line of input) {
  const request = JSON.parse(line);
  const answer = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result})+'\\n');
  if (request.method === 'initialize') answer({protocolVersion:request.params.protocolVersion,agentCapabilities:{loadSession:true,promptCapabilities:{image:true}}});
  if (request.method === 'session/new') answer({sessionId:'native-session-'+process.pid,configOptions:configOptions()});
  if (request.method === 'session/load') answer({configOptions:configOptions()});
  if (request.method === 'session/set_config_option') {
    if (request.params.configId === 'model') model = request.params.value;
    else if (request.params.configId === 'reasoning_effort') thought = request.params.value;
    else if (request.params.configId === 'permission-mode') mode = request.params.value;
    answer({configOptions:configOptions()});
  }
  if (request.method === 'session/prompt') {
    const blocks = request.params.prompt;
    if (blocks.some((block) => block.type === 'text' && block.text === 'agent-switch-bypass')) {
      mode = 'bypass';
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{
        sessionId:request.params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:configOptions()}
      }})+'\\n');
    }
    if (blocks.some((block) => block.type === 'text' && block.text === 'title-update')) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{
        sessionId:request.params.sessionId,update:{sessionUpdate:'session_info_update',title:'Agent title'}
      }})+'\\n');
    }
    const reply = blocks.some((block) => block.type === 'image') ? 'image-received'
      : blocks.some((block) => block.type === 'resource' && block.resource.text === 'local note') ? 'file-received' : 'reply';
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{
      sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:reply}}
    }})+'\\n');
    answer({stopReason:'end_turn'});
  }
}
`;

test("ACP saves confirmed mode and reapplies it before restoring a historical task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-mode-restore-"));
  const agentFile = join(dir, "agent.mjs");
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const target = { workspacePath: dir, taskId: "mode-task" };
  const makeCoordinator = () =>
    new AcpRuntimeCoordinator(repo, {}, async () => ({
      executable: process.execPath,
      args: [agentFile],
    }));
  setDataBaseDir(dir);
  let coordinator = makeCoordinator();
  try {
    await writeFile(agentFile, AGENT);
    await saveAgentServerConfig({
      id: "mode-restore-agent",
      name: "Mode Restore Agent",
      command: process.execPath,
      args: [agentFile],
    });
    const created = await coordinator.create({
      ...target,
      commandId: target.taskId,
      runtimeId: "mode-restore-agent",
      modeId: "bypass",
    });
    assert.equal(created.acpModeId, "bypass");
    assert.equal((await repo.getTaskMeta(target))?.acpModeId, "bypass");
    await coordinator.closeAll();

    // 新 Agent 进程从 default 启动；恢复必须在会话可用前把保存值重新应用。
    coordinator = makeCoordinator();
    const restored = await coordinator.load(target);
    assert.equal(restored.config.acpModeId, "bypass");
    await coordinator.setMode({ ...target, value: "default" });
    assert.equal((await repo.getTaskMeta(target))?.acpModeId, "default");
    await coordinator.closeAll();

    coordinator = makeCoordinator();
    assert.equal((await coordinator.load(target)).config.acpModeId, "default");
    await coordinator.closeAll();
    const bridge = new AcpV4Bridge(
      repo,
      () => {},
      () => false,
    );
    try {
      const ack = await bridge.command(
        { workspacePath: dir },
        {
          commandId: "switch-mode",
          clientId: "test-client",
          sessionId: target.taskId,
          type: "switchModelConfig",
          payload: { provider: "acp", model: "", thought: "", acpModeId: "bypass" },
          issuedAt: Date.now(),
        },
      );
      assert.equal(ack.status, "accepted");
      assert.equal((await repo.getTaskMeta(target))?.acpModeId, "bypass");
    } finally {
      await bridge.dispose();
    }
    const stored = await repo.getTaskMeta(target);
    assert.ok(stored);
    await repo.syncTaskMeta({ meta: { ...stored, acpModeId: "removed-mode" } });
    coordinator = makeCoordinator();
    const unavailable = await coordinator.load(target);
    assert.equal(unavailable.control.phase, "error");
    assert.equal((await repo.getTaskMeta(target))?.acpModeId, "removed-mode");

    await coordinator.closeAll();
    const legacy = { workspacePath: dir, taskId: "legacy-mode-task" };
    const legacyMeta = await coordinator.create({
      ...legacy,
      commandId: legacy.taskId,
      runtimeId: "mode-restore-agent",
    });
    await repo.syncTaskMeta({ meta: { ...legacyMeta, acpModeId: undefined } });
    await coordinator.closeAll();
    coordinator = makeCoordinator();
    assert.equal((await coordinator.load(legacy)).config.acpModeId, "default");
    await coordinator.sendPrompt({
      ...legacy,
      commandId: "agent-mode-change",
      text: "agent-switch-bypass",
    });
    await waitForAcpCompletion(coordinator, legacy);
    assert.equal((await repo.getTaskMeta(legacy))?.acpModeId, "bypass");

    // Agent 已接受新权限模式但索引写入失败时，不能让旧持久值和运行态分叉后继续执行。
    const syncTaskMeta = repo.syncTaskMeta.bind(repo);
    repo.syncTaskMeta = async () => {
      throw new Error("task index write failed");
    };
    try {
      await assert.rejects(
        coordinator.setMode({ ...legacy, value: "default" }),
        /task index write failed/,
      );
      assert.equal(coordinator.snapshot(legacy)?.control.phase, "error");
      assert.equal(coordinator.isUnavailable(legacy), true);
      assert.equal((await repo.getTaskMeta(legacy))?.acpModeId, "bypass");
    } finally {
      repo.syncTaskMeta = syncTaskMeta;
    }

    const agentChanged = { workspacePath: dir, taskId: "agent-mode-write-failure" };
    await coordinator.create({
      ...agentChanged,
      commandId: agentChanged.taskId,
      runtimeId: "mode-restore-agent",
    });
    repo.syncTaskMeta = async (input) => {
      if (input.meta.taskId === agentChanged.taskId && input.meta.acpModeId === "bypass")
        throw new Error("mode update write failed");
      return syncTaskMeta(input);
    };
    try {
      await coordinator.sendPrompt({
        ...agentChanged,
        commandId: "agent-mode-write-failure-prompt",
        text: "agent-switch-bypass",
      });
      await waitForAcpCompletion(coordinator, agentChanged, "error");
      assert.equal((await repo.getTaskMeta(agentChanged))?.acpModeId, "default");
      assert.equal(coordinator.snapshot(agentChanged)?.control.phase, "error");
      assert.equal(
        coordinator.snapshot(agentChanged)?.availability.switchModelConfig.allowed,
        false,
      );
      await assert.rejects(
        coordinator.sendPrompt({
          ...agentChanged,
          commandId: "blocked-after-mode-write-failure",
          text: "must not run",
        }),
        /process exited/,
      );
    } finally {
      repo.syncTaskMeta = syncTaskMeta;
    }
  } finally {
    await coordinator.closeAll();
    repo.close();
    setDataBaseDir(null);
    // 修复原因：已退出进程的转录尾写可能与递归删除并发，偶发 ENOTEMPTY；重试删除而不改断言。
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ACP coordinator binds workbench identity, deduplicates and restores V4 history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-coordinator-"));
  const agentFile = join(dir, "agent.mjs");
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  setDataBaseDir(dir);
  const snapshots: Array<{ phase: string; status: string | undefined; title: string }> = [];
  const makeCoordinator = () =>
    new AcpRuntimeCoordinator(
      repo,
      {
        onSnapshot: (meta, snapshot) =>
          snapshots.push({ phase: snapshot.control.phase, status: meta.status, title: meta.title }),
      },
      async () => ({ executable: process.execPath, args: [agentFile] }),
    );
  let coordinator = makeCoordinator();
  const target = { workspacePath: dir, workspaceIdentity: "remote-a", taskId: "create-1" };
  try {
    await writeFile(agentFile, AGENT);
    await saveAgentServerConfig({
      id: "coordinator-agent",
      name: "Coordinator Agent",
      command: process.execPath,
      args: [agentFile],
    });
    const config = { modelId: "acp:model:model:ultimate", thoughtLevel: "high" };
    const preview = await coordinator.discoverConfig({
      ...target,
      runtimeId: "coordinator-agent",
      modelId: config.modelId,
    });
    assert.equal(preview.selectedModel, config.modelId);
    assert.deepEqual(
      preview.thoughtLevels.map((level) => level.value),
      ["low", "high"],
    );
    const [first, duplicate] = await Promise.all([
      coordinator.create({
        ...target,
        commandId: target.taskId,
        runtimeId: "coordinator-agent",
        ...config,
      }),
      coordinator.create({
        ...target,
        commandId: target.taskId,
        runtimeId: "coordinator-agent",
        ...config,
      }),
    ]);
    assert.match(first.nativeSessionId ?? "", /^native-session-\d+$/);
    assert.deepEqual(duplicate, first);
    assert.equal((await repo.getTaskMeta(target))?.runtimeId, "coordinator-agent");
    assert.equal(first.model, config.modelId);
    assert.equal(first.thoughtLevel, config.thoughtLevel);
    assert.equal(
      await coordinator.sendPrompt({ ...target, commandId: "prompt-1", text: "hello" }),
      "accepted",
    );
    assert.equal(
      await coordinator.sendPrompt({ ...target, commandId: "prompt-1", text: "hello" }),
      "duplicate",
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ACP turn did not complete")), 3000);
      const poll = () => {
        if (coordinator.snapshot(target)?.control.phase === "completedSuccess") {
          clearTimeout(timeout);
          resolve();
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    assert.equal((await repo.getTaskMeta(target))?.title, "hello");
    await repo.updateTaskState({
      ...target,
      patch: { title: "Manual title", titleOverridden: true, updatedAt: Date.now() },
    });
    await coordinator.sendPrompt({ ...target, commandId: "prompt-2", text: "title-update" });
    await waitForAcpCompletion(coordinator, target);
    assert.equal((await repo.getTaskMeta(target))?.title, "Manual title");
    assert.equal(coordinator.snapshot(target)?.meta.title, "Manual title");
    await coordinator.closeAll();
    coordinator = makeCoordinator();
    const restored = await coordinator.load(target);
    assert.equal(restored.control.phase, "completedSuccess");
    assert.equal(restored.config.model, config.modelId);
    assert.equal(restored.config.thought, config.thoughtLevel);
    assert.ok(
      restored.rows.window.some((row) => row.kind === "assistantText" && row.text === "reply"),
    );
    assert.equal(
      await coordinator.sendPrompt({ ...target, commandId: "prompt-1", text: "hello" }),
      "duplicate",
    );
    assert.ok(
      snapshots.some(
        (snapshot) =>
          snapshot.phase === "running" &&
          snapshot.status === "running" &&
          snapshot.title === "hello",
      ),
    );
    assert.ok(
      snapshots.some(
        (snapshot) => snapshot.phase === "completedSuccess" && snapshot.status === "completed",
      ),
    );
    await coordinator.closeAll();
    const unavailable = new AcpRuntimeCoordinator(repo, {}, async () => {
      throw new Error("Agent executable is missing");
    });
    const offline = await unavailable.load(target);
    assert.equal(offline.control.phase, "error");
    assert.equal(offline.control.lastError?.code, "acpRuntimeUnavailable");
    assert.equal(offline.inputRouting.mode, "reject");
    assert.ok(
      offline.rows.window.some((row) => row.kind === "assistantText" && row.text === "reply"),
    );
    assert.ok(unavailable.rowsRange({ ...target, limit: 100 }).rows.length > 0);
    await unavailable.closeAll();
  } finally {
    await coordinator.closeAll();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ACP sends local images and files using declared prompt capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-attachments-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const agentFile = join(dir, "agent.mjs");
  const imageFile = join(dir, "sample.png");
  const textFile = join(dir, "notes.txt");
  const target = { workspacePath: dir, taskId: "attachment-task" };
  const coordinator = new AcpRuntimeCoordinator(repo);
  try {
    await writeFile(agentFile, AGENT);
    await writeFile(imageFile, Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(textFile, "local note");
    await saveAgentServerConfig({
      id: "attachment-agent",
      name: "Attachment Agent",
      command: process.execPath,
      args: [agentFile],
    });
    await coordinator.create({
      ...target,
      commandId: target.taskId,
      runtimeId: "attachment-agent",
    });
    await coordinator.sendPrompt({
      ...target,
      commandId: "image-command",
      text: "What is this?",
      attachments: [{ ref: imageFile, fileName: "sample.png", mime: "image/png", bytes: 8 }],
    });
    await waitForAcpCompletion(coordinator, target);
    assert.ok(
      coordinator
        .snapshot(target)
        ?.rows.window.some((row) => row.kind === "assistantText" && row.text === "image-received"),
    );
    await coordinator.sendPrompt({
      ...target,
      commandId: "file-command",
      text: "Read this",
      attachments: [{ ref: textFile, fileName: "notes.txt", mime: "text/plain", bytes: 10 }],
    });
    await waitForAcpCompletion(coordinator, target);
    assert.ok(
      coordinator
        .snapshot(target)
        ?.rows.window.some((row) => row.kind === "assistantText" && row.text === "file-received"),
    );
    const transcript = new AcpTranscriptStore(dir, target.taskId, getZCodeDataRootDir());
    const entries = (await transcript.read()) ?? [];
    assert.ok(
      entries.some(
        (entry) =>
          entry.kind === "prompt" && entry.content.some((block) => block.type === "resource_link"),
      ),
    );
    assert.ok(
      entries.some(
        (entry) =>
          entry.kind === "prompt" &&
          entry.content.some(
            (block) => block.type === "resource_link" && block.uri.endsWith("sample.png"),
          ),
      ),
    );
    assert.ok(
      entries.every(
        (entry) =>
          entry.kind !== "prompt" || entry.content.every((block) => block.type !== "image"),
      ),
    );
    const imagePreview = await coordinator.readAttachment({
      ...target,
      sessionId: target.taskId,
      ref: imageFile,
      offset: 0,
      limit: 20,
    });
    assert.equal(
      imagePreview.dataBase64,
      Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
    );
    await assert.rejects(
      coordinator.readAttachment({
        ...target,
        sessionId: target.taskId,
        ref: agentFile,
        offset: 0,
        limit: 20,
      }),
      /previewRefNotAuthorized/,
    );
    await assert.rejects(
      coordinator.sendPrompt({
        ...target,
        commandId: "bad-command",
        text: "bad",
        attachments: [{ ref: "opaque-upload-ref", fileName: "x.png", mime: "image/png", bytes: 1 }],
      }),
      /local absolute path/,
    );
    const noImageAgent = join(dir, "no-image-agent.mjs");
    await writeFile(
      noImageAgent,
      AGENT.replace("promptCapabilities:{image:true}", "promptCapabilities:{image:false}"),
    );
    await saveAgentServerConfig({
      id: "no-image-agent",
      name: "No Image Agent",
      command: process.execPath,
      args: [noImageAgent],
    });
    const noImageTarget = { workspacePath: dir, taskId: "no-image-task" };
    await coordinator.create({
      ...noImageTarget,
      commandId: noImageTarget.taskId,
      runtimeId: "no-image-agent",
    });
    await assert.rejects(
      coordinator.sendPrompt({
        ...noImageTarget,
        commandId: "rejected-image",
        text: "describe",
        attachments: [{ ref: imageFile, fileName: "sample.png", mime: "image/png", bytes: 8 }],
      }),
      /does not support image prompts/,
    );
    assert.equal(
      (await new AcpTranscriptStore(dir, noImageTarget.taskId, getZCodeDataRootDir()).read())
        ?.length ?? 0,
      0,
    );
  } finally {
    await coordinator.closeAll();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function waitForAcpCompletion(
  coordinator: AcpRuntimeCoordinator,
  target: { workspacePath: string; taskId: string },
  phase: "completedSuccess" | "error" = "completedSuccess",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ACP turn did not complete")), 3000);
    const poll = () => {
      if (coordinator.snapshot(target)?.control.phase === phase) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("a configured ACP Agent absent from the built-in catalog can create and restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-custom-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const agentFile = join(dir, "agent.mjs");
  const target = { workspacePath: dir, taskId: "custom-create" };
  let coordinator = new AcpRuntimeCoordinator(repo);
  try {
    await writeFile(agentFile, AGENT);
    await saveAgentServerConfig({
      id: "unlisted-agent",
      name: "Unlisted Agent",
      command: process.execPath,
      args: [agentFile],
    });
    const preview = await coordinator.discoverConfig({ ...target, runtimeId: "unlisted-agent" });
    assert.ok(preview.models.length > 0);
    const meta = await coordinator.create({
      ...target,
      commandId: target.taskId,
      runtimeId: "unlisted-agent",
      modelId: preview.selectedModel,
    });
    assert.equal(meta.runtimeId, "unlisted-agent");
    assert.ok(meta.agentServerFingerprint);
    await coordinator.closeAll();
    coordinator = new AcpRuntimeCoordinator(repo);
    const restored = await coordinator.load(target);
    assert.equal(restored.meta.runtimeId, "unlisted-agent");
    assert.notEqual(restored.control.phase, "error");

    const frames: Array<{ kind: string; deliveryKind?: string }> = [];
    await repo.updateTaskState({
      ...target,
      patch: { status: "running", updatedAt: Date.now() },
    });
    const liveTaskStatuses: Array<string | undefined> = [];
    const bridge = new AcpV4Bridge(
      repo,
      (_target, frame) => frames.push(frame),
      () => false,
      (meta) => liveTaskStatuses.push(meta.status),
    );
    try {
      const subscribed = await bridge.subscribe(target);
      assert.equal(liveTaskStatuses.includes("running"), false);
      assert.equal(frames.at(-1)?.deliveryKind, "initial");
      assert.equal(bridge.resync(subscribed.ack.subscriptionId)?.ack.mode, "snapshot");
      assert.equal(frames.at(-1)?.deliveryKind, "recovery");
      assert.equal((await repo.getTaskMeta(target))?.nativeSessionId, meta.nativeSessionId);
      await bridge.coordinator.sendPrompt({ ...target, commandId: "event-prompt", text: "run" });
      await waitForAcpCompletion(bridge.coordinator, target);
      assert.ok(liveTaskStatuses.includes("running"));
      assert.equal(liveTaskStatuses.at(-1), "completed");
    } finally {
      await bridge.dispose();
    }
  } finally {
    await coordinator.closeAll();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ACP auxiliary conversation creates an isolated child and restores its binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-acp-side-chat-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const agentFile = join(dir, "agent.mjs");
  const target = { workspacePath: dir };
  let bridge = new AcpV4Bridge(
    repo,
    () => {},
    () => false,
  );
  try {
    await writeFile(agentFile, AGENT);
    await saveAgentServerConfig({
      id: "side-chat-agent",
      name: "Side Chat Agent",
      command: process.execPath,
      args: [agentFile],
    });
    const parent = await bridge.coordinator.create({
      ...target,
      commandId: "parent-task",
      runtimeId: "side-chat-agent",
      modelId: "acp:model:model:ultimate",
      thoughtLevel: "high",
    });
    const envelope = {
      commandId: "child-task",
      clientId: "test-client",
      sessionId: parent.taskId,
      type: "createSelectionSideSession" as const,
      payload: { firstInput: { text: "child only" } },
      issuedAt: Date.now(),
    };
    const created = await bridge.command(target, envelope);
    assert.equal(created.status, "accepted");
    assert.deepEqual(created.result, {
      type: "createSelectionSideSession",
      sessionId: "child-task",
      input: { delivery: "startNow", inputId: "child-task" },
    });
    const child = await repo.getTaskMeta({ ...target, taskId: "child-task" });
    assert.equal(child?.forkedFromTaskId, parent.taskId);
    assert.equal(child?.runtimeId, parent.runtimeId);
    assert.equal(child?.model, parent.model);
    assert.equal(child?.thoughtLevel, parent.thoughtLevel);
    assert.equal(
      (await bridge.command(target, envelope)).result?.type,
      "createSelectionSideSession",
    );
    assert.equal(
      (await bridge.queryCommand(target, { sessionId: parent.taskId, commandId: "child-task" }))
        ?.result?.type,
      "createSelectionSideSession",
    );
    assert.equal(
      (await bridge.coordinator.load({ ...target, taskId: parent.taskId })).rows.totalCount,
      0,
    );
    await waitForAcpCompletion(bridge.coordinator, { ...target, taskId: "child-task" });
    await bridge.dispose();
    bridge = new AcpV4Bridge(
      repo,
      () => {},
      () => false,
    );
    const restored = await bridge.coordinator.load({ ...target, taskId: "child-task" });
    assert.equal(restored.config.provider, "side-chat-agent");
    assert.ok(
      restored.rows.window.some((row) => row.kind === "userInput" && row.text === "child only"),
    );
  } finally {
    await bridge.dispose();
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
