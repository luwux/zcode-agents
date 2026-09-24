// Watches one turn after the prompt was sent: records streamed rows / tool cards and answers
// permission dialogs with real clicks until the composer is idle again.
import { setTimeout as sleep } from "node:timers/promises";
import { probeDom } from "./dom.mjs";

async function answerPermission({
  page,
  app,
  screenshot,
  turn,
  observation,
  permissionLog,
  allowed,
}) {
  const listbox = page.locator('[role="listbox"]').filter({
    has: page.locator("[data-permission-option-kind]"),
  });
  const options = await listbox.locator('[role="option"]').evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute("aria-label"),
      kind: element.getAttribute("data-permission-option-kind"),
    })),
  );
  const entry = { turn, atMs: observation.elapsed, options, answered: null };
  permissionLog.push(entry);
  observation.permissions += 1;
  await screenshot(`turn-${turn}-permission-${observation.permissions}`);
  if (!allowed) throw new Error(`unexpected permission prompt in turn ${turn}`);
  const allow = listbox
    .locator('[role="option"][data-permission-option-kind="allowOnce"]')
    .or(listbox.locator('[role="option"][data-permission-option-kind^="allow"]'))
    .first();
  const handle = await listbox.elementHandle();
  // 选项按钮：未选中时第一次点击只选中；再点 Confirm 提交，与用户操作一致。
  if ((await allow.getAttribute("aria-selected")) !== "true") {
    app.logAction({ action: "click", target: "permission option allowOnce" });
    await allow.click();
  }
  entry.answered = await allow.getAttribute("aria-label");
  app.logAction({ action: "click", target: "permission Confirm" });
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  const deadline = Date.now() + 20_000;
  while ((await handle?.evaluate((element) => element.isConnected).catch(() => false)) === true) {
    if (Date.now() > deadline) throw new Error("permission dialog did not close");
    await sleep(100);
  }
  await screenshot(`turn-${turn}-permission-${observation.permissions}-answered`);
}

/**
 * @param baseline probeDom() taken before the prompt was sent (a fast replay can finish a whole turn
 *   before the first poll after sending).
 */
export async function waitForTurn({
  page,
  baseline,
  app,
  screenshot,
  turn,
  timeoutMs,
  answerPermissions,
  permissionLog,
}) {
  const started = Date.now();
  const baselineRows = new Set(baseline.rows.map((row) => row.id));
  const baselineTools = new Set(baseline.toolCards.map((card) => card.id));
  const observation = {
    turn,
    completed: false,
    started: false,
    firstAssistantMs: null,
    firstToolMs: null,
    toolCardsSeen: 0,
    toolStatusesSeen: {},
    permissions: 0,
    // 本轮首次出现的每一行：出现时刻、类型、是否仍在运行（证明是流式渲染而非结束后一次性出现）。
    newRows: [],
    ms: 0,
  };
  const toolIds = new Set();
  const seenRows = new Set();
  const statusPairs = new Set();
  const pendingShots = [];
  let idleSince = null;
  const record = (dom) => {
    const elapsed = Date.now() - started;
    const running = dom.stop || dom.working || dom.permission;
    for (const row of dom.rows) {
      if (baselineRows.has(row.id) || seenRows.has(row.id) || !row.text) continue;
      seenRows.add(row.id);
      const kind = row.assistant ? "assistant" : row.tool ? "tool" : "other";
      observation.newRows.push({
        id: row.id,
        kind,
        atMs: elapsed,
        running,
        text: row.text.slice(0, 60),
      });
      if (kind === "assistant" && running && observation.firstAssistantMs === null) {
        observation.firstAssistantMs = elapsed;
        // 不阻塞轮询：流式截图与后续 DOM 读取并行进行。
        pendingShots.push(screenshot(`turn-${turn}-streaming-assistant`));
      }
    }
    if (running || observation.newRows.some((row) => row.kind === "assistant"))
      observation.started = true;
    for (const card of dom.toolCards) {
      if (!card.id || baselineTools.has(card.id)) continue;
      if (!toolIds.size) {
        observation.firstToolMs = elapsed;
        pendingShots.push(screenshot(`turn-${turn}-tool-card`));
      }
      toolIds.add(card.id);
      // 每张卡片出现过的状态（去重），例如 pending → completed。
      const statusKey = `${card.id}\u0000${card.status}`;
      if (!statusPairs.has(statusKey)) {
        statusPairs.add(statusKey);
        observation.toolStatusesSeen[card.status] =
          (observation.toolStatusesSeen[card.status] ?? 0) + 1;
      }
    }
    observation.toolCardsSeen = toolIds.size;
    return elapsed;
  };
  while (Date.now() - started < timeoutMs) {
    if (app.exited())
      throw new Error(`app exited during turn ${turn}: ${JSON.stringify(app.exited())}`);
    app.rememberTree();
    const dom = await page.evaluate(probeDom);
    const elapsed = record(dom);

    if (dom.permission) {
      idleSince = null;
      observation.elapsed = elapsed;
      // 权限弹窗期间工具卡片可能刚出现；回答前再读一次，避免批准后整轮很快折叠而漏记。
      record(await page.evaluate(probeDom));
      await answerPermission({
        page,
        app,
        screenshot,
        turn,
        observation,
        permissionLog,
        allowed: answerPermissions,
      });
      delete observation.elapsed;
      continue;
    }

    const idle = !dom.stop && dom.send && !dom.working;
    if (observation.started && idle) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 1_500) {
        observation.completed = true;
        break;
      }
    } else {
      idleSince = null;
    }
    await sleep(150);
  }
  observation.ms = Date.now() - started;
  await Promise.all(pendingShots);
  await screenshot(`turn-${turn}-${observation.completed ? "complete" : "timeout"}`);
  return observation;
}
