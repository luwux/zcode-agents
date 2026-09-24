import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const desktopDir = join(repoRoot, "packages", "desktop");
export const servicesDir = join(repoRoot, "packages", "services");
export const replayDir = join(repoRoot, "scripts", "acp-replay");
export const cdpDir = join(repoRoot, "scripts", "acp-cdp");

/** Replace every secret occurrence; secrets shorter than 8 chars are ignored (dummy keys). */
export function redact(text, secrets = []) {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8)
      result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function log(message) {
  process.stdout.write(`[acp-cdp] ${message}\n`);
}
