## Why

ZCode lets users change the thinking effort or model mid-conversation and steer a running turn: the
composer selection travels with the next submission and takes effect at the next model step
(`SessionPane.tsx` "Guide 为下一次 model-step"). ACP sessions reject both while running
(`acpV4Bridge.ts` `acpTurnRunning`, `AcpConnection.setThinkingLevel` "cannot change during a prompt",
`AcpRuntimeCoordinator.sendPrompt` "ACP session is busy"), so ACP providers behave worse than the
built-in runtime. Claude (`claude-agent-acp`), Codex (`codex-acp`) and Pi (`acp-extension-pi`) all
support steering.

## What Changes

- `switchModelConfig` (model, thought level, ACP mode) is accepted while a turn is running. The Host
  forwards `session/set_config_option` / `session/set_mode` immediately; the agent applies it at its
  next model request. If the agent refuses a change mid-turn, the Host keeps the requested value as a
  deferred change and applies it when the turn settles (last writer wins).
- `sendText` while running is delivered as a steer when the agent advertises steering:
  - `_session/steering {sessionId, prompt, _meta.steering.idleBehavior:"promptRequired"}` for agents that
    advertise top-level `InitializeResponse._meta.steering.supported` (Claude, Codex);
  - `_lody/session/steer {sessionId, steerId, prompt}` for agents that advertise
    `agentCapabilities._meta.lody.steering` (Pi).
    The accepted input appears as a `userInput` row inside the running turn. `promptRequired` (the turn
    settled in between) or a refusal starts the input as the next normal turn once the current one settles.
- The ACP projection publishes `inputRouting.mode = "guide"` and `actions.switchModelConfig.allowed`
  while running when the agent supports steering; agents without steering keep `reject`.

## Impact

`packages/services/src/agent-runtime/` (connection, coordinator, projection snapshot, bridge, transcript
restore of steered prompts). No UI change: the composer already dispatches `switchModelConfig` then
`sendText` and follows `snapshot.inputRouting`.
