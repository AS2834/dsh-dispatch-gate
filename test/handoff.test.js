import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchGateRuntime } from "../lib/runtime.js";

const CODING = "session-11111111-1111-4111-8111-111111111111";
const ACCEPTANCE = "session-22222222-2222-4222-8222-222222222222";
const PLANNER = "session-33333333-3333-4333-8333-333333333333";
const HANDOFF = "a".repeat(64);

function makeAgent(id) {
  return {
    id,
    status: "idle",
    session: { id },
    inbox: { hasPending: false },
    followups: [],
    followup(message) {
      this.followups.push(message);
    },
  };
}

function makeCtx(agents) {
  return {
    logger: { warn() {}, info() {} },
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      roots: () => agents,
    },
    sessions: { flush: async () => true },
  };
}

function statusFor(overrides = {}) {
  return {
    state: "assigned_coding",
    task_id: "S6-4a",
    round: "r01",
    handoff_sha256: HANDOFF,
    claims: [],
    ...overrides,
  };
}

function completedClaim(role, status) {
  return {
    role,
    task: status.task_id,
    round: status.round,
    status: "completed",
    claim_token: `token-${role}`,
    role_session: role === "coding" ? CODING : ACCEPTANCE,
    finished_at: "2026-11-03T21:24:49+08:00",
    handoff_sha256: status.handoff_sha256,
  };
}

function makeRuntime({ status, agents, dir, overrides = {} } = {}) {
  const workDir = dir ?? mkdtempSync(join(tmpdir(), "dispatch-gate-handoff-"));
  const current = status ?? { value: statusFor() };
  const allAgents = agents ?? [makeAgent(CODING), makeAgent(ACCEPTANCE), makeAgent(PLANNER)];
  let next = 0;
  const config = {
    jobs: [
      { id: "coding-dispatch", agent: "coding", states: ["assigned_coding"], prompt: "CODING", retrySeconds: 300, enabled: true },
      { id: "acceptance-dispatch", agent: "acceptance", states: ["awaiting_verification"], prompt: "ACCEPTANCE", retrySeconds: 300, enabled: true },
      {
        id: "planner-dispatch",
        agent: "planner",
        states: ["idle", "assigned_coding", "awaiting_verification", "verified", "submitted"],
        controlOnlyStates: ["assigned_coding", "awaiting_verification"],
        prompt: "PLANNER",
        retrySeconds: 600,
        enabled: true,
      },
    ],
    check: { cwd: workDir, command: ["fake"], timeoutMs: 1000 },
    aliasStatePath: join(workDir, "agent-bus-state.json"),
    stateDir: join(workDir, "state"),
    statusPath: join(workDir, "status.json"),
    busLogPath: join(workDir, "messages.jsonl"),
    agentIds: { coding: CODING, acceptance: ACCEPTANCE, planner: PLANNER },
    pollMs: 10_000,
    initialDelayMs: 3_600_000,
    peakScheduleEnabled: false,
    requireIdle: true,
    skipIfInboxPending: true,
    maxConcurrentAgents: 1,
    handoffSettleMs: 0,
    dispatchCooldownMs: 0,
    ...overrides,
  };
  const createUserMessage = (input) => ({ id: `m-${++next}`, content: input.content, source: input.source });
  const execFileImpl = (file, args, options, callback) => callback(null, JSON.stringify(current.value), "");
  const runtime = new DispatchGateRuntime(makeCtx(allAgents), config, { createUserMessage, execFileImpl });
  return { runtime, agents: allAgents, current, dir: workDir };
}

test("pause blocks new work but still hands off a completed worker claim", async () => {
  const current = { value: statusFor() };
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const { runtime } = makeRuntime({ status: current, agents: [coding, acceptance, planner] });

  runtime.pause("test");
  let result = await runtime.tickOnce();
  assert.deepEqual(result.results.map((entry) => entry.reason), ["paused", "paused", "paused"]);
  assert.equal(coding.followups.length, 0);
  assert.equal(planner.followups.length, 0);

  // The worker was already running when pause landed; let its turn finish.
  coding.status = "running";
  await runtime.tickOnce();
  current.value.claims = [completedClaim("coding", current.value)];
  coding.status = "idle";
  result = await runtime.tickOnce();

  assert.equal(coding.followups.length, 0, "paused gate must not start new coding work");
  assert.equal(planner.followups.length, 1, "the completed claim must still wake the planner");
  assert.equal(runtime.pendingPlannerWake, false);
});

test("persists pendingPlannerWake while paused and restores it after restart", async () => {
  const current = { value: statusFor() };
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const first = makeRuntime({ status: current, agents: [coding, acceptance, planner] });

  first.runtime.pause("test");
  coding.status = "running";
  await first.runtime.tickOnce();
  current.value.claims = [completedClaim("coding", current.value)];
  coding.status = "idle";
  planner.status = "running"; // busy: handoff cannot dispatch yet, so the wake must persist
  await first.runtime.tickOnce();

  assert.equal(first.runtime.pendingPlannerWake, true);
  assert.equal(planner.followups.length, 0);
  const saved = JSON.parse(readFileSync(join(first.dir, "state", "state.json"), "utf8"));
  assert.equal(saved.pendingPlannerWake, true);
  assert.equal(saved.pendingPlannerWakeKind, "worker_completed");
  assert.equal(saved.pendingPlannerWakeWorker, "coding");
  assert.equal(saved.pendingPlannerWakeTask, "S6-4a");
  await first.runtime.dispose();

  const coding2 = makeAgent(CODING);
  const acceptance2 = makeAgent(ACCEPTANCE);
  const planner2 = makeAgent(PLANNER);
  const second = makeRuntime({
    dir: first.dir,
    status: { value: current.value },
    agents: [coding2, acceptance2, planner2],
  });
  second.runtime.start();
  assert.equal(second.runtime.pendingPlannerWake, true, "restart must restore the persisted wake");
  await second.runtime.tickOnce();
  assert.equal(planner2.followups.length, 1, "restored wake must be delivered after restart");
  await second.runtime.dispose();
});

test("recovers a completed claim at startup and only wakes the planner once per process", async () => {
  const status = statusFor();
  status.claims = [completedClaim("coding", status)];
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const first = makeRuntime({ status: { value: status }, agents: [coding, acceptance, planner] });

  first.runtime.start();
  await first.runtime.tickOnce();
  assert.equal(planner.followups.length, 1, "startup must recover the missed handoff");
  assert.equal(coding.followups.length, 0, "the completed worker claim is not re-dispatched");
  assert.equal(first.runtime.pendingPlannerWake, false);
  assert.equal(first.runtime.handoffHandled?.role, "coding");

  await first.runtime.tickOnce();
  assert.equal(planner.followups.length, 1, "the same handoff must not wake the planner every tick");
  await first.runtime.dispose();

  // A real restart still performs one recovery check even when the previous
  // process already recorded the handoff as handled.
  const planner2 = makeAgent(PLANNER);
  const second = makeRuntime({
    dir: first.dir,
    status: { value: status },
    agents: [makeAgent(CODING), makeAgent(ACCEPTANCE), planner2],
  });
  second.runtime.start();
  await second.runtime.tickOnce();
  assert.equal(planner2.followups.length, 1);
  await second.runtime.dispose();
});

test("worker idle with an incomplete claim marks worker_incomplete and does not wake the planner", async () => {
  const status = statusFor();
  status.claims = [{ ...completedClaim("coding", status), status: "claimed", finished_at: undefined }];
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const { runtime, dir } = makeRuntime({ status: { value: status }, agents: [coding, acceptance, planner] });

  await runtime.tickOnce();
  assert.equal(coding.followups.length, 1);

  coding.status = "running";
  await runtime.tickOnce();
  coding.status = "idle";
  await runtime.tickOnce();

  const codingJob = runtime.jobs.find((job) => job.id === "coding-dispatch");
  assert.equal(codingJob.status, "worker_incomplete");
  assert.equal(codingJob.lastReason, "worker_incomplete");
  assert.equal(runtime.workerIncomplete?.role, "coding");
  assert.equal(runtime.workerIncomplete?.claimStatus, "claimed");
  assert.equal(runtime.pendingPlannerWake, false);
  assert.equal(planner.followups.length, 0);

  const saved = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(saved.workerIncomplete.role, "coding");
  assert.equal(saved.pendingPlannerWake, false);
});

test("a stale persisted worker wake does not call the planner when the claim is incomplete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-stale-wake-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "state.json"), JSON.stringify({
    v: 1,
    paused: false,
    manualPaused: false,
    cleanShutdown: true,
    pendingPlannerWake: true,
    pendingPlannerWakeKind: "worker_completed",
    pendingPlannerWakeWorker: "coding",
    pendingPlannerWakeTask: "S6-4a",
    pendingPlannerWakeRound: "r01",
    pendingPlannerWakeHandoff: HANDOFF,
  }));

  const status = statusFor();
  status.claims = [{ ...completedClaim("coding", status), status: "claimed", finished_at: undefined }];
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const { runtime } = makeRuntime({ dir, status: { value: status }, agents: [coding, acceptance, planner] });

  runtime.start();
  assert.equal(runtime.pendingPlannerWake, true);
  await runtime.tickOnce();

  assert.equal(planner.followups.length, 0, "an incomplete claim must never wake the planner");
  assert.equal(runtime.pendingPlannerWake, false);
  assert.equal(runtime.workerIncomplete?.role, "coding");
  await runtime.dispose();
});

test("an acceptance completion in awaiting_verification hands off to the planner", async () => {
  const status = statusFor({ state: "awaiting_verification" });
  status.claims = [completedClaim("acceptance", status)];
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const { runtime } = makeRuntime({ status: { value: status }, agents: [coding, acceptance, planner] });

  await runtime.tickOnce();
  assert.equal(acceptance.followups.length, 0);
  assert.equal(coding.followups.length, 0);
  assert.equal(planner.followups.length, 1);
  assert.equal(runtime.pendingPlannerWake, false);
});

test("rejects a completed claim whose role_session is not the configured session", async () => {
  const status = statusFor();
  status.claims = [{ ...completedClaim("coding", status), role_session: "coding-s64a-r01" }];
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const { runtime } = makeRuntime({ status: { value: status }, agents: [coding, acceptance, planner] });

  await runtime.tickOnce();
  assert.equal(planner.followups.length, 0, "a duplicate executor must not trigger handoff");
  assert.equal(coding.followups.length, 1, "the configured coding session remains eligible for the round");
});

test("peak pause blocks a new round but never freezes a completed handoff", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-04T02:00:00Z")); // Wednesday 10:00 Asia/Shanghai
  const current = { value: statusFor() };
  const coding = makeAgent(CODING);
  const acceptance = makeAgent(ACCEPTANCE);
  const planner = makeAgent(PLANNER);
  const { runtime } = makeRuntime({
    status: current,
    agents: [coding, acceptance, planner],
    overrides: {
      peakScheduleEnabled: true,
      timeZone: "Asia/Shanghai",
      peakWindows: ["09:00-12:00"],
      holidays: [],
      pauseAllowsHandoff: false,
    },
  });

  let result = await runtime.tickOnce();
  assert.equal(result.paused, true);
  assert.equal(runtime.pauseSource, "peak");
  assert.equal(coding.followups.length, 0, "peak pause must block a new coding round");

  current.value.claims = [completedClaim("coding", current.value)];
  result = await runtime.tickOnce();
  assert.equal(result.paused, true);
  assert.equal(planner.followups.length, 1, "completed handoff must pass through peak pause");
  assert.equal(coding.followups.length, 0);
});
