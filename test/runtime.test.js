import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchGateRuntime } from "../lib/runtime.js";

const SESSION = "session-11111111-1111-4111-8111-111111111111";

function makeAgent() {
  return {
    id: SESSION,
    status: "idle",
    session: { id: SESSION },
    inbox: { hasPending: false },
    followups: [],
    followup(message) {
      this.followups.push(message);
    },
  };
}

function makeCtx(agent) {
  return {
    logger: { warn() {}, info() {} },
    agents: {
      get: (id) => (id === SESSION ? agent : undefined),
      roots: () => [agent],
    },
    sessions: { flush: async () => true },
  };
}

let runtimeSequence = 0;

function makeRuntime({ state, agent, exec } = {}) {
  const current = state ?? { value: "assigned_coding" };
  const target = agent ?? makeAgent();
  const dir = mkdtempSync(join(tmpdir(), `dispatch-gate-test-${++runtimeSequence}-`));
  let next = 0;
  const createUserMessage = (input) => ({ id: `m-${++next}`, content: input.content, source: input.source });
  const execFileImpl = exec ?? ((file, args, options, callback) => {
    callback(null, JSON.stringify({ state: current.value }), "");
  });
  const config = {
    jobs: [{
      id: "coding-dispatch",
      agent: "coding",
      states: ["assigned_coding"],
      prompt: "PROMPT",
      retrySeconds: 300,
      enabled: true,
    }],
    check: { cwd: dir, command: ["fake"], timeoutMs: 1000 },
    aliasStatePath: join(dir, "agent-bus-state.json"),
    stateDir: join(dir, "state"),
    statusPath: join(dir, "status.json"),
    busLogPath: join(dir, "messages.jsonl"),
    agentIds: { coding: SESSION },
    pollMs: 10000,
    initialDelayMs: 3600000,
    peakScheduleEnabled: false,
    requireIdle: true,
    skipIfInboxPending: true,
  };
  return {
    runtime: new DispatchGateRuntime(makeCtx(target), config, { createUserMessage, execFileImpl }),
    current,
    target,
    dir,
  };
}

test("dispatches once on a state change and again only when retry is due", async () => {
  const { runtime, target } = makeRuntime();
  const first = await runtime.tickOnce();
  assert.equal(first.ok, true);
  assert.equal(target.followups.length, 1);
  assert.match(target.followups[0].content[0].text, /^\[DISPATCH GATE\]/);
  assert.equal(target.followups[0].source.kind, "dispatch-gate");

  const second = await runtime.tickOnce();
  assert.equal(second.results[0].reason, "state_unchanged");
  assert.equal(target.followups.length, 1);

  runtime.jobs[0].lastDispatchAt = Date.now() - 301_000;
  const third = await runtime.tickOnce();
  assert.equal(third.results[0].reason, "retry_due");
  assert.equal(target.followups.length, 2);
});

test("does not dispatch while the agent is busy or the inbox has pending work", async () => {
  const busy = makeRuntime();
  await busy.runtime.tickOnce();
  busy.target.status = "running";
  busy.runtime.jobs[0].lastState = "awaiting_verification";
  const busyResult = await busy.runtime.tickOnce();
  assert.equal(busyResult.results[0].reason, "agent_busy");
  assert.equal(busy.target.followups.length, 1);

  const pending = makeRuntime();
  pending.target.inbox.hasPending = true;
  const pendingResult = await pending.runtime.tickOnce();
  assert.equal(pendingResult.results[0].reason, "inbox_pending");
  assert.equal(pending.target.followups.length, 0);
});

test("does not dispatch for a disallowed state and skips when the check fails", async () => {
  const disallowed = makeRuntime({ state: { value: "awaiting_verification" } });
  const disallowedResult = await disallowed.runtime.tickOnce();
  assert.equal(disallowedResult.results[0].reason, "state_not_allowed");
  assert.equal(disallowed.target.followups.length, 0);

  const failing = makeRuntime({ exec: (file, args, options, callback) => callback(new Error("boom"), "", "stderr") });
  const failingResult = await failing.runtime.tickOnce();
  assert.equal(failingResult.ok, false);
  assert.equal(failing.target.followups.length, 0);
});

test("resolves the role through the bus alias state file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-"));
  try {
    const aliasStatePath = join(dir, "state.json");
    writeFileSync(aliasStatePath, JSON.stringify({ aliases: { coding: SESSION } }), { mode: 0o600 });
    const { runtime, target } = makeRuntime();
    runtime.config.aliasStatePath = aliasStatePath;
    runtime.config.agentIds = {};
    const result = await runtime.tickOnce();
    assert.equal(result.ok, true);
    assert.equal(result.results[0].dispatch, true);
    assert.equal(target.followups.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose stops further ticks", async () => {
  const { runtime } = makeRuntime();
  await runtime.dispose();
  const result = await runtime.tickOnce();
  assert.equal(result.reason, "stopping");
});

test("pause blocks dispatch and is visible in the status file", async () => {
  const { runtime, target, dir } = makeRuntime();
  runtime.start();
  runtime.pause("test");
  const result = await runtime.tickOnce();
  assert.equal(result.paused, true);
  assert.equal(target.followups.length, 0);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(status.paused, true);
  assert.equal(status.jobs[0].agent, "coding");
  await runtime.dispose();
});

test("an unclean previous run starts paused and removes its lock on clean dispose", async () => {
  const { runtime, target, dir } = makeRuntime();
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "run.lock"), "{}");
  runtime.start();
  assert.equal(runtime.uncleanStart, true);
  assert.equal(runtime.paused, true);
  const result = await runtime.tickOnce();
  assert.equal(result.paused, true);
  assert.equal(target.followups.length, 0);
  await runtime.dispose();
  assert.equal(existsSync(join(dir, "state", "run.lock")), false);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(status.cleanShutdown, true);
});

test("command status reports peers and pause/resume toggles the gate", async () => {
  const { runtime, target, dir } = makeRuntime();
  const aliasPath = join(dir, "agent-bus-state.json");
  writeFileSync(aliasPath, JSON.stringify({ aliases: { coding: SESSION } }));
  const busLog = join(dir, "messages.jsonl");
  writeFileSync(busLog, JSON.stringify({ id: "m1", ts: "2026-10-26T00:00:00Z", from: "planner", to: "coding", kind: "message" }) + "\n");
  runtime.config.aliasStatePath = aliasPath;
  runtime.config.agentIds = {};
  runtime.busLogPath = busLog;

  const paused = await runtime.handleCommand("pause");
  assert.equal(paused.kind, "success");
  assert.equal((await runtime.tickOnce()).paused, true);
  assert.equal(target.followups.length, 0);

  const resumed = await runtime.handleCommand("resume");
  assert.equal(resumed.kind, "success");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(status.paused, false);
  assert.equal(status.bus.peers[0].alias, "coding");
  assert.equal(status.bus.lastMessage.from, "planner");
  await runtime.dispose();
});
