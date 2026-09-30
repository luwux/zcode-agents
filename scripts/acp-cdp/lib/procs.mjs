import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** pid → ppid for every process visible to this user (macOS and Linux `ps`). */
function processTable() {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const table = new Map();
  for (const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && Number.isFinite(ppid)) table.set(pid, ppid);
  }
  return table;
}

/** All descendants of `root` (inclusive). Detached children (own process group) are included. */
export function processTree(root) {
  const table = processTable();
  const children = new Map();
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (!table.has(pid) && pid !== root) continue;
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** SIGKILL remembered PIDs that are still alive and whose command line names one of `markers`. */
export function killOwned(pids, markers) {
  for (const pid of pids) {
    if (!alive(pid)) continue;
    const command = commandLine(pid);
    if (!markers.some((marker) => marker && command.includes(marker))) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出。
    }
  }
}

/**
 * Terminates a process tree. The Host spawns ACP runtimes detached (their own process group), so
 * killing the Electron process group alone would orphan them; the tree is captured before any
 * signal so reparented processes are still reached.
 */
export async function killTree(root, { graceMs = 6_000 } = {}) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(root), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 已退出。
    }
    return;
  }
  const pids = processTree(root);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已退出。
    }
  }
  const deadline = Date.now() + graceMs;
  while (pids.some(alive) && Date.now() < deadline) await sleep(100);
  for (const pid of [...pids, ...processTree(root)]) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出。
    }
  }
}
