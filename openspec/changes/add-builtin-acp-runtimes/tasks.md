## 1. Runtime catalog and install

- [ ] 1.1 Built-in definitions with pinned versions, lockfiles and adapter entries (claude-code, codex, pi).
- [ ] 1.2 Managed installer (`npm ci --ignore-scripts`, Pi adapter built from pinned commit), atomic publish, locks.
- [ ] 1.3 Launch via `process.execPath` + argv; launch resolver returns env; startup gate (2).

## 2. Configs, BYOK and isolation

- [ ] 2.1 `agent-configs.json` registry + encrypted secrets; default configs; namespace exclusive with `agent_servers`.
- [ ] 2.2 Env builder: allowlist, conflict stripping, BYOK injection, private homes, loopback NO_PROXY; presets.
- [ ] 2.3 Service methods to save/delete configs and secrets; status fields in `listAgentRuntimes`.

## 3. Subscription auth

- [ ] 3.1 Declare `auth.terminal`; auth state store; authRequired detection on new/load/prompt.
- [ ] 3.2 Login (terminal method / `authenticate`) and logout; Codex device auth; manual steps doc.

## 4. Verification

- [ ] 4.1 Unit tests with fake ACP agent (method selection, env stripping, state transitions, gate).
- [ ] 4.2 Replay proxy (Anthropic Messages + OpenAI Responses SSE), Pi fixture, offline e2e through the coordinator.
- [ ] 4.3 Live OpenRouter smoke test in GitHub Actions.
- [ ] 4.4 CDP desktop e2e with real input.
- [ ] 4.5 typecheck, lint, architecture check.
