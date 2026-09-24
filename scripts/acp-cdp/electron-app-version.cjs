// Loaded with `electron -r` before the CodeZ main bundle (see lib/app.mjs).
//
// packages/desktop/package.json has no "version" (electron-builder injects it when packaging),
// so an unpackaged Electron reports "0.0" on Linux. packages/desktop/src/main/autoUpdater.ts
// destructures electron-updater's lazy `autoUpdater` getter at import time, which constructs an
// AppImageUpdater and throws ERR_UPDATER_INVALID_VERSION for a non-semver app version, so the main
// process dies before any window opens. This hook only sets the product version from the build
// metadata, the same value electron-builder writes into the packaged app.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { app } = require("electron");

let version = "0.0.0";
try {
  const meta = JSON.parse(
    readFileSync(join(__dirname, "../../packages/desktop/out/metadata/build-meta.json"), "utf8"),
  );
  if (typeof meta.appVersion === "string" && /^\d+\.\d+\.\d+/.test(meta.appVersion))
    version = meta.appVersion;
} catch {
  // 缺少构建元数据时仍给出合法 semver，避免 electron-updater 在导入期抛错。
}
app.setVersion(version);
