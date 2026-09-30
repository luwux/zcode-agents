// Read-only DOM helpers. Everything here runs through page.evaluate and only reads the DOM.

export const isTerminalToolStatus = (status) =>
  !["pending", "running", "inputStreaming", "in_progress", "streaming"].includes(status ?? "");

/** Snapshot of the conversation surface; passed to page.evaluate, never mutates the page. */
export function probeDom() {
  const text = (element) => (element?.innerText ?? "").replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll('[data-testid^="v4-row-"]')];
  return {
    stop: Boolean(document.querySelector('[data-testid="v4-stop"]')),
    send: Boolean(document.querySelector('[data-testid="v4-composer-send"]')),
    permission: Boolean(document.querySelector('[role="listbox"] [data-permission-option-kind]')),
    // 运行中的轮次标题为 "Working for …"，完成后变为 "Worked for …"。
    working: [
      ...document.querySelectorAll('[data-testid^="chat-assistant-history-trigger-"]'),
    ].some((element) => /^\s*Working for\b/.test(element.textContent ?? "")),
    rows: rows.map((row) => ({
      id: row.getAttribute("data-testid"),
      assistant: row.classList.contains("group/assistant-row"),
      tool: Boolean(row.querySelector('[data-testid^="chat-tool-call-block-"]')),
      text: text(row).slice(0, 400),
    })),
    toolCards: [...document.querySelectorAll('[data-testid^="chat-tool-call-block-"]')].map(
      (card) => ({
        id: card.getAttribute("data-tool-call-id"),
        name: card.getAttribute("data-tool-name"),
        status: card.getAttribute("data-status"),
      }),
    ),
    timelineText: text(document.querySelector('[data-testid^="v4-timeline"]') ?? document.body),
    alerts: [...document.querySelectorAll('[data-testid^="v4-timeline"] [role="alert"]')].map(
      (element) => text(element).slice(0, 300),
    ),
  };
}

/** Strips Markdown decoration so recorded model text can be compared with rendered text. */
export function normalizeText(value) {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
