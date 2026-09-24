// UI steps driven with real input only (locator clicks / hover / keyboard). `ui.click` logs every
// action into cdp-events.jsonl before dispatching it.
import { setTimeout as sleep } from "node:timers/promises";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Welcome screen → "Use API key" → "Skip for now" → onboarding questionnaire → "Exit onboarding". */
export async function dismissOnboarding({ page, click }) {
  const composer = page.getByTestId("v4-composer-input");
  const buttons = [
    ["Skip for now", page.getByRole("button", { name: "Skip for now", exact: true })],
    ["Use API key", page.getByRole("button", { name: "Use API key", exact: true })],
    ["Exit onboarding", page.getByRole("button", { name: "Exit onboarding", exact: true })],
  ];
  const clicked = [];
  const deadline = Date.now() + 90_000;
  let settledSince = null;
  while (Date.now() < deadline) {
    let acted = false;
    for (const [label, button] of buttons) {
      if (!(await button.isVisible().catch(() => false))) continue;
      await click(button, label);
      clicked.push(label);
      acted = true;
      break;
    }
    if (acted) settledSince = null;
    else if (await composer.isVisible().catch(() => false)) {
      // 引导页可能在 composer 出现后才弹出；稳定 2 秒再继续。
      settledSince ??= Date.now();
      if (Date.now() - settledSince > 2_000) break;
    }
    await sleep(250);
  }
  if (!(await composer.isVisible())) throw new Error("composer did not appear");
  return { clicked };
}

/**
 * Composer model picker → "Manage models" → Settings › ACP › config → "同步 Agent 模型" → switch the
 * wanted model on → "Back to workspace". Live mode never enables a different (maybe pricier) model.
 */
export async function enableModelInSettings(
  { page, click },
  { configName, wanted, allowDefault, strict, timeoutMs },
) {
  await click(page.getByTestId("chat-model-select-trigger"), "model picker");
  await click(page.getByRole("menuitem", { name: "Manage models", exact: true }), "Manage models");
  const nav = page.getByRole("button", { name: configName, exact: true });
  await nav.waitFor({ timeout: 30_000 });
  await click(nav, `ACP provider ${configName}`);
  const section = page.locator('section[aria-label="ACP 供应商"]');
  await section.waitFor({ timeout: 15_000 });
  const syncButton = section.getByRole("button", { name: "同步 Agent 模型", exact: true });
  await syncButton.waitFor({ timeout: 15_000 });
  await click(syncButton, "同步 Agent 模型 (sync agent models)");
  const errors = section.locator('[role="alert"].text-destructive');
  const deadline = Date.now() + timeoutMs;
  while ((await section.getByRole("switch").count()) === 0) {
    const alert = await errors.allInnerTexts().catch(() => []);
    if (alert.length) throw new Error(`model sync failed: ${alert.join(" | ")}`);
    if (Date.now() > deadline) throw new Error("model sync did not list any model");
    await sleep(300);
  }
  // 每行模型：可见名称 + title（"<ACP 模型选项 ID> · <描述>"，ID 含 Runtime 公布的模型值）。
  const models = await section.evaluate((element) =>
    [...element.querySelectorAll("label")]
      .filter((label) => label.querySelector('[role="switch"]'))
      .map((label) => ({
        label: label.innerText.replace(/\s+/g, " ").trim(),
        title: label.querySelector("[title]")?.getAttribute("title") ?? "",
      })),
  );
  if (!models.length) throw new Error("no model rows next to the switches");
  const isDefault = (model) => /^Default\b/i.test(model.label);
  const chosen =
    models.find((model) => model.title.includes(wanted) || model.label.includes(wanted)) ??
    (allowDefault ? models.find(isDefault) : undefined) ??
    (strict ? undefined : models[0]);
  if (!chosen)
    throw new Error(
      `model ${wanted} is not advertised (${models.map((model) => model.label).join(", ")}); ` +
        "refusing to enable a different model",
    );
  const control = section
    .locator("label")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(chosen.label)}\\s*$`) })
    .first()
    .getByRole("switch");
  await click(control, `enable model ${chosen.label}`);
  // 开关保存期间整组 disabled；保存成功后保持选中且可再次操作。
  const saveDeadline = Date.now() + 30_000;
  while (
    !((await control.getAttribute("aria-checked")) === "true" && (await control.isEnabled()))
  ) {
    const alert = await errors.allInnerTexts();
    if (alert.length) throw new Error(`saving the model selection failed: ${alert.join(" | ")}`);
    if (Date.now() > saveDeadline) throw new Error(`model ${chosen.label} did not stay enabled`);
    await sleep(200);
  }
  await click(page.getByTestId("settings-back-button"), "Back to workspace");
  await page.getByTestId("v4-composer-input").waitFor({ timeout: 30_000 });
  return { models: models.map((model) => model.label), enabled: chosen.label };
}

/** Existing composer model picker → hover the runtime's ACP group → click its (only) model. */
export async function pickRuntimeInModelPicker(
  { page, click, logAction },
  { configId, configName },
) {
  const trigger = page.getByTestId("chat-model-select-trigger");
  await click(trigger, "model picker");
  const group = page.getByTestId(`chat-model-select-group-acp-provider:${configId}`);
  await group.waitFor({ timeout: 15_000 });
  logAction({ action: "hover", target: `picker group ${configId}` });
  await group.hover();
  const items = page.locator(`[data-testid^="chat-model-select-item-custom:${configId}:"]`);
  await items.first().waitFor({ timeout: 10_000 });
  const names = await items.allInnerTexts();
  await click(items.first(), `picker model ${names[0]}`);
  await page.waitForFunction(
    (name) =>
      document
        .querySelector('[data-testid="chat-model-select-trigger"]')
        ?.textContent?.includes(name),
    configName,
    { timeout: 15_000 },
  );
  return { pickerItems: names, trigger: (await trigger.innerText()).trim() };
}

/** Composer "ACP session mode" menu → mode by its advertised name (never a bypass mode). */
export async function pickAcpSessionMode({ page, click }, mode) {
  const modeButton = page.getByRole("button", { name: "ACP session mode", exact: true });
  await modeButton.waitFor({ timeout: 15_000 });
  const deadline = Date.now() + 60_000;
  while (!(await modeButton.isEnabled())) {
    if (Date.now() > deadline) throw new Error("ACP session modes never loaded");
    await sleep(250);
  }
  await click(modeButton, "ACP session mode");
  const items = page.getByRole("menuitemradio");
  await items.first().waitFor({ timeout: 10_000 });
  const available = (await items.allInnerTexts()).map((item) => item.trim());
  const item = page.getByRole("menuitemradio", { name: mode.name, exact: true });
  if ((await item.count()) === 0)
    throw new Error(`mode "${mode.name}" not offered; modes: ${available.join(", ")}`);
  await click(item, `mode ${mode.name}`);
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("button[aria-label='ACP session mode']")].some(
        (button) => button.textContent?.trim() === name,
      ),
    mode.name,
    { timeout: 10_000 },
  );
  return { available, selected: mode.name };
}

/** Completed turns fold their tool cards into "Worked for …"; open each one with a click. */
export async function expandTurnHistories({ page, click }) {
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = page.locator(
      '[data-testid^="chat-assistant-history-trigger-"][aria-expanded="false"]',
    );
    if ((await collapsed.count()) === 0) return;
    await click(collapsed.first(), "expand turn history");
    await sleep(300);
  }
}
