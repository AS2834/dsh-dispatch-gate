import test from "node:test";
import assert from "node:assert/strict";
import { DispatchGateManager } from "../lib/manager.js";

function fakeRuntime(project, sessions, visible = sessions) {
  return {
    project,
    started: 0,
    disposed: 0,
    commands: [],
    start() { this.started += 1; },
    async dispose() { this.disposed += 1; },
    rolesForSession(id) { return sessions.includes(id) ? [`${project}-role`] : []; },
    isVisibleToSession(id) { return visible.includes(id); },
    statusSnapshot() { return { v: 1, project, jobs: [] }; },
    summaryText() { return `gate: ${project}`; },
    async handleCommand(command) {
      this.commands.push(command);
      return { kind: "success", text: `${project}:${command}` };
    },
  };
}

test("starts and disposes every project runtime", async () => {
  const alpha = fakeRuntime("alpha", ["s1"]);
  const beta = fakeRuntime("beta", ["s2"]);
  const manager = new DispatchGateManager([alpha, beta]);
  manager.start();
  assert.equal(alpha.started, 1);
  assert.equal(beta.started, 1);
  await manager.dispose();
  assert.equal(alpha.disposed, 1);
  assert.equal(beta.disposed, 1);
});

test("routes commands by current session or explicit project", async () => {
  const alpha = fakeRuntime("alpha", ["s1"]);
  const beta = fakeRuntime("beta", ["s2"]);
  const manager = new DispatchGateManager([alpha, beta]);

  const automatic = await manager.handleCommand("pause", "s2");
  assert.equal(automatic.text, "beta:pause");
  assert.deepEqual(beta.commands, ["pause"]);

  const explicit = await manager.handleCommand("alpha tick", "outside");
  assert.equal(explicit.text, "alpha:tick");
  assert.deepEqual(alpha.commands, ["tick"]);
});

test("returns project-aware status and rejects ambiguous mutation", async () => {
  const alpha = fakeRuntime("alpha", ["shared"]);
  const beta = fakeRuntime("beta", ["shared"], []);
  const manager = new DispatchGateManager([alpha, beta]);

  const status = await manager.handleCommand("status json", "shared");
  const parsed = JSON.parse(status.text);
  assert.equal(parsed.multiProject, true);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[0].commandProject, "alpha");
  assert.equal(parsed.projects[0].visible, true);
  assert.equal(parsed.projects[1].visible, false);

  const ambiguous = await manager.handleCommand("pause", "shared");
  assert.equal(ambiguous.kind, "error");
  assert.match(ambiguous.text, /multiple projects/);

  const explicit = await manager.handleCommand("beta pause", "shared");
  assert.equal(explicit.kind, "success");
  assert.deepEqual(beta.commands, ["pause"]);
});
