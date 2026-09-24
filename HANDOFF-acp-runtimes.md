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
4. **Subscription login for Claude Code and Codex** (in addition to BYOK). Each agent config has an
   auth mode: `byok` (task 3) or `subscription` (the user signs in to their own Claude / ChatGPT account;
   credentials live in the CLI's own store, CodeZ never sees or copies tokens).
   - Use the ACP auth flow: read `authMethods` from `initialize`, surface an auth-required state on the
     provider card (CodeZ already shows install/auth/handshake status), and call `authenticate` with the
     chosen method. Declare the terminal-auth client capability so the adapter can run the CLI's own
     login (Lody: `auth.terminal`; it uses `claude auth login` and `codex login --device-auth`).
   - Claude Code: `claude auth login` (Claude subscription). Codex: `codex login` (ChatGPT sign-in) and
     `codex login --device-auth` for headless/remote hosts; codex-acp exposes a `chatgpt` auth method.
   - Each subscription config gets its own managed `CLAUDE_CONFIG_DIR` / `CODEX_HOME` under the CodeZ data
     root, so login is per config and never touches the user's global CLI state. Verify where Claude Code
     keeps credentials on macOS when `CLAUDE_CONFIG_DIR` is set (Keychain entry naming) and document it.
     An explicit opt-in "use my existing CLI login" config may point at the user's global home instead.
   - Subscription mode must strip all BYOK routing/auth env vars (`ANTHROPIC_BASE_URL`,
     `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, …) so a stray key
     never overrides the subscription.
   - Logout / re-login / expired-token handling: detect auth errors from `session/prompt`, flip the card
     back to auth-required, never silently fall back to another runtime or to BYOK.
   - Tests: unit-test method selection, env stripping and state transitions with a fake ACP agent. A real
     subscription sign-in needs the owner's interactive login, so it is verified locally on the Mac, not
     in the cloud; write down the exact manual steps.
5. **Isolation.** BYOK configs get private `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / Pi config dir under the
   CodeZ data root; only an explicit "use my CLI login" config may share the user's global homes. Env
   allowlist, loopback in `NO_PROXY`.
6. **Offline replay harness + e2e tests** (`scripts/acp-replay/`):
   - A local proxy that speaks **Anthropic Messages (SSE)** and **OpenAI Responses (SSE)** and replays a
     fixture regardless of the prompt: one recorded model response per request, advancing on each
     request (a tool-result follow-up is a new request), paced by the fixture's `t_ms` with a speed
     factor, substituting `${WORKSPACE}`.
   - Fixtures: `fixtures/claude-code.json` (2 turns, 8 Bash/Read calls) and `fixtures/codex.json`
     (2 turns, 27 exec_command/write_stdin calls), sanitized from real sessions with
     `sanitize-sessions.mjs` (text masked by character class, commands replaced by read-only ones).
     They are pushed to this branch **after the owner reviews them** — `git pull` before task 6; until
     then build against the format produced by `sanitize-sessions.mjs`. Add a Pi fixture in the same format.
   - E2E: install the real CLIs + adapters into a temp dir, point them at the proxy (base URL + dummy
     key via the BYOK path above), drive them through CodeZ's ACP client, assert the V4 projection
     (text, tool call lifecycle, permission request, completion) and that approvals work in the default
     (non-bypass) permission mode.
   - Tests run with network egress blocked except loopback (e.g. `unshare -rn` / bwrap on Linux); the
     workspace is a throwaway git repo; nothing deletes or rewrites files outside it.
7. **Live BYOK smoke test via OpenRouter** (primary proof that the BYOK path works for real):
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
   The replay harness (task 6) stays for deterministic, offline CI; the live test is opt-in.
8. **Desktop end-to-end test driven over CDP.** Launch the real CodeZ Electron app with
   `--remote-debugging-port` (on Linux under `xvfb-run`) and drive it through the Chrome DevTools Protocol
   (Playwright `_electron` or a thin CDP client) with **real user actions only** — clicks and typing via
   `Input.dispatch*` / locators, never calling React internals or fiber props. For each runtime: pick it
   in the existing model picker, send a prompt, watch the streamed rows and tool-call cards, answer the
   permission prompt, wait for completion, and assert on the rendered DOM. Save screenshots and the CDP
   log as test artifacts.
   - Run it against the replay proxy (always) and against OpenRouter with the owner's key (task 7) for
     every runtime the environment can actually run. Live tests need egress to `openrouter.ai`; if the
     cloud environment's network policy blocks it, say so.
   - If a runtime (for example Claude Code) or Electron itself cannot run in the cloud environment, skip
     that case with an explicit reason in the test output and the PR description instead of faking it.
     The owner will run the same CDP suite locally on macOS.
9. **Quality gates:** target package tests, `pnpm typecheck`, `pnpm lint`,
   `pnpm architecture:check --changed`. Add an openspec change describing the work, following the
   existing archive format.

## Final task (after the PR): phone <-> desktop sync — research, then adapt if a good fit exists

Goal: Lody-like **bidirectional mobile + desktop sync** for coding-agent sessions — start a conversation
on the phone and the desktop sees it live and vice versa; both can send messages and approve permissions.

1. **Research (use a subagent).** Evaluate mature open-source options: slopus/happy, tiann/hapi,
   getpaseo/paseo, omnara-ai/omnara, siteboon/claudecodeui, iOfficeAI/AionUi, Lody's open parts,
   ACP-native remote options, and ZCode's own remote/mobile feature (codez mentions a
   `web-remote-replayable` projection and `remoteSessionId` — extending it may beat importing a new
   stack). For each: license (must be compatible with Apache-2.0), stars/activity/releases, supported
   agents, sync architecture (relay / CRDT / E2E, self-hostable server?), and how reusable the sync layer
   is for this Electron app. Write findings + recommendation to `docs/research/mobile-sync.md`.
2. **Adapt (only if a good fit exists).** If one option is mature, license-compatible, self-hostable and
   reusable as a library/protocol, integrate its sync logic in **separate new commits** on a follow-up
   branch (`feat/mobile-sync`, PR stacked on the ACP PR): bridge CodeZ's ACP session projection (V4 rows,
   permission requests, prompts) into that sync layer so both ends are first-class. Split the work across
   subagents where it parallelizes (e.g. protocol/adapter, session-state mapping, tests), with one
   integrating agent owning the final result. Backend/sync logic only; reuse whatever mobile client the
   chosen project already provides instead of building UI. Test with two clients against a local relay
   (both directions, including a permission approval). If nothing fits well, stop at the research doc and
   explain why.

## Hard rules

- Never read or write the real `~/.claude`, `~/.codex`, `~/.pi` or `~/.zcode` of any machine.
- No destructive commands against anything outside the throwaway workspace.
- No frontend work beyond wiring existing settings/model-picker data.

## Done when

- Claude Code, Codex and Pi can each be selected as a provider and complete a replayed multi-turn session
  with tool calls and a permission prompt through CodeZ's ACP backend (task 6).
- The BYOK path is proven with real OpenRouter requests for every runtime the cloud can run (task 7).
- The CDP suite drives the real desktop app through the same flows, with screenshots, or each skipped
  case states why (task 8).
- Claude Code and Codex support subscription login per config, with unit tests and documented manual
  steps for the owner's local sign-in check (task 4).
- All quality gates are green; a PR against `main` lists test results, skipped cases and OpenRouter cost.
