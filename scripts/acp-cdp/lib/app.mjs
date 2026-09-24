// Launches the real CodeZ desktop app (production bundles under packages/desktop/out) with a
// throwaway HOME / data dir and attaches Playwright over the Chrome DevTools Protocol.
//
// The runner only drives the renderer with real input (locator clicks / hover, keyboard typing via
// Input.dispatch*) and reads the DOM for assertions. It never touches React internals, `window.zcode`
// or app events.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { killOwned, killTree, processTree } from "./procs.mjs";
import { cdpDir, desktopDir, redact } from "./util.mjs";

const require = createRequire(join(desktopDir, "package.json"));

function loadPlaywright() {
  // playwright-core 是 desktop 包的既有依赖；从 desktop 解析，避免新增根依赖。
  return require("playwright-core");
}

export function resolveElectronBinary() {
  const root = join(require.resolve("electron/package.json"), "..");
  if (process.platform === "darwin")
    return join(root, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  if (process.platform === "win32") return join(root, "dist", "electron.exe");
  return join(root, "dist", "electron");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function hasCommand(command) {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((dir) => dir && existsSync(join(dir, command)));
}

/**
 * @param {object} options
 * @param {string} options.root throwaway root (home/, data/, userdata/ live below it)
 * @param {string} options.workspace absolute workspace path passed via --open-workspace
 * @param {string} options.artifacts per-case artifact directory
 * @param {Record<string,string>} options.extraEnv additional env for the app (never secrets)
 * @param {string[]} options.secrets values to redact from every log line
 * @param {string[]} options.ownedPathMarkers paths whose processes belong to this run (runtimes dir)
 */
export async function launchApp({
  root,
  workspace,
  artifacts,
  extraEnv = {},
  secrets = [],
  ownedPathMarkers = [],
}) {
  const home = join(root, "home");
  const data = join(root, "data");
  const userData = join(root, "userdata");
  for (const dir of [home, data, userData, join(userData, "session")])
    await mkdir(dir, { recursive: true });

  const electron = resolveElectronBinary();
  if (!existsSync(electron))
    throw new Error(
      `Electron binary missing at ${electron}; run node node_modules/electron/install.js`,
    );
  const appVersionHook = join(cdpDir, "electron-app-version.cjs");
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    // 界面文案按英文断言；部分 ACP 设置文案是硬编码中文，选择器里单独处理。
    LANG: "en_US.UTF-8",
    LANGUAGE: "en_US",
    LC_ALL: "en_US.UTF-8",
    ZCODE_DATA_BASE_DIR: data,
    ZCODE_DESKTOP_HOME_DIR: home,
    ZCODE_DESKTOP_USER_DATA_DIR: userData,
    // 独立应用名 → 独立单实例锁，不会把启动请求转交给本机已运行的 CodeZ。
    ZCODE_DESKTOP_APPLICATION_NAME: "CodeZ CDP E2E",
    // main 在未打包时默认固定 9229；由本 runner 显式分配端口。
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
    ...extraEnv,
  };
  const electronArgs = [
    // Linux root / 容器内 Chromium 沙箱不可用；macOS 不需要。
    ...(process.platform === "linux" ? ["--no-sandbox", "--password-store=basic"] : []),
    // macOS：Chromium OSCrypt 默认在登录钥匙串里创建 "<应用名> Safe Storage"；测试用模拟钥匙串，不写用户钥匙串。
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    "-r",
    appVersionHook,
    // 断言使用英文界面文案：Linux/Windows 由 LANG / --lang 决定，macOS 由 AppleLanguages 决定。
    ...(process.platform === "darwin" ? [] : ["--lang=en-US"]),
    // Chromium 默认只在 127.0.0.1 上监听远程调试端口。
    `--remote-debugging-port=${port}`,
    desktopDir,
    `--open-workspace=${workspace}`,
    // NSUserDefaults 参数域覆盖系统首选语言（仅本进程）；必须放在应用路径之后，default_app 不解析它们。
    ...(process.platform === "darwin" ? ["-AppleLanguages", "(en-US)"] : []),
  ];
  let command = electron;
  let args = electronArgs;
  if (process.platform === "linux" && !process.env.DISPLAY) {
    if (!hasCommand("xvfb-run"))
      throw new Error("No DISPLAY and xvfb-run is not installed; cannot start Electron headless");
    command = "xvfb-run";
    args = ["-a", "-s", "-screen 0 1440x900x24", electron, ...electronArgs];
  }

  const appLogPath = join(artifacts, "app.log");
  const appLog = createWriteStream(appLogPath);
  const child = spawn(command, args, {
    cwd: desktopDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pipe = (stream) =>
    stream.on("data", (chunk) => appLog.write(redact(chunk.toString("utf8"), secrets)));
  pipe(child.stdout);
  pipe(child.stderr);
  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  // Host 以独立进程组启动 ACP Runtime；记录运行期间见过的全部后代，收尾时一并回收。
  const seenPids = new Set([child.pid]);
  const rememberTree = () => {
    if (process.platform === "win32" || exited) return;
    for (const pid of processTree(child.pid)) seenPids.add(pid);
  };

  const { chromium } = loadPlaywright();
  const endpoint = `http://127.0.0.1:${port}`;
  let browser = null;
  const deadline = Date.now() + 90_000;
  while (!browser) {
    if (exited) throw new Error(`Electron exited before CDP was ready: ${JSON.stringify(exited)}`);
    if (Date.now() > deadline) throw new Error(`CDP endpoint ${endpoint} not ready after 90s`);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 5_000 });
    } catch {
      await sleep(500);
    }
  }
  const context = browser.contexts()[0] ?? (await browser.waitForEvent("context"));
  const page = await waitForMainWindow(context);

  const cdpLog = createWriteStream(join(artifacts, "cdp-events.jsonl"));
  const logCdp = (event, params) =>
    cdpLog.write(`${redact(JSON.stringify({ at: Date.now(), event, params }), secrets)}\n`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  for (const event of [
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Log.entryAdded",
    "Page.frameNavigated",
    "Page.loadEventFired",
    "Page.javascriptDialogOpening",
  ])
    cdp.on(event, (params) => {
      if (event === "Runtime.consoleAPICalled")
        logCdp(event, {
          type: params.type,
          args: params.args?.map((arg) => arg.value ?? arg.description ?? arg.type),
        });
      else logCdp(event, params);
    });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  return {
    browser,
    context,
    page,
    port,
    pid: child.pid,
    logAction: (entry) => logCdp("runner.action", entry),
    exited: () => exited,
    rememberTree,
    async close({ tracePath } = {}) {
      rememberTree();
      if (tracePath) await context.tracing.stop({ path: tracePath }).catch(() => {});
      await browser.close().catch(() => {});
      await killTree(child.pid);
      // 已被收养的遗留进程：只回收命令行仍指向本次 Electron / 受管 Runtime 的 PID，避免误杀复用的 PID。
      killOwned(seenPids, [electron, ...ownedPathMarkers]);
      await new Promise((resolve) => cdpLog.end(resolve));
      await new Promise((resolve) => appLog.end(resolve));
    },
  };
}

async function waitForMainWindow(context) {
  const isMain = (page) => /\/out\/renderer\/index\.html/.test(page.url());
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const page = context.pages().find(isMain);
    if (page) {
      await page.waitForLoadState("domcontentloaded");
      return page;
    }
    await context.waitForEvent("page", { timeout: 2_000 }).catch(() => null);
  }
  throw new Error(
    `Main window did not open; pages: ${context
      .pages()
      .map((page) => page.url())
      .join(", ")}`,
  );
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
