## 1. P0 groundwork

- [ ] 1.1 Tool identity: `name`/`_meta.claudeCode.toolName` set once, kind fallback, MCP naming + `mcp_tool` display, structured `input`.
- [ ] 1.2 Optional `sessionId` on transcript update entries; one `at` per update for live and replay.
- [ ] 1.3 Lifecycle updates outside a turn; out-of-turn content → `backgroundResult` display-only turn or dropped.
- [ ] 1.4 zod schemas for `subagent_*`, `async_task_*`, `_meta.lody.task`, goal meta; stream carrier through SDK 1.4.

## 2. P1 subagents

- [ ] 2.1 Declare `subagents` + AIR `nativeSubagentSessions`; connection child registry fed in wire order.
- [ ] 2.2 Projection: host `Agent` row + `subagent` row, child projections V(S), terminal mapping, summary, generations.
- [ ] 2.3 Child permissions on the root with `origin.kind="subagent"`; `snapshot.subagents`.
- [ ] 2.4 Bridge/coordinator/service routing for virtual child ids (subscribe, resync, rowsRange, listSessionSubagents).
- [ ] 2.5 Pi `_meta.lody.task` rows and `_lody/subagents/cancel`.

## 3. P2 background tasks and questionnaires

- [ ] 3.1 AIR `asyncTasks`: `backgroundWorks`, `backgrounded`, `cancelBackgroundWork` → `_session/async_task/stop`.
- [ ] 3.2 `elicitation.form`: `createElicitation` → `userInput` questions; answers → `{action, content}`; cancel on stop/exit.

## 4. P3 goal

- [ ] 4.1 `_meta.goal` → `snapshot.goal` and in-turn `goalSet` marker.

## 5. P4 computer use and workflows

- [ ] 5.1 Codex `computer-use` MCP tools → `mcp__computer-use__<tool>` with bounded CUA media; node_repl images.
- [ ] 5.2 Claude workflow async tasks → `backgroundWorks(kind:"bash")`; document CUA placeholder and workflow blockers.

## 6. Verification

- [ ] 6.1 Unit tests with real wire shapes (fake ACP agent + projection replays).
- [ ] 6.2 `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, oxfmt.
