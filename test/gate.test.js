import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDispatchText,
  buildSource,
  completedWorkerClaim,
  evaluateJob,
  findClaim,
  isCompletedClaim,
  normalizePollMs,
  parseControlStatus,
  resolveAgentId,
  workerRoleForState,
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

  const scoped = buildDispatchText(job(), "assigned_coding", { project: "example-project", task: "S3-3b", round: "r01", sequence: 17 });
  assert.match(scoped, /Project: example-project/);
  assert.equal(scoped.includes("Task: S3-3b"), false);

  const source = buildSource(job(), "assigned_coding");
  assert.equal(source.kind, "dispatch-gate");
  assert.equal(source.form, "notice");
  assert.equal(source.producer, "dsh-dispatch-gate");
  assert.match(source.summary, /coding-dispatch/);
  assert.match(buildSource(job(), "assigned_coding", { project: "example-project" }).summary, /example-project/);
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

test("validates the completed worker claim for the active task/round/handoff", () => {
  const handoff = "a".repeat(64);
  const status = {
    state: "assigned_coding",
    task_id: "S6-4a",
    round: "r01",
    handoff_sha256: handoff,
    claims: [{
      role: "coding",
      task: "S6-4a",
      round: "r01",
      status: "completed",
      claim_token: "token",
      role_session: SESSION,
      finished_at: "2026-11-03T21:24:49+08:00",
      handoff_sha256: handoff,
    }],
  };
  assert.equal(workerRoleForState("assigned_coding"), "coding");
  assert.equal(workerRoleForState("awaiting_verification"), "acceptance");
  assert.equal(workerRoleForState("idle"), null);
  assert.equal(findClaim(status, "coding")?.claim_token, "token");
  assert.equal(findClaim(status, "acceptance"), null);
  assert.equal(isCompletedClaim(findClaim(status, "coding"), status), true);
  assert.equal(isCompletedClaim(findClaim(status, "coding"), status, SESSION), true);
  assert.equal(isCompletedClaim({ ...status.claims[0], role_session: "coding-s64a-r01" }, status, SESSION), false);
  assert.deepEqual(completedWorkerClaim(status, undefined, { coding: SESSION })?.role, "coding");
  assert.equal(completedWorkerClaim(status), null, "a claim cannot be accepted without the configured role session");

  assert.equal(isCompletedClaim({ ...status.claims[0], status: "claimed" }, status), false);
  assert.equal(isCompletedClaim({ ...status.claims[0], handoff_sha256: "b".repeat(64) }, status), false);
  assert.equal(isCompletedClaim({ ...status.claims[0], claim_token: "" }, status), false);
  assert.equal(completedWorkerClaim({ ...status, state: "idle" }, undefined, { coding: SESSION }), null);
});
