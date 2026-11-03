/**
 * dsh-dispatch-gate: run existing control-plane dispatch prompts only when the
 * target root session is idle and the control state still calls for that role.
 *
 * This package does not modify DSH Schedule. It replaces the three fixed-tick
 * dispatch tasks with a deterministic pre-check and an idle gate.
 *
 * The optional Client half reads `logs/dispatch-gate/status.json` through the
 * existing workspaceFiles Remote and calls `/gate pause|resume` through the
 * existing commands Remote. No custom Remote service is added.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DispatchGateRuntime } from "./runtime.js";
import { DEFAULT_HOLIDAYS_2026, DEFAULT_PEAK_WINDOWS, DEFAULT_TIME_ZONE } from "./time.js";

/** Cordis plugin name. */
export const name = "dispatch-gate";
/** Services required before the gate can resolve and wake root sessions. */
export const inject = ["agents", "sessions", "commands"];

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

/** Row schema. The bundle patch supplies the three jobs and the control check. */
export const Config = z.object({
  pollMs: z.number().step(1).min(1000).max(60_000).default(10_000),
  initialDelayMs: z.number().step(1).min(0).max(3_600_000).default(5000),
  aliasStatePath: z.string().default(DEFAULT_ALIAS_STATE),
  stateDir: z.string().default(DEFAULT_STATE_DIR),
  statusPath: z.string().default("logs/dispatch-gate/status.json"),
  busLogPath: z.string().default(DEFAULT_BUS_LOG),
  watchDir: z.string().default("plans/control"),
  mailboxDirs: z.array(z.string()).default(["plans/mailbox/codex"]),
  syncFiles: z.array(z.string()).default(["plans/control/SYNC.md"]),
  watchDebounceMs: z.number().step(1).min(50).max(60_000).default(300),
  busyRetryMs: z.number().step(1).min(500).max(60_000).default(2000),
  maxConcurrentAgents: z.number().step(1).min(1).max(10).default(1),
  syncWakeCooldownMs: z.number().step(1000).min(0).max(600_000).default(30000),
  dispatchCooldownMs: z.number().step(1000).min(0).max(600_000).default(10000),
  peakScheduleEnabled: z.boolean().default(true),
  timeZone: z.string().default(DEFAULT_TIME_ZONE),
  peakWindows: z.array(z.string()).default(DEFAULT_PEAK_WINDOWS),
  holidays: z.array(z.string()).default([...DEFAULT_HOLIDAYS_2026]),
  controlChangeRoles: z.array(z.string()).default(["planner"]),
  coordinatorAgent: z.string().default("planner"),
  requireCoordinatorIdle: z.boolean().default(true),
  project: z.string().default("default"),
  uiShowIn: z.array(z.string()).default([]),
  agentIds: z.dict(z.string()).default({}),
  requireIdle: z.boolean().default(true),
  skipIfInboxPending: z.boolean().default(true),
  check: Check,
  jobs: z.array(Job).required(),
});

function readPrompt(promptFile) {
  const path = isAbsolute(promptFile) ? promptFile : resolve(PACKAGE_ROOT, promptFile);
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) throw new Error(`dispatch-gate: prompt file is empty: ${path}`);
  return text;
}

/**
 * Register one process-wide gate. It has no model-facing tools: its job is to
 * wake the existing dispatch prompts at the right moment.
 * @param {object} ctx Cordis context
 * @param {object} config validated row config
 */
export function apply(ctx, config) {
  if (!Array.isArray(config.jobs) || config.jobs.length === 0) throw new Error("dispatch-gate: at least one job is required");
  if (!Array.isArray(config.check.command) || config.check.command.length === 0) throw new Error("dispatch-gate: check.command must not be empty");
  const jobs = config.jobs.map((job) => ({ ...job, prompt: readPrompt(job.promptFile) }));
  const runtime = new DispatchGateRuntime(ctx, { ...config, jobs }, { createUserMessage });

  ctx.effect(() => {
    runtime.start();
    return () => runtime.dispose();
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
    description: "Dispatch gate: status, pause, resume, tick",
    input: { hint: "status | pause | resume | tick" },
    handler: ({ rawInput }) => runtime.handleCommand(rawInput),
  }), "dispatch-gate.command()");
}

export { DispatchGateRuntime };
