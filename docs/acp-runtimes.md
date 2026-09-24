# Built-in ACP runtimes: Claude Code, Codex, Pi

CodeZ ships three built-in ACP runtimes next to user-registered `agent_servers`. They appear in the
existing model-provider list and model picker; there is no new UI. Design and requirements:
`openspec/changes/add-builtin-acp-runtimes/`.

| Runtime       | Adapter (pinned)                                                     | Native CLI                                                                                               | Auth modes                    |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `claude-code` | `@agentclientprotocol/claude-agent-acp` 0.81.2                       | `claude` 2.1.280 bundled by `@anthropic-ai/claude-agent-sdk` 0.3.280, passed as `CLAUDE_CODE_EXECUTABLE` | subscription, byok, cli-login |
| `codex`       | `@agentclientprotocol/codex-acp` 1.13.1                              | `@openai/codex` 0.156.1 native binary, passed as `CODEX_PATH`                                            | subscription, byok, cli-login |
| `pi`          | `LodyAI/acp-extension-pi` @ `350df43` (built from source at install) | `@earendil-works/pi-coding-agent` 0.87.0 (`pi --mode rpc`)                                               | byok, cli-login               |

Pi is not supported on Windows: acp-extension-pi needs a CI-prebuilt Windows job module that a source
install cannot provide, so the provider card reports that reason.

## Where things live

- Installs: `~/.codez/acp-runtimes/<runtime>/<version>/`, created on first use with
  `npm ci --ignore-scripts` from the lockfiles in `packages/services/src/agent-runtime/builtin/manifests/`
  (Pi also needs `git`). Requires `npm` on PATH.
- Configs (no secrets): `~/.codez/v2/agent-configs.json`. API keys: the encrypted credential store
  `~/.codez/v2/credentials.json`, key `acp-agent-config/<id>/apiKey`.
- Private native homes per config: `~/.codez/acp-homes/<id>/{claude,codex,pi}` as `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `PI_CODING_AGENT_DIR`. `~/.claude`, `~/.codex`, `~/.pi` are only used by a config whose
  auth mode is `cli-login` (explicit opt-in).

## Configure (helper scripts, run from `packages/services`)

```sh
cd packages/services
# List configs, install state, auth state:
node --import tsx ../../scripts/acp-runtimes/configure.ts --list

# BYOK via OpenRouter; the key is read from stdin (not argv, not shell history):
read -rs KEY; printf %s "$KEY" | node --import tsx ../../scripts/acp-runtimes/configure.ts \
  claude-openrouter --runtime claude-code --auth byok --preset openrouter \
  --model xiaomi/mimo-v2.6-flash --key-stdin; unset KEY
```

Presets: Claude `anthropic|openrouter|glm|zai|deepseek|kimi|custom`; Codex `openai|openrouter|custom`;
Pi `openrouter|anthropic|openai|zai|deepseek|custom`. `custom` takes `--base-url` (and for Pi `--api`).

## Subscription sign-in on macOS (manual check for the owner)

Quit CodeZ first so the app and the script do not race on the same private home.

### Claude Code (Claude subscription)

```sh
cd packages/services
node --import tsx ../../scripts/acp-runtimes/login.ts claude-code            # opens the browser
node --import tsx ../../scripts/acp-runtimes/login.ts claude-code --status   # expect: logged in
```

The script runs the adapter's advertised ACP terminal auth method (`claude-ai-login` →
`claude auth login --claudeai`) with the config's private `CLAUDE_CONFIG_DIR`. Verify the credential
went to a per-config Keychain entry, not the global one:

```sh
DIR="$HOME/.codez/acp-homes/claude-code/claude"
SUFFIX=$(printf %s "$DIR" | shasum -a 256 | cut -c1-8)
security find-generic-password -s "Claude Code-credentials-$SUFFIX" -a "$USER" >/dev/null && echo "per-config entry OK"
security find-generic-password -s "Claude Code-credentials" -a "$USER" >/dev/null && echo "global entry exists (untouched by CodeZ)"
```

The service name `Claude Code-credentials-<first 8 hex of sha256(NFC(CLAUDE_CONFIG_DIR))>` was read from
the 2.1.280 binary (`q0e()` in its secure-storage module); if `DIR` contains non-ASCII characters,
normalize it to NFC before hashing.

### Codex (ChatGPT sign-in)

```sh
node --import tsx ../../scripts/acp-runtimes/login.ts codex                 # ACP authenticate(chat-gpt), opens the browser
node --import tsx ../../scripts/acp-runtimes/login.ts codex --device-auth   # headless: codex login --device-auth
node --import tsx ../../scripts/acp-runtimes/login.ts codex --status        # expect: Logged in using ChatGPT
ls ~/.codez/acp-homes/codex/codex/auth.json && ! ls ~/.codex/auth.json 2>/dev/null  # stored only in the private home
```

### Then in the app

Open CodeZ → Settings → model providers: `Claude Code` / `Codex` should no longer show "Sign-in required".
Pick the provider in the composer model picker and send a prompt. To check expiry handling, run
`login.ts <id> --logout`, send another prompt: the turn ends with "Sign-in required" and the card flips
back; nothing falls back to BYOK or another runtime.

## Steering and mid-turn settings

While a turn runs, the composer routes a new message as a guide (same as ZCode's own agent). Claude Code
and Codex receive it through `_session/steering`, Pi through `_lody/session/steer`; an accepted message
shows as an input row in the running turn. If the agent declines (no turn left to steer), the message is
queued and starts right after the turn. Model, thinking-effort and mode changes are sent immediately;
if the agent refuses them mid-turn they are applied as soon as the turn ends. Custom ACP servers without
a steering method keep the old behavior (the composer blocks sending while a turn runs).

## Security notes and known limits

- **BYOK keys are visible to commands the agent runs.** The key is injected into the agent's
  environment; Claude's Bash and Pi's bash inherit it, so a prompt-injected `env` could read it. Codex
  excludes `*KEY*` variables from its shell by default. Claude can scrub credentials from subprocesses with
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (set it in the config's `env`); on Linux this needs `bubblewrap`,
  otherwise Claude refuses to start, so it is not on by default.
- **Remote hosts / SSH:** when the Host environment has `SSH_CONNECTION`, `SSH_TTY` or `NO_BROWSER`,
  claude-agent-acp only offers its terminal-UI login. The app then reports that sign-in needs an
  interactive terminal; run `scripts/acp-runtimes/login.ts <id>` in a terminal on that host.
- **Deleting a config** signs out subscription configs (removing the per-config Keychain entry on macOS),
  deletes its API key and removes `~/.codez/acp-homes/<id>`, so a re-created config never inherits a login.
- **Proxies:** when `HTTP(S)_PROXY` is set, Node-based adapters get `NODE_USE_ENV_PROXY=1`; the native
  `claude` and `codex` binaries read the proxy variables themselves.
- **Electron:** Claude and Codex adapters are started through a tiny `-e` bootstrap that removes
  `ELECTRON_RUN_AS_NODE` before loading the adapter, so commands the agent runs (`electron .`, `code`)
  behave normally. Pi still needs the variable to start `pi`, so commands run by Pi inherit it.
- **Codex Guardian + OpenRouter/MiMo:** in live runs OpenRouter answered Codex's Guardian review requests
  with HTTP 403 "prohibited due to a violation of provider Terms Of Service", so escalations in the default
  "agent" mode are not approved with that model; use "read-only" (ask) or "agent-full-access".
- **Codex with non-OpenAI models:** Codex prints "Model metadata for `<model>` not found. Defaulting to
  fallback metadata" and some models (MiMo v2.6 Flash in live runs) occasionally end a turn with reasoning
  only, without a final message.
- **Codex modes:** the default "agent" mode sends approvals to Codex's Guardian reviewer model (billed like
  any request); "read-only" ("Ask for approval") asks the user; "agent-full-access" never asks.

## Tests

| Suite                                                                                           | Command                                                                                             | Network                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Unit (fake ACP agent, env, registry, auth, gate)                                                | `cd packages/services && node --import tsx --test test/*.test.ts`                                   | none                                                |
| Replay proxy                                                                                    | `node --test scripts/acp-replay/replay-core.test.mjs`                                               | none                                                |
| Offline replay e2e (real CLIs)                                                                  | `node scripts/acp-replay/run-replay-e2e.mjs --artifacts /tmp/replay`                                | install step only; tests run loopback-only on Linux |
| Live OpenRouter (website, harness and internet research; random 1-in-5 rejections in ask modes) | `cd packages/services && OPENROUTER_API_KEY=… node --import tsx --test test/e2e/live/*.live.e2e.ts` | openrouter.ai, github.com                           |
| Desktop CDP                                                                                     | see `scripts/acp-cdp/README.md`                                                                     | replay: none; live: openrouter.ai                   |

CI: `.github/workflows/acp-runtimes.yml` (the live job uses the `OPENROUTER_API_KEY` repository secret and
writes the run cost to the job summary).
