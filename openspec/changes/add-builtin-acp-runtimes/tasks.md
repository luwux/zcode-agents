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
- [ ] 4.3 Live OpenRouter smoke test in GitHub Actions.
- [ ] 4.4 CDP desktop e2e with real input.
- [x] 4.5 typecheck, lint, architecture check.
