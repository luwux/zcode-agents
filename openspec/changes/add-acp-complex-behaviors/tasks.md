## 1. P0 groundwork

- [x] 1.1 Tool identity: `name`/`_meta.claudeCode.toolName` set once, kind fallback, MCP naming + `mcp_tool` display, structured `input`.
- [x] 1.2 Optional `sessionId` on transcript update entries; one `at` per update for live and replay.
- [x] 1.3 Lifecycle updates outside a turn; out-of-turn content → `backgroundResult` display-only turn or dropped.
- [x] 1.4 zod schemas for `subagent_*`, `async_task_*`, `_meta.lody.task`, goal meta; stream carrier through SDK 1.4.

## 2. P1 subagents

- [x] 2.1 Declare `subagents` + AIR `nativeSubagentSessions`; connection child registry fed in wire order.
- [x] 2.2 Projection: host `Agent` row + `subagent` row, child projections V(S), terminal mapping, summary, generations.
- [x] 2.3 Child permissions on the root with `origin.kind="subagent"`; `snapshot.subagents`.
- [x] 2.4 Bridge/coordinator/service routing for virtual child ids (subscribe, resync, rowsRange, listSessionSubagents).
- [x] 2.5 Pi `_meta.lody.task` rows and `_lody/subagents/cancel`.

## 3. P2 background tasks and questionnaires

- [x] 3.1 AIR `asyncTasks`: `backgroundWorks`, `backgrounded`, `cancelBackgroundWork` → `_session/async_task/stop`.
- [x] 3.2 `elicitation.form`: `createElicitation` → `userInput` questions; answers → `{action, content}`; cancel on stop/exit.

## 4. P3 goal

- [x] 4.1 `_meta.goal` → `snapshot.goal` and in-turn `goalSet` marker.

## 5. P4 computer use and workflows

- [x] 5.1 Codex `computer-use` MCP tools → `mcp__computer-use__<tool>` with bounded CUA media; node_repl images.
- [x] 5.2 Claude workflow async tasks → `backgroundWorks(kind:"bash")`; document CUA placeholder and workflow blockers.

## 6. Verification

- [x] 6.1 Unit tests with real wire shapes (fake ACP agent + projection replays).
- [x] 6.2 `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, oxfmt.
- [ ] 6.3 Desktop/remote-web E2E: open the child side pane from the Agent row and answer a child permission
      (not run in this change: needs the CDP harness from `add-builtin-acp-runtimes` 4.4 and a live runtime).

## 7. Deferred

- [ ] 7.1 Claude legacy `_meta.claudeCode.parentToolUseId` routing (only needed when `subagents` is not declared).
- [ ] 7.2 Codex legacy collab tool-call parsing; `_lody/subagents/output` in the child pane.
- [ ] 7.3 `session.notices` / `session.compaction` / `plan_update` capabilities; `_session/goal` pause/resume control.
- [ ] 7.4 ZCode Computer Use (`node_repl` MCP injection) once `@zcode/zcode-cua` ships a real implementation.
