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

const until = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(200);
  }
};

/**
 * Composer model picker → "Manage models" → Settings › ACP › config (the built-in runtime card) →
 * optionally "Add model" (dialog: type the model ID, Save) and the API key (type it, Enter) through the
 * real UI → make sure the model is switched on → "Back to workspace". Configs without declared models
 * fall back to "Sync models" + switching the wanted advertised model on. Live mode never enables a
 * different (maybe pricier) model.
 */
export async function configureRuntimeInSettings(
  { page, click, logAction, screenshot },
  { configId, configName, addModel, apiKey, wanted, allowDefault, strict, timeoutMs },
) {
  await click(page.getByTestId("chat-model-select-trigger"), "model picker");
  await click(page.getByRole("menuitem", { name: "Manage models", exact: true }), "Manage models");
  // 导航项的可访问名称还包含状态圆点的标签，按导航项 test id 定位。
  const nav = page.getByTestId(`model-provider-nav-item-acp:${configId}`);
  await nav.waitFor({ timeout: 30_000 });
  await click(nav, `ACP provider ${configName}`);
  const card = page.getByTestId("acp-builtin-card");
  await card.waitFor({ timeout: 15_000 });
  const observed = {};
  if (addModel) {
    await click(card.getByTestId("model-provider-add-model-button"), "Add model");
    const idInput = page.getByTestId("acp-builtin-model-id");
    await idInput.waitFor({ timeout: 10_000 });
    await click(idInput, "model ID");
    logAction({ action: "type", target: "model ID", text: addModel });
    await page.keyboard.type(addModel, { delay: 5 });
    await screenshot?.("settings-add-model-dialog");
    await click(
      page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }),
      "Save",
    );
    await card.getByTestId("acp-builtin-model-0").waitFor({ timeout: 15_000 });
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
    observed.addedModel = (await card.getByTestId("acp-builtin-model-0").innerText()).trim();
  }
  if (apiKey) {
    const reason = card.getByTestId("acp-builtin-reason");
    observed.reasonBefore = (await reason.innerText().catch(() => "")).trim();
    if (!/API key is not configured/.test(observed.reasonBefore))
      throw new Error(`expected the missing-key status first, got "${observed.reasonBefore}"`);
    const keyInput = card.getByTestId("acp-builtin-api-key");
    await click(keyInput, "API key input");
    // 回放用的是固定假 Key；实时模式仍经 stdin 播种，真实 Key 不进入 trace。
    logAction({ action: "type", target: "API key input", text: "[replay dummy key]" });
    await page.keyboard.type(apiKey, { delay: 5 });
    await page.keyboard.press("Enter");
    // 卡片翻转为已配置：缺少 Key 的原因消失，输入框清空（只写）并显示“已保存”占位。
    await until(
      async () =>
        (await reason.count()) === 0 &&
        (await keyInput.inputValue()) === "" &&
        /Saved/.test((await keyInput.getAttribute("placeholder")) ?? ""),
      30_000,
      "API key saved and the card shows the configured state",
    );
    observed.placeholderAfter = await keyInput.getAttribute("placeholder");
    await screenshot?.("settings-api-key-saved");
  }
  const row = card.getByTestId("acp-builtin-model-0");
  if ((await row.count()) > 0) {
    const toggle = card.getByTestId("acp-builtin-model-0-enabled");
    if ((await toggle.getAttribute("aria-checked")) !== "true") {
      await click(toggle, "enable model 0");
      await until(
        async () => (await toggle.getAttribute("aria-checked")) === "true",
        30_000,
        "model 0 enabled",
      );
    }
    observed.enabled = (await row.innerText()).trim();
  } else {
    observed.enabled = await enableAdvertisedModel({ page, click }, card, {
      wanted,
      allowDefault,
      strict,
      timeoutMs,
    });
  }
  await click(page.getByTestId("settings-back-button"), "Back to workspace");
  await page.getByTestId("v4-composer-input").waitFor({ timeout: 30_000 });
  return observed;
}

/** "Sync models" → switch the wanted advertised model on (configs without declared models). */
async function enableAdvertisedModel({ click }, card, { wanted, allowDefault, strict, timeoutMs }) {
  await click(card.getByTestId("acp-builtin-sync-models"), "Sync models");
  const errors = card.locator('[role="alert"].text-destructive');
  const deadline = Date.now() + timeoutMs;
  while ((await card.locator("label").getByRole("switch").count()) === 0) {
    const alert = await errors.allInnerTexts().catch(() => []);
    if (alert.length) throw new Error(`model sync failed: ${alert.join(" | ")}`);
    if (Date.now() > deadline) throw new Error("model sync did not list any model");
    await sleep(300);
  }
  const models = await card.evaluate((element) =>
    [...element.querySelectorAll("label")]
      .filter((label) => label.querySelector('[role="switch"]'))
      .map((label) => ({
        label: label.innerText.replace(/\s+/g, " ").trim(),
        title: label.querySelector("[title]")?.getAttribute("title") ?? "",
      })),
  );
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
  const control = card
    .locator("label")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(chosen.label)}\\s*$`) })
    .first()
    .getByRole("switch");
  await click(control, `enable model ${chosen.label}`);
  await until(
    async () =>
      (await control.getAttribute("aria-checked")) === "true" && (await control.isEnabled()),
    30_000,
    `model ${chosen.label} enabled`,
  );
  return chosen.label;
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
