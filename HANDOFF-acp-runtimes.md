# Handoff: built-in Claude Code / Codex / Pi runtimes over ACP (backend)

This repo is a private fork of [chent1024/codez](https://github.com/chent1024/codez), itself a fork of
[zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0). CodeZ already ships a generic ACP client
backend; this work adds first-class **Claude Code, Codex and Pi** runtimes with **BYOK / custom providers**,
modeled on [LodyAI/Lody](https://github.com/LodyAI/Lody). **Backend and processing logic only** — reuse
CodeZ's existing provider list and model picker; do not build new UI.

## What already exists (read first)

- `openspec/changes/archive/2026-09-23-add-acp-agent-runtimes/design.md` — the architecture: ACP is a
  provider type; Host routes `providerId` to the ZCode CLI or an ACP session adapter; task index binds
  provider/model/adapter/native session id; `session/update` is projected into the V4 row contract.
- `packages/services/src/agent-runtime/` — `acpConnection.ts`, `acpRuntimeCoordinator.ts`,
  `acpV4Bridge.ts`, `acpConversationProjection.ts`, `acpRuntimeCatalog.ts` (built-ins: qoder, cline,
  codebuddy, workbuddy), `agentServersRegistry.ts` (custom agents from `~/.codez/v2/agent-servers.json`),
  `acpHostCapabilities.ts` (fs/terminal), `acpProviderModels.ts`, `acpSessionCreation.ts`.
- Per-session git worktrees: `packages/services/src/git/repo/managedWorktrees.ts`.
- CodeZ is based on upstream's `feat: open source` commit and does **not** yet include upstream `v3.14.3`
  (`git remote zcode` → zai-org/ZCode).

## Tasks

1. **Sync upstream.** Merge `zcode/main` (v3.14.3) into `main`; resolve conflicts; keep CodeZ's ACP work.
2. **Built-in runtimes** in `acpRuntimeCatalog.ts`, pinned versions, launched with `process.execPath`
   (argv, never a shell), binaries/adapters installed into the CodeZ data dir (not global):
   - Claude Code: `@agentclientprotocol/claude-agent-acp` (0.81.x) with `CLAUDE_CODE_EXECUTABLE` → managed
     `claude` binary.
   - Codex: `@agentclientprotocol/codex-acp` (1.13.x) with `CODEX_PATH` → managed `codex` binary (the
     adapter drives `codex app-server`).
   - Pi: Pi has no native ACP. Use `LodyAI/acp-extension-pi` (Apache-2.0, wraps `pi --mode rpc`) or
     `pi-acp`; pin `@earendil-works/pi-coding-agent` 0.87.x. Prior art for a direct RPC integration:
     [Raingor/pi-ZCode](https://github.com/Raingor/pi-ZCode) `packages/services/src/pi-agent/`.
   - Serialize spawn+initialize+session/new with a small concurrency gate (Lody uses 2; Codex races on
     its home dir otherwise).
3. **BYOK / custom providers (Lody-style).** An agent config = `{runtime, env, defaultModel}`.
   - Claude: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`,
     `API_TIMEOUT_MS`; presets for Anthropic-compatible gateways (GLM, DeepSeek, …). When a config sets
     any auth/routing var, strip every inherited `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` from the host and
     login-shell env (Lody: `apps/cli/src/agent/claude-env-conflict.ts`, `session/session.ts`).
   - Codex: inject a custom `model_providers` entry per session via `CODEX_CONFIG` JSON / `-c` overrides
     or the adapter's gateway auth + `providers/set`; never edit the user's `config.toml`.
   - Pi: `--provider` / `--model` + provider env.
   - Model / effort / mode switching goes through `session/set_config_option` (already in CodeZ).
   - Secrets: encrypted at rest (reuse ZCode's provider key storage or Electron `safeStorage`), injected
     only into the child env at spawn, never logged, never in cache keys or diagnostics.
4. **Isolation.** BYOK configs get private `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / Pi config dir under the
   CodeZ data root; only an explicit "use my CLI login" config may share the user's global homes. Env
   allowlist, loopback in `NO_PROXY`.
5. **Offline replay harness + e2e tests** (`scripts/acp-replay/`):
   - A local proxy that speaks **Anthropic Messages (SSE)** and **OpenAI Responses (SSE)** and replays a
     fixture regardless of the prompt: one recorded model response per request, advancing on each
     request (a tool-result follow-up is a new request), paced by the fixture's `t_ms` with a speed
     factor, substituting `${WORKSPACE}`.
   - Fixtures: `fixtures/claude-code.json` (2 turns, 8 Bash/Read calls) and `fixtures/codex.json`
     (2 turns, 27 exec_command/write_stdin calls), sanitized from real sessions with
     `sanitize-sessions.mjs` (text masked by character class, commands replaced by read-only ones).
     They are pushed to this branch **after the owner reviews them** — `git pull` before task 5; until
     then build against the format produced by `sanitize-sessions.mjs`. Add a Pi fixture in the same format.
   - E2E: install the real CLIs + adapters into a temp dir, point them at the proxy (base URL + dummy
     key via the BYOK path above), drive them through CodeZ's ACP client, assert the V4 projection
     (text, tool call lifecycle, permission request, completion) and that approvals work in the default
     (non-bypass) permission mode.
   - Tests run with network egress blocked except loopback (e.g. `unshare -rn` / bwrap on Linux); the
     workspace is a throwaway git repo; nothing deletes or rewrites files outside it.
6. **Live BYOK smoke test via OpenRouter** (primary proof that the BYOK path works for real):
   model `xiaomi/mimo-v2.6-flash` (tool calling supported; ~$0.14 / $0.28 per M tokens), key from the
   `OPENROUTER_API_KEY` environment variable of the cloud environment — never commit, print or log it;
   skip the live tests cleanly when the variable is absent.
   - Claude Code: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`,
     `ANTHROPIC_API_KEY=""`, all `ANTHROPIC_DEFAULT_*_MODEL=xiaomi/mimo-v2.6-flash`.
   - Codex: custom `model_providers.openrouter` (`base_url = "https://openrouter.ai/api/v1"`,
     `env_key = "OPENROUTER_API_KEY"`; check whether OpenRouter's Responses endpoint works with Codex,
     else `wire_api = "chat"` if the pinned Codex still supports it) and `model = "xiaomi/mimo-v2.6-flash"`.
   - Pi: built-in `openrouter` provider, `--model xiaomi/mimo-v2.6-flash`.
   - Each runtime completes one small task in a throwaway workspace (read a file, run a harmless command,
     answer) through CodeZ's ACP backend. Keep token usage minimal; record the cost in the PR description.
   The replay harness (task 5) stays for deterministic, offline CI; the live test is opt-in.
7. **Quality gates:** target package tests, `pnpm typecheck`, `pnpm lint`,
   `pnpm architecture:check --changed`. Add an openspec change describing the work, following the
   existing archive format.

## Hard rules

- Never read or write the real `~/.claude`, `~/.codex`, `~/.pi` or `~/.zcode` of any machine.
- No destructive commands against anything outside the throwaway workspace.
- No frontend work beyond wiring existing settings/model-picker data.

## Done when

Each of Claude Code, Codex and Pi can be selected as a provider, uses a BYOK config pointed at the
replay proxy, and completes a replayed multi-turn session with tool calls and a permission prompt,
end to end through CodeZ's ACP backend, with all quality gates green. Final GUI verification of the
macOS desktop app happens locally afterwards.
