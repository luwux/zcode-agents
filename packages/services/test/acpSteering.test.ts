import assert from "node:assert/strict";
import test from "node:test";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  detectAcpSteering,
  LODY_STEER_METHOD,
  SESSION_STEERING_METHOD,
  steerAcpSession,
} from "../src/agent-runtime/acpSteering.js";

const base: InitializeResponse = { protocolVersion: 1, agentCapabilities: {} };

test("steering capability is read from the adapters' real initialize shapes", () => {
  // claude-agent-acp / codex-acp：顶层 _meta.steering.supported
  assert.equal(
    detectAcpSteering({ ...base, _meta: { steering: { supported: true } } }),
    "session-steering",
  );
  // acp-extension-pi：agentCapabilities._meta.lody.steering
  assert.equal(
    detectAcpSteering({
      ...base,
      agentCapabilities: {
        _meta: {
          lody: {
            steering: {
              version: 1,
              transport: "request",
              upstreamTurn: "same",
              configPolicy: "active",
            },
          },
        },
      },
    }),
    "lody-steer",
  );
  assert.equal(detectAcpSteering(base), null);
  assert.equal(detectAcpSteering({ ...base, _meta: { steering: { supported: false } } }), null);
});

test("steer requests use each protocol's params and map outcomes", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const reply = (outcome: unknown) => ({
    extMethod: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return { outcome };
    },
  });
  const prompt = [{ type: "text" as const, text: "use the other file" }];
  assert.equal(
    await steerAcpSession(reply("injected"), "session-steering", {
      sessionId: "s",
      steerId: "c1",
      prompt,
    }),
    "injected",
  );
  assert.deepEqual(calls[0], [
    SESSION_STEERING_METHOD,
    { sessionId: "s", prompt, _meta: { steering: { idleBehavior: "promptRequired" } } },
  ]);
  assert.equal(
    await steerAcpSession(reply("promptRequired"), "session-steering", {
      sessionId: "s",
      steerId: "c2",
      prompt,
    }),
    "promptRequired",
  );
  await assert.rejects(
    steerAcpSession(reply("startedNewTurn"), "session-steering", {
      sessionId: "s",
      steerId: "c3",
      prompt,
    }),
  );

  assert.equal(
    await steerAcpSession(reply(undefined), "lody-steer", {
      sessionId: "p",
      steerId: "c4",
      prompt,
    }),
    "injected",
  );
  assert.deepEqual(calls.at(-1), [LODY_STEER_METHOD, { sessionId: "p", steerId: "c4", prompt }]);
  const refusing = {
    extMethod: async () => {
      throw { code: -32600, message: "Invalid request: No available Pi turn for steer" };
    },
  };
  assert.equal(
    await steerAcpSession(refusing, "lody-steer", { sessionId: "p", steerId: "c5", prompt }),
    "promptRequired",
  );
});
