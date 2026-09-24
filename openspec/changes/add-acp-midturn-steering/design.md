## Owners

- `AcpRuntimeCoordinator` is the ACP CommandInbox: it admits every input (idempotent by `commandId`),
  decides startNow vs steer, and owns deferred config changes. The Renderer keeps only drafts.
- `AcpConnection` owns the wire calls (`set_config_option`, `set_mode`, steering ext methods).
- `AcpConversationProjection` owns rows; a steered input is a `userInput` row in the active turn.

## Event order

```mermaid
sequenceDiagram
  participant UI as Composer
  participant B as AcpV4Bridge
  participant C as Coordinator (CommandInbox)
  participant K as AcpConnection
  participant A as ACP agent
  Note over C: turn T running
  UI->>B: switchModelConfig(thought=high)
  B->>C: setThinkingLevel
  C->>K: session/set_config_option
  alt agent accepts
    K-->>C: configOptions (high selected)
  else agent refuses mid-turn
    C->>C: deferred = {thought: high}
  end
  UI->>B: sendText(cmd2, "use the other file")
  B->>C: sendPrompt
  C->>C: transcript.appendPrompt(cmd2, steer=true)
  C->>K: _session/steering / _lody/session/steer
  alt injected
    C->>C: projection.appendGuide(cmd2) in T
  else promptRequired / refused
    C->>C: wait for T to settle, then startNow(cmd2)
  end
  A-->>K: session/prompt result (T)
  C->>C: finishTurn(T); apply deferred config
```

Idempotency: a repeated `commandId` returns `duplicate` whether it was steered or started. Restore
replays a steered prompt as a `userInput` row inside the turn that was running, not as a new turn.
