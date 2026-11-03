import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDispatchText,
  buildSource,
  evaluateJob,
  normalizePollMs,
  parseControlStatus,
  resolveAgentId,
} from "../lib/gate.js";

const SESSION = "session-11111111-1111-4111-8111-111111111111";

function job(overrides = {}) {
  return {
    id: "coding-dispatch",
    agent: "coding",
    states: ["assigned_coding"],
    prompt: "do the dispatch",
    retrySeconds: 300,
    enabled: true,
    lastDispatchAt: 0,
    ...overrides,
  };
}

test("dispatches only when state, idle, inbox, and retry conditions allow", () => {
  const base = { state: "assigned_coding", stateChanged: true, now: 1_000, agentStatus: "idle", inboxPending: false };
  assert.deepEqual(evaluateJob(job(), base), { dispatch: true, reason: "state_changed", stateChanged: true });
  assert.equal(evaluateJob(job(), { ...base, state: "awaiting_verification" }).reason, "state_not_allowed");
  assert.equal(evaluateJob(job(), { ...base, agentStatus: "running" }).reason, "agent_busy");
  assert.equal(evaluateJob(job(), { ...base, inboxPending: true }).reason, "inbox_pending");
  assert.equal(evaluateJob(job(), { ...base, coordinatorBusy: true }).reason, "coordinator_busy");
  assert.equal(evaluateJob(job(), { ...base, stateChanged: false, now: 1_000 }).reason, "state_unchanged");
  assert.equal(evaluateJob(job(), { ...base, stateChanged: false, force: true }).reason, "control_changed");
  assert.equal(evaluateJob(job(), { ...base, agentStatus: "running", force: true }).reason, "agent_busy");
  assert.equal(evaluateJob(job({ controlOnlyStates: ["assigned_coding"] }), { ...base, stateChanged: true }).reason, "wait_for_control_change");
  assert.equal(evaluateJob(job({ controlOnlyStates: ["assigned_coding"] }), { ...base, force: true }).reason, "control_changed");
  assert.equal(evaluateJob(job({ lastDispatchAt: 0 }), { ...base, stateChanged: false, now: 300_000 }).reason, "retry_due");
  assert.equal(evaluateJob(job({ retrySeconds: 0 }), { ...base, stateChanged: false }).reason, "state_unchanged");
  assert.equal(evaluateJob(job({ enabled: false }), base).reason, "disabled");
});

test("builds a distinct gate framing and producer source", () => {
  const text = buildDispatchText(job(), "assigned_coding");
  assert.match(text, /^\[DISPATCH GATE\]/);
  assert.match(text, /assigned_coding/);
  assert.match(text, /do the dispatch/);

  const scoped = buildDispatchText(job(), "assigned_coding", { project: "demo-project", task: "T-1", round: "r01", sequence: 17 });
  assert.match(scoped, /Project: demo-project/);
  assert.equal(scoped.includes("Task: T-1"), false);

  const source = buildSource(job(), "assigned_coding");
  assert.equal(source.kind, "dispatch-gate");
  assert.equal(source.form, "notice");
  assert.equal(source.producer, "dsh-dispatch-gate");
  assert.match(source.summary, /coding-dispatch/);
  assert.match(buildSource(job(), "assigned_coding", { project: "demo-project" }).summary, /demo-project/);
});

test("parses control status and rejects malformed output", () => {
  assert.deepEqual(parseControlStatus('{"state":"assigned_coding","sequence":9}').state, "assigned_coding");
  assert.equal(parseControlStatus("not json").ok, false);
  assert.equal(parseControlStatus('{"sequence":1}').ok, false);
  assert.equal(parseControlStatus("[]").ok, false);
});

test("resolves explicit ids, bus aliases, and raw session ids", () => {
  assert.equal(resolveAgentId({ coding: SESSION }, {}, "coding"), SESSION);
  assert.equal(resolveAgentId({}, { coding: SESSION }, "coding"), SESSION);
  assert.equal(resolveAgentId({}, {}, SESSION), SESSION);
  assert.equal(resolveAgentId({}, {}, "coding"), undefined);
});

test("clamps the poll interval", () => {
  assert.equal(normalizePollMs(10), 1000);
  assert.equal(normalizePollMs(999999), 60000);
  assert.equal(normalizePollMs("bad"), 10000);
});
