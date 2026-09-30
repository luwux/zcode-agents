/**
 * 假 ACP Agent：按 prompt 文本回放 claude-agent-acp 0.81 / codex-acp 1.13 的真实扩展 wire 形状
 * （subagent_*、async_task_*、AIR backgrounded 标记、form elicitation、子会话权限）。
 */
export const COMPLEX_AGENT = `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = (sessionId, value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const text = (sessionId, value) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const waiting = new Map();
let nextId = 1;
let cancelled = false;
let caps = null;
const request = (method, params) => {
  const id = 'agent-' + nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
};
const options = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const askSchema = {
  type: 'object',
  properties: {
    question_0: { type: 'string', title: 'Cache', description: 'Which cache?',
      oneOf: [{ const: 'Redis', title: 'Redis' }, { const: 'Memcached', title: 'Memcached' }] },
    question_0_custom: { type: 'string', title: 'Other',
      _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } } },
    question_1: { type: 'array', title: 'Checks', description: 'Which checks?',
      items: { anyOf: [{ const: 'lint', title: 'lint' }, { const: 'test', title: 'test' }] } },
    question_1_custom: { type: 'string', title: 'Other',
      _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_1', isCustomAnswer: true } } },
  },
};
async function prompt(message) {
  const answer = (stopReason) => send({ jsonrpc: '2.0', id: message.id, result: { stopReason } });
  const body = message.params.prompt.map((block) => block.text ?? '').join(' ');
  cancelled = false;
  if (body.includes('caps')) {
    text('root', JSON.stringify(caps));
  } else if (body.includes('subagent')) {
    update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'task-1', name: 'Explore', task: 'Find the loader', capabilities: {} });
    update('task-1', { sessionUpdate: 'tool_call', toolCallId: 'toolu_child', name: 'Grep', title: 'grep loader', kind: 'search', status: 'completed', rawInput: { pattern: 'loader' } });
    update('ghost', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ghost text' } });
    const ghost = await request('session/request_permission', { sessionId: 'ghost', toolCall: { toolCallId: 'g1', title: 'ghost' }, options });
    const child = await request('session/request_permission', { sessionId: 'task-1', toolCall: { toolCallId: 'toolu_edit', title: 'Edit a.ts' }, options });
    text('task-1', 'child:' + child.outcome.outcome + ':' + (child.outcome.optionId ?? ''));
    text('root', 'ghost:' + ghost.outcome.outcome);
    update('root', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'task-1', state: 'completed' });
  } else if (body.includes('async')) {
    update('root', { sessionUpdate: 'tool_call', toolCallId: 'toolu_bash', name: 'Bash', title: 'sleep 100', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 100', run_in_background: true } });
    update('root', { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_bash', status: 'completed', _meta: { jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } } });
    update('root', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'bg-1', name: 'sleep 100', taskType: 'shell', description: 'sleep 100', showInTranscript: false, canStop: true, toolCallId: 'toolu_bash' });
    update('root', { sessionUpdate: 'async_task_spawned', asyncTaskId: 'bg-2', name: 'watcher', taskType: 'monitor', canStop: true });
  } else if (body.includes('ask')) {
    const result = await request('elicitation/create', { sessionId: 'root', toolCallId: 'toolu_ask', mode: 'form', message: 'Please answer the following questions.', requestedSchema: askSchema });
    text('root', 'elicitation:' + JSON.stringify(result));
  }
  answer(cancelled ? 'cancelled' : 'end_turn');
}
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result ?? { error: message.error });
    waiting.delete(message.id);
    continue;
  }
  const answer = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    caps = message.params.clientCapabilities;
    answer({ protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: true } });
  } else if (message.method === 'session/new') answer({ sessionId: 'root' });
  else if (message.method === 'session/load') answer({});
  else if (message.method === 'session/cancel') cancelled = true;
  else if (message.method === '_session/async_task/stop') {
    const stopped = message.params.asyncTaskId === 'bg-1' && message.params.sessionId === 'root';
    answer({ stopped });
    if (stopped) {
      update('root', { sessionUpdate: 'async_task_state_update', asyncTaskId: 'bg-1', state: 'stopped', toolCallId: 'toolu_bash' });
      text('root', 'Background sleep was stopped.');
    }
  } else if (message.method === 'session/prompt') void prompt(message);
}
`;
