## 1. Coordinator (CommandInbox)

- [x] 1.1 Detect steering support at initialize: `_session/steering` (Claude, Codex) and `_lody/session/steer` (Pi).
- [x] 1.2 A running turn accepts `sendPrompt` as a steer when supported; otherwise it rejects as busy.
- [x] 1.3 A steer that falls back (`promptRequired` or refused) is queued and starts after the turn settles; the turn waits for steers in flight before finishing.
- [x] 1.4 Model / thinking-effort / mode changes that the agent refuses mid-turn are deferred and applied after the turn.

## 2. Projection and transcript

- [x] 2.1 Snapshot `inputRouting` is `guide` while running on steering agents; `switchModelConfig` stays available.
- [x] 2.2 An injected steer is a `userInput` row in the running turn; the transcript records `steer: true` and restore keeps it in that turn.
- [x] 2.3 V4 bridge reports `delivery: "guide"` for mid-turn sends.

## 3. Verification

- [x] 3.1 Unit tests (`test/acpMidTurnSteering.test.ts`): steer + mid-turn effort, deferred model, fallback race, non-steering reject, restore, bridge.
- [x] 3.2 Offline real-CLI replay (`acpComplexReplay.e2e.ts`, fixture `claude-code-steer.json`): the steer interrupts the stalled stream and the steered reply lands in the same turn.
- [x] 3.3 Live steering on all three runtimes through OpenRouter (website task steered after the first tool call; joined the running turn on all three in runs 14 and 17).
