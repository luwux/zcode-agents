## 1. Runtime catalog and install

- [x] 1.1 Built-in definitions with pinned versions, lockfiles and adapter entries (claude-code, codex, pi).
- [x] 1.2 Managed installer (`npm ci --ignore-scripts`, Pi adapter built from pinned commit), atomic publish, locks.
- [x] 1.3 Launch via `process.execPath` + argv; launch resolver returns env; startup gate (2).

## 2. Configs, BYOK and isolation

- [x] 2.1 `agent-configs.json` registry + encrypted secrets; default configs; namespace exclusive with `agent_servers`.
- [x] 2.2 Env builder: allowlist, conflict stripping, BYOK injection, private homes, loopback NO_PROXY; presets.
- [x] 2.3 Service methods to save/delete configs and secrets; status fields in `listAgentRuntimes`.

## 3. Subscription auth

- [x] 3.1 Declare `auth.terminal`; auth state store; authRequired detection on new/load/prompt.
- [x] 3.2 Login (terminal method / `authenticate`) and logout; Codex device auth; manual steps doc.

## 4. Verification

- [x] 4.1 Unit tests with fake ACP agent (method selection, env stripping, state transitions, gate).
- [x] 4.2 Replay proxy (Anthropic Messages + OpenAI Responses SSE), Pi fixture, offline e2e through the coordinator.
- [x] 4.3 Live OpenRouter tasks in GitHub Actions (website, harness and internet research per runtime; 14/14 in run 17).
- [x] 4.4 CDP desktop e2e with real input (`scripts/acp-cdp`; replay: all runtimes pass locally and in CI, Pi has no permission prompt; live: CI job `desktop-cdp`).
- [x] 4.5 typecheck, lint, architecture check.

## 5. Settings UI (the earlier "no new UI" rule is lifted)

- [x] 5.1 Spec: D6 owners/event order, settings + declared-models requirements, `agent-runtime-selection` delta.
- [x] 5.2 Host: `listBuiltinRuntimeCatalog`, `onDynamicAgentRuntimeAuthChange`, zod request validation, `create`
      guard, env kept when omitted, workspace-free login cwd, delete skips logout without a private home,
      `enabled` flag, auth/catalog reset only on routing changes.
- [x] 5.3 Declared models: registry parsing, Claude stable model slots, Codex `model_catalog_json`, Pi
      `models.json` with reasoning on by default, picker entries derived from the config; configure.ts `--model` repeats.
- [x] 5.4 Renderer: built-in card with the custom-provider layout (header toggle/menu, sign-in method, preset,
      Base URL, API format, write-only key with clear, sign-in/device code/sign-out with links and codes, live auth
      state, model list with add/edit/delete/enable/reorder), "Built-in runtime" create segment, reset/delete,
      zh-CN + en-US.
- [x] 5.5 Tests: services unit tests, UI pure-logic tests, replay e2e for declared models + effort in requests,
      CDP replay cases add the model and type the key in Settings; the replay proxy treats structured-output
      requests (codex-acp title turn, which carries tools once the private catalog is used) as side requests.
- [x] 5.6 typecheck, lint, architecture check, oxfmt.
