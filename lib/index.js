/**
 * dsh-dispatch-gate: run existing control-plane dispatch prompts only when the
 * target root session is idle and the control state still calls for that role.
 *
 * This package does not modify DSH Schedule. It replaces fixed-tick dispatch
 * tasks with project-scoped deterministic pre-checks and idle gates.
 *
 * The optional Client half uses the existing commands Remote for project-aware
 * status and control. No custom Remote service is added.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DispatchGateManager } from "./manager.js";
import { DispatchGateRuntime } from "./runtime.js";
import { DEFAULT_HOLIDAYS_2026, DEFAULT_PEAK_WINDOWS, DEFAULT_TIME_ZONE } from "./time.js";

/** Cordis plugin name. */
export const name = "dispatch-gate";
/** Services required before the gate can resolve and wake root sessions. */
export const inject = ["agents", "sessions", "sessionController", "commands", "tools"];

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DSH_HOME = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
const DEFAULT_ALIAS_STATE = join(DSH_HOME, "storages", "agent-bus", "state.json");
const DEFAULT_STATE_DIR = join(DSH_HOME, "storages", "dispatch-gate");
const DEFAULT_BUS_LOG = join(DSH_HOME, "storages", "agent-bus", "messages.jsonl");

const Job = z.object({
  id: z.string().required(),
  agent: z.string().required(),
  states: z.array(z.string()).required(),
  promptFile: z.string().required(),
  retrySeconds: z.number().step(1).min(0).max(86_400).default(300),
  controlOnlyStates: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const Check = z.object({
  cwd: z.string().required(),
  command: z.array(z.string()).required(),
  timeoutMs: z.number().step(1).min(1000).max(120_000).default(15_000),
});

const RuntimeFields = {
  pollMs: z.number().step(1).min(1000).max(60_000).default(10_000),
  initialDelayMs: z.number().step(1).min(0).max(3_600_000).default(5000),
  aliasStatePath: z.string().default(DEFAULT_ALIAS_STATE),
  busLogPath: z.string().default(DEFAULT_BUS_LOG),
  watchDir: z.string().default("plans/control"),
  mailboxDirs: z.array(z.string()).default(["plans/mailbox/astra"]),
  syncFiles: z.array(z.string()).default(["plans/control/SYNC.md"]),
  watchDebounceMs: z.number().step(1).min(50).max(60_000).default(300),
  busyRetryMs: z.number().step(1).min(500).max(60_000).default(2000),
  offlineRecoveryEnabled: z.boolean().default(true),
  offlineRetryInitialDelayMs: z.number().step(100).min(1000).max(600_000).default(5000),
  offlineRetryMaxDelayMs: z.number().step(1000).min(1000).max(3_600_000).default(300_000),
  offlineRetryJitterRatio: z.number().min(0).max(1).default(0.2),
  maxConcurrentAgents: z.number().step(1).min(1).max(10).default(1),
  syncWakeCooldownMs: z.number().step(1000).min(0).max(600_000).default(30000),
  dispatchCooldownMs: z.number().step(1000).min(0).max(600_000).default(10000),
  handoffSettleMs: z.number().step(100).min(0).max(60_000).default(3000),
  peakScheduleEnabled: z.boolean().default(true),
  timeZone: z.string().default(DEFAULT_TIME_ZONE),
  peakWindows: z.array(z.string()).default(DEFAULT_PEAK_WINDOWS),
  holidays: z.array(z.string()).default([...DEFAULT_HOLIDAYS_2026]),
  controlChangeRoles: z.array(z.string()).default([]),
  coordinatorAgent: z.string().default("planner"),
  requireCoordinatorIdle: z.boolean().default(true),
  workerStateRoles: z.dict(z.string()).default({
    assigned_coding: "coding",
    awaiting_verification: "acceptance",
  }),
  workerRoles: z.array(z.string()).default([]),
  pauseAllowsHandoff: z.boolean().default(true),
  uiShowIn: z.array(z.string()).default([]),
  agentIds: z.dict(z.string()).default({}),
  requireIdle: z.boolean().default(true),
  skipIfInboxPending: z.boolean().default(true),
};

const Project = z.object({
  ...RuntimeFields,
  project: z.string().required(),
  stateDir: z.string().optional(),
  statusPath: z.string().optional(),
  check: Check,
  jobs: z.array(Job).required(),
});

/** Row schema: one legacy project or any number of isolated project instances. */
export const Config = z.object({
  ...RuntimeFields,
  project: z.string().default("default"),
  stateDir: z.string().default(DEFAULT_STATE_DIR),
  statusPath: z.string().default("logs/dispatch-gate/status.json"),
  check: Check.optional(),
  jobs: z.array(Job).default([]),
  projects: z.array(Project).default([]),
});

function readPrompt(promptFile) {
  const path = isAbsolute(promptFile) ? promptFile : resolve(PACKAGE_ROOT, promptFile);
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) throw new Error(`dispatch-gate: prompt file is empty: ${path}`);
  return text;
}

function assertProjectName(project) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(project)) {
    throw new Error(`dispatch-gate: project "${project}" must use only letters, numbers, dot, underscore, or hyphen`);
  }
  if (new Set(["status", "pause", "resume", "force", "auto", "tick"]).has(project)) {
    throw new Error(`dispatch-gate: project "${project}" conflicts with a /gate action name`);
  }
}

function normalizeProjects(config) {
  const configured = Array.isArray(config.projects) && config.projects.length > 0
    ? config.projects.map((project) => ({
      ...project,
      stateDir: project.stateDir ?? join(DEFAULT_STATE_DIR, project.project),
      statusPath: project.statusPath ?? `logs/dispatch-gate/${project.project}/status.json`,
    }))
    : [{ ...config }];
  const names = new Set();
  const stateDirs = new Set();
  const statusPaths = new Set();
  for (const project of configured) {
    assertProjectName(project.project);
    if (names.has(project.project)) throw new Error(`dispatch-gate: duplicate project "${project.project}"`);
    names.add(project.project);
    if (!project.check || !Array.isArray(project.check.command) || project.check.command.length === 0) {
      throw new Error(`dispatch-gate: project "${project.project}" check.command must not be empty`);
    }
    if (!Array.isArray(project.jobs) || project.jobs.length === 0) {
      throw new Error(`dispatch-gate: project "${project.project}" must contain at least one job`);
    }
    const stateDir = resolve(project.stateDir);
    const statusPath = isAbsolute(project.statusPath)
      ? resolve(project.statusPath)
      : resolve(project.check.cwd, project.statusPath);
    if (stateDirs.has(stateDir)) throw new Error(`dispatch-gate: project "${project.project}" reuses stateDir "${stateDir}"`);
    if (statusPaths.has(statusPath)) throw new Error(`dispatch-gate: project "${project.project}" reuses statusPath "${statusPath}"`);
    stateDirs.add(stateDir);
    statusPaths.add(statusPath);
    const jobIds = new Set();
    for (const job of project.jobs) {
      if (jobIds.has(job.id)) throw new Error(`dispatch-gate: duplicate job "${job.id}" in project "${project.project}"`);
      jobIds.add(job.id);
    }
  }
  return configured;
}

/**
 * Register one process-wide gate. It has no model-facing tools: its job is to
 * wake the existing dispatch prompts at the right moment.
 * @param {object} ctx Cordis context
 * @param {object} config validated row config
 */
export function apply(ctx, config) {
  const dispatchLeases = new Set();
  const acquireDispatch = (sessionId) => {
    if (dispatchLeases.has(sessionId)) return null;
    dispatchLeases.add(sessionId);
    return () => dispatchLeases.delete(sessionId);
  };
  const runtimes = normalizeProjects(config).map((project) => {
    const jobs = project.jobs.map((job) => ({ ...job, prompt: readPrompt(job.promptFile) }));
    return new DispatchGateRuntime(ctx, { ...project, jobs }, { createUserMessage, acquireDispatch });
  });
  const manager = new DispatchGateManager(runtimes);

  ctx.effect(() => {
    manager.start();
    return () => manager.dispose();
  }, "dispatch-gate.lifecycle()");

  // Register the JSON Remote service in the gate plugin's own fiber. Manual
  // construction is deliberate: the Service base registers on construction and
  // unregisters with this fiber; `ctx.plugin(ServiceClass)` proved unreliable
  // for a child service here.
  // `/gate status|pause|resume|tick` is the human control surface. The composer
  // calls the same commands; it does not need a custom Host Remote service.
  // `commands` is in the static inject list: the proven registration pattern in
  // this build, unlike a late `ctx.inject` child that the client may race.
  ctx.effect(() => ctx.commands.register({
    name: "gate",
    description: "Dispatch gate: project-aware status, pause, resume, and tick",
    input: { hint: "[project] status | pause | resume | force | auto | tick" },
    handler: ({ rawInput, agent }) => manager.handleCommand(rawInput, agent.id),
  }), "dispatch-gate.command()");
}

export { DispatchGateManager, DispatchGateRuntime };
