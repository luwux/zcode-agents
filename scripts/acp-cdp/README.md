# Desktop CDP e2e for the built-in ACP runtimes

`run-cdp-e2e.mjs` launches the **real CodeZ desktop app** (production bundles in
`packages/desktop/out`, loaded by the repo's Electron without the Vite dev server) with
`--remote-debugging-port`, attaches Playwright (`playwright-core` from `packages/desktop`) over the
Chrome DevTools Protocol, and drives Claude Code, Codex and Pi through the UI with **real input only**:
locator clicks, mouse hover and keyboard typing (`Input.dispatch*`). The runner never touches React
internals, fiber props, `window.zcode` or app events; `page.evaluate` is only used to _read_ the DOM
for assertions.

## What one case does

Every case starts a fresh app with a throwaway `HOME`, `ZCODE_DATA_BASE_DIR`, Electron `userData` and a
throwaway git workspace. Nothing touches your real `~/.claude`, `~/.codex`, `~/.pi`, `~/.zcode` or
`~/.codez`.

1. **prepare** – create the workspace (`git init` + one commit), start
   `scripts/acp-replay/replay-proxy.mjs` for the case's fixture (replay mode), and seed
   `<data>/.codez/v2/agent-configs.json` with the app's own modules (`saveAgentConfig`; see
   `seed-agent-configs.ts`). Replay cases seed only the provider route (no model, no key): the model and
   the key are entered in Settings in step 4. Live cases also seed the model and the key
   (`saveBuiltinConfigApiKey`), passed over stdin only, so the real key is never typed into the app and
   never appears in a trace; it lands only in the encrypted credential store of the throwaway data dir.
2. **launch-app** – start Electron as
   `electron -r electron-app-version.cjs --remote-debugging-port=<port> packages/desktop --open-workspace=<ws>`
   (under `xvfb-run -a` on Linux without `DISPLAY`) and connect with `chromium.connectOverCDP`. The
   workspace is opened with the app's own `--open-workspace` command-line switch, so no native folder
   dialog is involved.
3. **dismiss-onboarding** – click _Use API key_ → _Skip for now_ → _Exit onboarding_.
4. **settings-configure-and-enable-model** – composer model picker → _Manage models_ → Settings › Model
   settings › ACP › the seeded config (the built-in runtime card). Replay cases then click _Add model_,
   type the fixture's model ID and _Save_, check the card reports "API key is not configured", click the
   API key field, type the (dummy) key and press Enter, and wait until the card flips: the missing-key
   status disappears and the field is empty again with a "Saved" placeholder (the key is write-only).
   The declared model's switch must be on; configs without declared models use _Sync models_ and switch
   the wanted advertised model on. → _Back to workspace_. Screenshots:
   `settings-add-model-dialog`, `settings-api-key-saved`.
5. **pick-runtime-in-model-picker** – open the existing composer model picker, hover the runtime's ACP
   group, click its model.
6. **pick-acp-session-mode** (permission cases) – _ACP session mode_ → `Manual` (Claude Code) or
   `Ask for approval` (Codex `read-only`). Never a bypass mode.
7. **turn-N-type-and-send / turn-N-stream-and-complete** – type the prompt (replay prompts are neutral
   text: the proxy answers from the fixture regardless of the prompt), click send, poll the DOM
   (read-only) until the turn settles; records every new row with its timestamp and whether the turn was
   still running (streaming evidence), tool-call cards, and answers permission dialogs by clicking the
   _allow once_ option and then _Confirm_.
8. **assert-rendered-dom** – expand each "Worked for …" history with a click, then assert: prompts
   rendered, assistant rows rendered (and at least one while running), no timeline alerts, every
   tool-call card settled, every recorded assistant text rendered, every tool card maps to a recorded
   tool call, the proxy served exactly the fixture's turns and was never exhausted, and for permission
   cases that the dialog was answered and `replay-permission-marker.txt` exists in the workspace.

Pi has no permission step: its ACP adapter (`acp-extension-pi`) never sends
`session/request_permission`, so `pi--permission` is always reported as **SKIPPED** with that reason.

## Commands

```bash
# replay (default): builds, installs the pinned runtimes into the cache (needs npm/git + network the
# first time), then runs every case offline against the replay proxy
node scripts/acp-cdp/run-cdp-e2e.mjs --artifacts /tmp/codez-cdp-artifacts

# live: OpenRouter xiaomi/mimo-v2.6-flash, key from OPENROUTER_API_KEY (see "Live" below)
node scripts/acp-cdp/run-cdp-e2e.mjs --mode live --artifacts /tmp/codez-cdp-live
```

| Option                        | Meaning                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode replay\|live`         | Default `replay`.                                                                                                                                                                  |
| `--runtime claude-code,codex` | Subset of `claude-code,codex,pi` (default all).                                                                                                                                    |
| `--case permission`           | Only cases whose id contains the substring.                                                                                                                                        |
| `--artifacts DIR`             | Screenshots, logs and summaries (default `$TMPDIR/codez-acp-cdp-<mode>-<time>`).                                                                                                   |
| `--runtimes-cache DIR`        | `CODEZ_ACP_RUNTIMES_DIR` for the app (default `$CODEZ_ACP_RUNTIMES_DIR` or `$TMPDIR/codez-acp-runtimes-cache`, shared with `scripts/acp-replay`).                                  |
| `--no-build`                  | Reuse `packages/desktop/out` + `bundled-agents` (fails if missing).                                                                                                                |
| `--no-install`                | Do not install runtimes; missing ones are reported as SKIPPED.                                                                                                                     |
| `--no-isolate`                | Linux replay: do not enter the loopback-only network namespace.                                                                                                                    |
| `--keep`                      | Keep the throwaway roots (paths are written into each `result.json`).                                                                                                              |
| `--speed N`                   | Replay speed divisor for recorded gaps (default 5; the proxy caps each gap at 1.5 s). Much faster replays can finish a whole turn between two DOM polls.                           |
| `--turn-timeout-ms N`         | Per-turn timeout (default 180000 replay / 300000 live).                                                                                                                            |
| `--seed-model-catalog codex`  | **Diagnostic workaround**, off by default: skips step 4 for the listed runtimes (see Findings). Such cases are reported as "passed only with the --seed-model-catalog workaround". |

The build step runs `node scripts/build-desktop-agent-cli.mjs` (the bundled agent is required: without
it the app stops at "Startup preparation failed") and
`pnpm --filter @zcode/desktop build:no-runtime-assets` (tsup main/preload/host + `vite build`
renderer). If `node_modules/electron/dist` is missing (pnpm skipped Electron's postinstall), it runs
`node node_modules/electron/install.js` first.

Exit code: `1` if any case **FAILED** (or, in live mode, if the key is found in any artifact), else `0`.
Every case ends as `PASSED`, `FAILED`, `SKIPPED` (with a reason) or `INCONCLUSIVE` (live model did not do
the thing the step needs, e.g. never called a tool; reason given).

### Artifacts

```
<artifacts>/summary.txt | summary.json         one line per case with status + reason
<artifacts>/build/*.log                         build and runtime install logs
<artifacts>/<case>/NN-<step>.png                screenshot after every step and at key moments
                                                 (typed, streaming assistant, tool card, permission, complete)
<artifacts>/<case>/trace.zip                    Playwright trace (actions, DOM snapshots, screenshots); open it
                                                 at https://trace.playwright.dev (loaded locally in the browser)
<artifacts>/<case>/cdp-events.jsonl             CDP console/exception/navigation events + every runner action
<artifacts>/<case>/app.log                      Electron main/host stdout+stderr
<artifacts>/<case>/proxy.jsonl                  replay proxy requests (replay mode)
<artifacts>/<case>/result.json                  steps, assertions, per-turn observations
<artifacts>/secret-scan.json                    live mode: proof the key is in no artifact (zip entries included)
```

## Running locally on macOS

Prerequisites: Xcode command line tools (for `git`), [mise](https://mise.jdx.dev) or Node 24.14 +
pnpm 10.33 as pinned in `mise.toml`, `npm` on `PATH` (runtime installs), and network for the first
build/install. No `xvfb` is needed; the app window opens on your desktop — do not type into it while the
suite runs.

### Replay (offline model, deterministic)

```bash
cd <repo>
mise install                       # Node 24.14.0 + pnpm 10.33.2 from mise.toml
mise exec -- pnpm install --frozen-lockfile
# First run: builds and installs the pinned Claude Code / Codex / Pi runtimes into the cache.
mise exec -- node scripts/acp-cdp/run-cdp-e2e.mjs --artifacts ~/Desktop/codez-cdp-replay
# Later runs, same sources: reuse the build and the runtime cache.
mise exec -- node scripts/acp-cdp/run-cdp-e2e.mjs --no-build --no-install --artifacts ~/Desktop/codez-cdp-replay-2
open ~/Desktop/codez-cdp-replay    # screenshots, summary.txt, traces
```

Selectors use the English UI strings and the `acp-builtin-*` test ids of the built-in runtime card. The runner forces English with `LANG=en_US.UTF-8` / `--lang=en-US` and, on macOS,
with the process-local `-AppleLanguages (en-US)` override, so a Chinese system language does not change
the app's language. If a case still fails at `dismiss-onboarding`, check its screenshot for the UI
language.

On macOS there is no network namespace: the replayed CLIs only talk to the local proxy because their
configs point there, and the runner sets a dead `HTTP(S)_PROXY` for the app as a best-effort egress
block (clients that ignore proxy variables, e.g. the app's own update/config checks, may still reach
the network). The app is launched with `--use-mock-keychain`, so no "Safe Storage" item is added to your
login keychain.

### Live (OpenRouter, costs a few cents)

Keep the key out of shell history and files. Either store it once in the login keychain (the
`-w` flag without a value makes `security` prompt for it, so it is never typed on a command line):

```bash
security add-generic-password -a "$USER" -s codez-openrouter -w
OPENROUTER_API_KEY="$(security find-generic-password -a "$USER" -s codez-openrouter -w)" \
  mise exec -- node scripts/acp-cdp/run-cdp-e2e.mjs --mode live --artifacts ~/Desktop/codez-cdp-live
```

or read it silently for one shell session (zsh):

```zsh
read -rs "OPENROUTER_API_KEY?OpenRouter API key: " && export OPENROUTER_API_KEY; echo
mise exec -- node scripts/acp-cdp/run-cdp-e2e.mjs --mode live --artifacts ~/Desktop/codez-cdp-live
unset OPENROUTER_API_KEY
```

The runner reads `OPENROUTER_API_KEY`, removes it from its own environment before spawning anything,
passes it to `seed-agent-configs.ts` over stdin, and redacts it from every log it writes; the app never
receives it as an environment variable (the Host decrypts it from the throwaway credential store and
injects it only into the runtime process). After the run it scans every artifact, including the entries
of each `trace.zip`, and fails if the key appears anywhere (`secret-scan.json`). Throwaway roots are
deleted unless `--keep` is given; do not use `--keep` in live mode unless you delete them afterwards.

Live cases: `<runtime>--live-turn` (asks the model to run `ls` with its shell tool and answer; answers
any permission prompt with _allow once_) and `<runtime>--live-permission` (Claude Code `Manual`: asks for
`touch live-permission-marker.txt`; Codex `Ask for approval`: asks for a `curl` to openrouter.ai followed
by the `touch`, because that mode's workspace-write sandbox only asks for network access or files outside
the workspace; both expect the dialog, click allow and check the file). Real models can decline to call tools; such cases end as `INCONCLUSIVE` with the
reason, a write without a prompt ends as `FAILED`.

## Findings from running the suite (Linux, replay)

1. **Unpackaged Linux launch crashes before any window (worked around by `electron-app-version.cjs`).**
   `packages/desktop/src/main/autoUpdater.ts:23` destructures `electron-updater`'s lazy `autoUpdater`
   getter at import time. On Linux that constructs an `AppImageUpdater`, whose constructor throws
   `ERR_UPDATER_INVALID_VERSION` because `packages/desktop/package.json` has no `version` and an
   unpackaged Electron reports `"0.0"`. The main process dies with "App threw an error during load"
   (macOS reports the Electron bundle version, so it is unaffected). The hook only calls
   `app.setVersion(<out/metadata/build-meta.json appVersion>)`, the value electron-builder writes into
   packaged apps.
2. **Fixed: Codex could not be enabled from Settings with a custom provider.** _同步 Agent 模型_ calls
   `discoverAgentRuntimeConfig({ includeAllModelThoughtLevels: true })`, which probes every model's thought
   levels. codex-acp lists the configured non-preset model (`gpt-5.4` in the replay config, the OpenRouter
   model in live mode) only while it is current, so switching back after probing a preset threw
   `ACP model is unavailable` and no catalog was saved. `acpConfigDiscovery.ts` now keeps the initial
   model's levels from the first snapshot and tolerates per-model switch failures
   (`packages/services/test/acpModelDiscovery.test.ts`). Both Codex cases pass without
   `--seed-model-catalog`, which remains only as a diagnostic option.
3. **Fixed:** the composer's agent-default placeholder (`__agent_default__`, saved for runtimes that
   advertise no models) was forwarded to `AcpConnection.setModel()` and failed the second prompt with
   `Invalid ACP model selection`; the coordinator now treats it as "keep the agent's model", like session
   creation does.
4. **Fixed:** Settings › ACP detail showed `…/agent-servers.json` as the config file for built-in configs;
   it now prefers the status's own path (`…/agent-configs.json`).
5. `pnpm typecheck` clobbers the host bundle: `tsc -b` builds `packages/desktop/tsconfig.host.json`,
   whose `outDir` is `out/host`, so it writes unbundled JS and `.d.ts` over the tsup output. On the
   next app start the Host process exits with `ERR_MODULE_NOT_FOUND` for
   `packages/services/src/session/tasksDatabase/startup.js` (see `app.log`) and the composer never
   appears. The runner refuses `--no-build` when it finds `out/host/index.d.ts`; rebuild (run without
   `--no-build`) after a typecheck.
6. Observed but not investigated: after a completed ACP session the sidebar still shows "No tasks yet"
   under the workspace.
7. **Fixed in the replay proxy:** built-in Codex configs now write a private model catalog with only the
   declared models. codex-acp's session title turn (hard-coded `gpt-5.6-luna`, not in that catalog) then
   carries Codex's normal tool list, so the proxy took it for the next main turn and both Codex cases
   failed with "runtime never ran past the fixture". The title turn always sets a JSON-schema output
   format; `isMainResponsesRequest` (`scripts/acp-replay/replay-core.mjs`) treats such requests as side
   requests.

## Unit tests for the runner's helpers

```bash
node --test scripts/acp-cdp/lib/helpers.test.mjs
```
