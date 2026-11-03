/**
 * Dispatch-gate runtime: deterministic control-plane checks, idle gating, and
 * schedule-like delivery without waking a busy session.
 *
 * The runtime keeps a small durable state file so a Ctrl+C / force-exit does
 * not make the gate forget that it just dispatched. It also writes a status
 * snapshot for the Web composer; that snapshot is the only UI data source.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  buildDispatchText,
  buildSource,
  evaluateJob,
  normalizePollMs,
  parseControlStatus,
  resolveAgentId,
} from "./gate.js";
import { describePeak, isPeak } from "./time.js";

function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
}

/** @param {number} ms */
function iso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Read a JSON file, returning fallback on missing/corrupt content.
 * @param {string} path
 * @param {unknown} fallback
 */
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Write one JSON file through a same-directory rename so a crash cannot leave
 * a half-written state file.
 * @param {string} path
 * @param {unknown} value
 */
function writeJsonAtomic(path, value, pretty = true) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * Read the last complete bus line without loading a large JSONL file twice.
 * @param {string} path
 * @returns {object|null}
 */
function readBusLastMessage(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text.length === 0) return null;
    const line = text.slice(text.lastIndexOf("\n") + 1);
    const parsed = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return null;
    return {
      id: typeof parsed.id === "string" ? parsed.id : null,
      ts: typeof parsed.ts === "string" ? parsed.ts : null,
      from: typeof parsed.from === "string" ? parsed.from : null,
      to: typeof parsed.to === "string" ? parsed.to : null,
      kind: typeof parsed.kind === "string" ? parsed.kind : null,
      thread: typeof parsed.thread === "string" ? parsed.thread : null,
      text: typeof parsed.text === "string" ? parsed.text.slice(0, 160) : "",
    };
  } catch {
    return null;
  }
}

/**
 * One gate instance for the whole process.
 */
export class DispatchGateRuntime {
  /**
   * @param {object} ctx Cordis context with agents, sessions, logger
   * @param {object} config validated config plus jobs with loaded prompts
   * @param {{createUserMessage:Function,execFileImpl?:Function}} dependencies
   */
  constructor(ctx, config, dependencies = {}) {
    if (typeof dependencies.createUserMessage !== "function") {
      throw new Error("DispatchGateRuntime requires a createUserMessage dependency");
    }
    this.createUserMessage = dependencies.createUserMessage;
    this.execFileImpl = dependencies.execFileImpl ?? execFile;
    this.ctx = ctx;
    this.config = {
      ...config,
      pollMs: normalizePollMs(config.pollMs),
      agentIds: config.agentIds ?? {},
      requireIdle: config.requireIdle ?? true,
      skipIfInboxPending: config.skipIfInboxPending ?? true,
    };

    this.stateDir = resolve(config.stateDir ?? join(dshHome(), "storages", "dispatch-gate"));
    this.statePath = join(this.stateDir, "state.json");
    this.lockPath = join(this.stateDir, "run.lock");
    this.absoluteStatusPath = join(this.stateDir, "status.json");
    const statusPath = config.statusPath ?? "logs/dispatch-gate/status.json";
    this.statusPath = isAbsolute(statusPath) ? statusPath : resolve(config.check?.cwd ?? process.cwd(), statusPath);
    const busLogPath = config.busLogPath ?? join(dshHome(), "storages", "agent-bus", "messages.jsonl");
    this.busLogPath = isAbsolute(busLogPath) ? busLogPath : resolve(busLogPath);
    this.project = typeof config.project === "string" && config.project.length > 0 ? config.project : "default";
    this.uiShowIn = Array.isArray(config.uiShowIn) ? config.uiShowIn : [];
    this.lastControl = null;
    const watchDir = config.watchDir ?? "plans/control";
    this.watchDir = isAbsolute(watchDir) ? watchDir : resolve(config.check?.cwd ?? process.cwd(), watchDir);
    this.mailboxDirs = (Array.isArray(config.mailboxDirs) ? config.mailboxDirs : ["plans/mailbox/codex"])
      .map((dir) => isAbsolute(dir) ? dir : resolve(config.check?.cwd ?? process.cwd(), dir));
    this.syncFiles = (Array.isArray(config.syncFiles) ? config.syncFiles : ["plans/control/SYNC.md"])
      .map((file) => isAbsolute(file) ? file : resolve(config.check?.cwd ?? process.cwd(), file));
    this.pendingMailboxNotice = null;
    this.toolGuardDispose = undefined;
    this.watchDebounceMs = Math.max(50, Number(config.watchDebounceMs ?? 300));
    this.busyRetryMs = Math.max(500, Number(config.busyRetryMs ?? 2000));
    this.maxConcurrentAgents = Math.max(1, Math.min(10, Number(config.maxConcurrentAgents ?? 1)));
    this.syncWakeCooldownMs = Math.max(0, Number(config.syncWakeCooldownMs ?? 30_000));
    this.dispatchCooldownMs = Math.max(0, Number(config.dispatchCooldownMs ?? 10_000));
    this.handoffSettleMs = Math.max(0, Number(config.handoffSettleMs ?? 3000));
    this.lastIdleAt = 0;
    this.lastIdleAgent = null;
    this.lastSyncWakeAt = 0;
    this.lastDispatchAt = 0;
    this.lastDispatchJobId = null;
    this.dispatchedThisTick = false;
    this.controlChangeRoles = Array.isArray(config.controlChangeRoles) ? config.controlChangeRoles : ["planner"];
    this.coordinatorAgent = config.coordinatorAgent ?? "planner";
    this.requireCoordinatorIdle = config.requireCoordinatorIdle !== false;
    this.workerRoles = Array.isArray(config.workerRoles) ? config.workerRoles : ["coding", "acceptance"];
    this.workerStates = Array.isArray(config.workerStates) ? config.workerStates : ["assigned_coding", "awaiting_verification"];
    this.peakScheduleEnabled = config.peakScheduleEnabled !== false;
    this.timePolicy = {
      timeZone: config.timeZone ?? "Asia/Shanghai",
      windows: Array.isArray(config.peakWindows) ? config.peakWindows : undefined,
      holidays: Array.isArray(config.holidays) ? config.holidays : undefined,
    };
    this.manualPaused = false;
    this.manualOverride = false;
    this.peakPaused = false;
    this.peakNow = false;
    this.pendingPlannerWake = false;
    this.forceNext = false;
    this.watchers = [];
    this.soonTimer = undefined;

    this.jobs = (config.jobs ?? []).map((job) => ({
      ...job,
      lastState: undefined,
      lastDispatchAt: 0,
      lastAttemptAt: 0,
      status: "idle",
      lastReason: undefined,
      wasRunning: false,
    }));
    this.logger = ctx.logger;
    this.timer = undefined;
    this.initialTimer = undefined;
    this.current = undefined;
    this.ticking = false;
    this.stopping = false;
    this.started = false;
    this.lastLog = new Map();

    this.paused = false;
    this.cleanShutdown = true;
    this.uncleanStart = false;
    this.lastState = undefined;
    this.lastTickAt = 0;
    this.lastTickResult = undefined;
    this.lastError = null;
  }

  /**
   * Apply the Beijing-time peak policy. Manual pause wins; manual resume is an
   * explicit override that keeps the gate running through a peak window.
   */
  applyTimePolicy(now = Date.now()) {
    const peak = this.peakScheduleEnabled ? isPeak(now, this.timePolicy) : false;
    this.peakNow = peak;
    if (this.manualPaused) {
      this.peakPaused = false;
      this.paused = true;
      return true;
    }
    if (this.manualOverride) {
      this.peakPaused = false;
      this.paused = false;
      return false;
    }
    this.peakPaused = peak;
    this.paused = peak;
    return peak;
  }

  /** Start the initial check and the fixed-rate deterministic poll. */
  start() {
    if (this.started) return;
    this.started = true;

    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(dirname(this.statusPath), { recursive: true });

    // A lock left by a previous process means that process did not reach
    // dispose(); start paused so a crash cannot silently replay a dispatch.
    this.uncleanStart = existsSync(this.lockPath);
    this.cleanShutdown = !this.uncleanStart;

    const saved = readJson(this.statePath, null);
    const savedPaused = Boolean(saved?.paused) || this.uncleanStart;
    this.manualPaused = saved?.manualPaused === undefined ? savedPaused : Boolean(saved.manualPaused);
    this.manualOverride = Boolean(saved?.manualOverride);
    this.peakPaused = false;
    this.applyTimePolicy(Date.now());
    if (saved && typeof saved === "object" && saved.jobs && typeof saved.jobs === "object") {
      for (const job of this.jobs) {
        const previous = saved.jobs[job.id];
        if (!previous || typeof previous !== "object") continue;
        if (typeof previous.lastState === "string") job.lastState = previous.lastState;
        if (Number.isFinite(previous.lastDispatchAt)) job.lastDispatchAt = previous.lastDispatchAt;
        if (Number.isFinite(previous.lastAttemptAt)) job.lastAttemptAt = previous.lastAttemptAt;
        if (typeof previous.status === "string") job.status = previous.status;
        if (typeof previous.lastReason === "string") job.lastReason = previous.lastReason;
      }
    }
    if (saved && typeof saved.lastState === "string") this.lastState = saved.lastState;

    // Mark this run before any timer can fire. A crash leaves it behind on
    // purpose; the next start sees it and begins paused.
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, startedAt: iso(Date.now()) }, null, 2));
    this.persistState();
    this.writeStatus();

    if (this.uncleanStart) {
      this.ctx.logger?.warn?.("dispatch-gate: previous run did not shut down cleanly; starting paused");
    }

    const initialDelayMs = Math.max(0, Number(this.config.initialDelayMs ?? 5000));
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.tickOnce().catch((error) => this.logThrottled("tick", `tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }, initialDelayMs);
    this.initialTimer.unref?.();
    this.timer = setInterval(() => {
      void this.tickOnce().catch((error) => this.logThrottled("tick", `tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.config.pollMs);
    this.timer.unref?.();
    this.startWatcher();
    this.installToolGuard();
  }

  /** Gate-managed role sessions may not create subagents or workflows. */
  installToolGuard() {
    const tools = this.ctx.tools;
    if (tools === undefined || tools === null || typeof tools.guard !== "function") {
      this.ctx.logger?.warn?.("dispatch-gate: tools.guard is unavailable; subagent restriction is not installed");
      return;
    }
    const blocked = new Set(["subagent", "subagent_fork", "workflow"]);
    this.toolGuardDispose = tools.guard((execution) => {
      const id = execution.agent?.id;
      if (id === undefined || !this.isManagedSessionId(id)) return undefined;
      if (blocked.has(execution.name)) {
        return "Subagents are disabled in gate-managed sessions. Use the configured coding/acceptance windows instead.";
      }
      return undefined;
    });
  }

  /** True when a session id is one of this gate's configured role sessions. */
  isManagedSessionId(id) {
    const aliases = this.readAliases();
    for (const job of this.jobs) {
      if (job.enabled === false) continue;
      if (resolveAgentId(aliases, this.config.agentIds, job.agent) === id) return true;
    }
    return false;
  }

  /** Watch control changes and Codex mailbox/review writes. */
  startWatcher() {
    const add = (dir, onEvent, label) => {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (this.stopping) return;
          if (typeof filename === "string" && (filename.endsWith(".tmp") || filename === ".lock")) return;
          onEvent(typeof filename === "string" ? filename : undefined);
        });
        watcher.on?.("error", (error) => {
          this.logThrottled(`watch:${label}`, `${label} watcher failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.watchers.push(watcher);
      } catch (error) {
        this.logThrottled(`watch:${label}`, `cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    add(this.watchDir, (filename) => {
      if (typeof filename === "string") {
        const full = resolve(this.watchDir, filename);
        if (this.syncFiles.includes(full)) {
          // SYNC.md is shared: planner writes it while running. Only treat a
          // change as an external Codex wake when the planner is idle, which
          // avoids a planner-write -> planner-wake loop.
          if (this.syncWakeCooldownMs > 0 && Date.now() - this.lastSyncWakeAt < this.syncWakeCooldownMs) return;
          const plannerId = resolveAgentId(this.readAliases(), this.config.agentIds, this.coordinatorAgent);
          const planner = plannerId === undefined ? undefined : this.ctx.agents.get(plannerId);
          if (planner?.status === "idle") {
            this.lastSyncWakeAt = Date.now();
            this.pendingPlannerWake = true;
            this.pendingMailboxNotice = full;
            this.scheduleSoon(this.watchDebounceMs, "codex_sync");
          }
          return;
        }
      }
      this.scheduleSoon(this.watchDebounceMs, "control_change");
    }, "control");
    for (const dir of this.mailboxDirs) {
      add(dir, (filename) => {
        // A Codex review/reply file is a planner wake source even when the
        // control state is unchanged, so it must not wait the 600s retry.
        this.pendingPlannerWake = true;
        this.pendingMailboxNotice = filename ? `${dir}/${filename}` : dir;
        this.scheduleSoon(this.watchDebounceMs, "codex_mailbox");
      }, "mailbox");
    }
  }

  /**
   * Schedule one near-immediate tick. Used by the control watcher and by a
   * role that is live but still busy, so a handoff does not wait 5/10 minutes.
   */
  scheduleSoon(delayMs, reason) {
    if (this.stopping || this.paused) return;
    if (this.soonTimer !== undefined) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined;
      const force = this.forceNext;
      this.forceNext = false;
      void this.tickOnce({ force }).catch((error) => this.logThrottled(`soon:${reason}`, `tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }, Math.max(50, Number(delayMs) || 300));
    this.soonTimer.unref?.();
  }

  /**
   * Run exactly one gate evaluation. Exposed for tests and manual diagnostics.
   * @returns {Promise<{ok:boolean,state?:string,results?:object[],error?:string,reason?:string,paused?:boolean}>}
   */
  async tickOnce(options = {}) {
    if (this.stopping) return { ok: false, reason: "stopping" };
    if (this.ticking) return { ok: false, reason: "overlap" };
    this.ticking = true;
    const run = this.runTick(options);
    this.current = run;
    try {
      return await run;
    } finally {
      this.ticking = false;
      if (this.current === run) this.current = undefined;
      this.lastTickAt = Date.now();
      this.persistState();
      this.writeStatus();
    }
  }

  /** A session is active while running, waiting, or holding queued inbox work. */
  isAgentActive(agent) {
    if (agent === undefined || agent === null) return false;
    if (agent.status === "offline") return false;
    if (agent.status === "running") return true;
    if (agent.inbox !== undefined && agent.inbox !== null && agent.inbox.hasPending) return true;
    return agent.status !== "idle";
  }

  /** Count gate-managed sessions that are active, excluding one job. */
  countActivePeers(excludeJobId, aliases) {
    let count = 0;
    for (const other of this.jobs) {
      if (other.id === excludeJobId || other.enabled === false) continue;
      const id = resolveAgentId(aliases, this.config.agentIds, other.agent);
      if (id === undefined) continue;
      if (this.isAgentActive(this.ctx.agents.get(id))) count += 1;
    }
    return count;
  }

  async runTick(options = {}) {
    this.applyTimePolicy(Date.now());
    if (this.paused) {
      this.lastTickResult = { ok: true, paused: true, reason: this.peakPaused ? "peak_hours" : "paused" };
      return this.lastTickResult;
    }

    const status = await this.readStatus();
    if (!status.ok) {
      this.lastError = status.error;
      this.lastTickResult = { ok: false, error: status.error };
      return this.lastTickResult;
    }

    this.lastError = null;
    this.lastState = status.state;
    this.lastControl = status.raw ?? null;
    this.dispatchedThisTick = false;
    const aliases = this.readAliases();
    const coordinatorId = resolveAgentId(aliases, this.config.agentIds, this.coordinatorAgent);
    const coordinator = coordinatorId === undefined ? undefined : this.ctx.agents.get(coordinatorId);
    const coordinatorBusy = this.requireCoordinatorIdle && coordinator?.status === "running";
    const now = Date.now();
    const results = [];
    let needsSoon = false;

    for (const job of this.jobs) {
      if (this.stopping) break;
      if (job.enabled === false) {
        job.status = "disabled";
        job.lastReason = "disabled";
        results.push({ job: job.id, dispatch: false, reason: "disabled" });
        continue;
      }

      const agentId = resolveAgentId(aliases, this.config.agentIds, job.agent);
      const agent = agentId === undefined ? undefined : this.ctx.agents.get(agentId);
      if (agent === undefined) {
        job.lastState = undefined;
        job.wasRunning = false;
        job.status = "offline";
        job.lastReason = "agent_offline";
        this.logThrottled(`offline:${job.id}`, `agent "${job.agent}" is not live; skipping ${job.id}`);
        results.push({ job: job.id, dispatch: false, reason: "agent_offline" });
        continue;
      }

      const isRunning = agent.status === "running";
      if (job.wasRunning === true && !isRunning) {
        this.lastIdleAt = now;
        this.lastIdleAgent = job.agent;
        if (this.workerRoles.includes(job.agent)) this.pendingPlannerWake = true;
      }
      job.wasRunning = isRunning;

      const stateChanged = job.lastState !== status.state;
      const inboxPending = agent.inbox !== undefined && agent.inbox !== null ? Boolean(agent.inbox.hasPending) : false;
      const activePeers = this.countActivePeers(job.id, aliases);
      const recentlyDispatched = this.lastDispatchAt > 0 && now - this.lastDispatchAt < this.dispatchCooldownMs;
      const localActive = this.dispatchedThisTick || (recentlyDispatched && this.lastDispatchJobId !== job.id) ? 1 : 0;
      const peerBusy = activePeers + localActive >= this.maxConcurrentAgents;
      const settling = this.handoffSettleMs > 0 && this.lastIdleAgent !== null
        && this.lastIdleAgent !== job.agent
        && now - this.lastIdleAt < this.handoffSettleMs;
      const decision = evaluateJob(job, {
        state: status.state,
        stateChanged,
        now,
        agentStatus: agent.status,
        inboxPending,
        requireIdle: this.config.requireIdle,
        skipIfInboxPending: this.config.skipIfInboxPending,
        coordinatorBusy: coordinatorBusy && job.agent !== this.coordinatorAgent,
        force: this.pendingPlannerWake && this.controlChangeRoles.includes(job.agent),
      });

      if (!decision.dispatch) {
        job.status = decision.reason;
        job.lastReason = decision.reason;
        if (decision.reason === "agent_busy" || decision.reason === "inbox_pending" || decision.reason === "coordinator_busy") {
          // Keep lastState stale so this allowed handoff is retried as soon as
          // the target becomes idle, instead of waiting retrySeconds.
          needsSoon = true;
        } else {
          job.lastState = status.state;
        }
        results.push({ job: job.id, dispatch: false, reason: decision.reason, state: status.state });
        continue;
      }

      if (settling) {
        job.status = "settle_wait";
        job.lastReason = "settle_wait";
        needsSoon = true;
        results.push({ job: job.id, dispatch: false, reason: "settle_wait", state: status.state });
        continue;
      }

      if (peerBusy) {
        job.status = "peer_busy";
        job.lastReason = "peer_busy";
        needsSoon = true;
        results.push({ job: job.id, dispatch: false, reason: "peer_busy", state: status.state, activePeers });
        continue;
      }

      job.lastState = status.state;
      job.status = "attempting";
      job.lastReason = decision.reason;
      job.lastAttemptAt = Date.now();
      this.persistState();
      this.writeStatus();

      try {
        await this.dispatch(job, agent, status.state);
        job.status = "sent";
        job.lastDispatchAt = Date.now();
        this.lastDispatchAt = job.lastDispatchAt;
        this.lastDispatchJobId = job.id;
        this.dispatchedThisTick = true;
        if (this.controlChangeRoles.includes(job.agent)) {
          this.pendingPlannerWake = false;
          this.pendingMailboxNotice = null;
        }
        results.push({ job: job.id, dispatch: true, reason: decision.reason, state: status.state, agent: agentId });
        this.ctx.logger?.info?.(`dispatch-gate: ${job.id} -> ${agentId} (${status.state}, ${decision.reason})`);
      } catch (error) {
        job.status = "failed";
        job.lastReason = "dispatch_failed";
        this.logThrottled(`dispatch:${job.id}`, `dispatch ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        results.push({ job: job.id, dispatch: false, reason: "dispatch_failed", error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.persistState();
        this.writeStatus();
      }
    }

    this.lastTickResult = { ok: true, state: status.state, results };
    if (needsSoon) this.scheduleSoon(this.busyRetryMs, "agent_busy");
    return this.lastTickResult;
  }

  async readStatus() {
    const check = this.config.check;
    if (check === undefined || !Array.isArray(check.command) || check.command.length === 0) {
      return { ok: false, error: "check.command must contain at least one argument" };
    }
    const command = check.command;
    const cwd = check.cwd ?? process.cwd();
    const file = command[0].includes("/") && !isAbsolute(command[0]) ? resolve(cwd, command[0]) : command[0];
    const timeoutMs = Number(check.timeoutMs ?? 15000);
    const result = await new Promise((resolvePromise) => {
      this.execFileImpl(file, command.slice(1), {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          resolvePromise({ ok: false, error: error.message, stderr: String(stderr ?? "") });
          return;
        }
        resolvePromise({ ok: true, stdout: String(stdout ?? "") });
      });
    });
    if (!result.ok) {
      this.logThrottled("status", `control status failed: ${result.error}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
      return { ok: false, error: result.error };
    }
    const parsed = parseControlStatus(result.stdout);
    if (!parsed.ok) {
      this.logThrottled("status", parsed.error);
      return { ok: false, error: parsed.error };
    }
    return parsed;
  }

  readAliases() {
    try {
      const parsed = JSON.parse(readFileSync(this.config.aliasStatePath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && parsed.aliases !== null && typeof parsed.aliases === "object") {
        return parsed.aliases;
      }
      return this.config.agentIds;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logThrottled("aliases", `cannot read alias state ${this.config.aliasStatePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.config.agentIds;
    }
  }

  /**
   * Current status snapshot for the composer and `/gate status`.
   * This never runs control.py; it reports the last observed tick.
   */
  statusSnapshot() {
    const aliases = this.readAliases();
    const peers = Object.entries(aliases).map(([alias, id]) => {
      const agent = typeof id === "string" ? this.ctx.agents.get(id) : undefined;
      return {
        alias,
        id: typeof id === "string" ? id : null,
        live: agent !== undefined,
        status: agent?.status ?? "offline",
      };
    });
    const jobs = this.jobs.map((job) => {
      const agentId = resolveAgentId(aliases, this.config.agentIds, job.agent);
      const agent = agentId === undefined ? undefined : this.ctx.agents.get(agentId);
      return {
        id: job.id,
        agent: job.agent,
        agentId: agentId ?? null,
        live: agent !== undefined,
        agentStatus: agent?.status ?? "offline",
        inboxPending: agent?.inbox ? Boolean(agent.inbox.hasPending) : false,
        lastState: job.lastState ?? null,
        lastDispatchAt: iso(job.lastDispatchAt),
        lastAttemptAt: iso(job.lastAttemptAt),
        status: job.status ?? "idle",
        lastReason: job.lastReason ?? null,
        retrySeconds: Number(job.retrySeconds ?? 0),
      };
    });

    return {
      v: 1,
      now: iso(Date.now()),
      running: !this.stopping,
      paused: Boolean(this.paused),
      cleanShutdown: Boolean(this.cleanShutdown),
      uncleanStart: Boolean(this.uncleanStart),
      peakScheduleEnabled: this.peakScheduleEnabled,
      peakNow: Boolean(this.peakNow),
      peakPaused: Boolean(this.peakPaused),
      manualPaused: Boolean(this.manualPaused),
      manualOverride: Boolean(this.manualOverride),
      peakWindow: this.peakScheduleEnabled ? describePeak(Date.now(), this.timePolicy) : null,
      pollMs: this.config.pollMs,
      lastTickAt: iso(this.lastTickAt),
      state: this.lastState ?? null,
      project: this.project,
      task: this.lastControl?.task ?? null,
      round: this.lastControl?.round ?? null,
      sequence: this.lastControl?.sequence ?? null,
      ui: { showIn: this.uiShowIn },
      lastError: this.lastError,
      lastTickResult: this.lastTickResult ?? null,
      jobs,
      bus: {
        aliases,
        peers,
        lastMessage: readBusLastMessage(this.busLogPath),
      },
    };
  }

  /** Persist the scheduler memory; called around every dispatch attempt. */
  persistState() {
    const jobs = {};
    for (const job of this.jobs) {
      jobs[job.id] = {
        lastState: job.lastState,
        lastDispatchAt: job.lastDispatchAt,
        lastAttemptAt: job.lastAttemptAt,
        status: job.status,
        lastReason: job.lastReason,
      };
    }
    const state = {
      v: 1,
      paused: Boolean(this.paused),
      manualPaused: Boolean(this.manualPaused),
      manualOverride: Boolean(this.manualOverride),
      peakPaused: Boolean(this.peakPaused),
      cleanShutdown: Boolean(this.cleanShutdown),
      lastState: this.lastState,
      updatedAt: iso(Date.now()),
      jobs,
    };
    try {
      writeJsonAtomic(this.statePath, state);
    } catch (error) {
      this.logThrottled("persist", `cannot write gate state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Write the read-only status snapshot consumed by the composer. */
  writeStatus() {
    try {
      const snapshot = this.statusSnapshot();
      const paths = [...new Set([this.statusPath, this.absoluteStatusPath])];
      for (const path of paths) {
        try {
          writeJsonAtomic(path, snapshot, false);
        } catch (error) {
          this.logThrottled("status-write", `cannot write gate status ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.logThrottled("status-write", `cannot build gate status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Pause automatic dispatch only; bus delivery and notifications are untouched.
   * @param {string} reason
   */
  pause(reason = "manual") {
    this.manualPaused = true;
    this.manualOverride = false;
    this.peakPaused = false;
    this.paused = true;
    this.lastTickResult = { ok: true, paused: true, reason: `paused:${reason}` };
    this.persistState();
    this.writeStatus();
    this.ctx.logger?.info?.(`dispatch-gate: paused (${reason})`);
    return { ok: true, paused: true };
  }

  /** Resume automatic dispatch and evaluate the current control state once. */
  resume() {
    this.manualPaused = false;
    this.manualOverride = false;
    this.peakPaused = false;
    this.applyTimePolicy(Date.now());
    this.uncleanStart = false;
    this.cleanShutdown = true;
    this.lastTickResult = { ok: true, paused: this.paused, reason: "resumed_auto" };
    this.persistState();
    this.writeStatus();
    this.ctx.logger?.info?.(`dispatch-gate: resumed auto (${this.peakPaused ? "peak paused" : "off-peak"})`);
    if (!this.paused) {
      void this.tickOnce().catch((error) => this.logThrottled("resume", `resume tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { ok: true, paused: this.paused, peakPaused: this.peakPaused };
  }

  /** Explicitly force-run through a peak window until pause/auto. */
  force() {
    this.manualPaused = false;
    this.manualOverride = true;
    this.peakPaused = false;
    this.paused = false;
    this.uncleanStart = false;
    this.cleanShutdown = true;
    this.lastTickResult = { ok: true, paused: false, reason: "forced" };
    this.persistState();
    this.writeStatus();
    this.ctx.logger?.info?.("dispatch-gate: forced through peak schedule");
    void this.tickOnce().catch((error) => this.logThrottled("force", `force tick failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: true, paused: false };
  }

  /** Drop manual override and follow the peak schedule again. */
  auto() {
    this.manualPaused = false;
    this.manualOverride = false;
    this.applyTimePolicy(Date.now());
    this.lastTickResult = { ok: true, paused: this.paused, reason: "auto_schedule" };
    this.persistState();
    this.writeStatus();
    if (!this.paused) {
      void this.tickOnce().catch((error) => this.logThrottled("auto", `auto tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { ok: true, paused: this.paused, peakPaused: this.peakPaused };
  }

  /**
   * Human command handler used by `/gate`.
   * @param {string} rawInput
   */
  /** One-line human status for `/gate status`; JSON stays available. */
  summaryText() {
    const snapshot = this.statusSnapshot();
    const last = snapshot.lastTickAt ? Date.parse(snapshot.lastTickAt) : NaN;
    const connected = Number.isFinite(last) && Date.now() - last <= Math.max(15_000, snapshot.pollMs * 3);
    const state = snapshot.paused ? "paused" : connected ? "running" : "stale";
    const agents = snapshot.jobs.map((job) => `${job.agent}=${job.agentStatus}`).join(", ");
    const mode = snapshot.manualPaused
      ? "manual-paused"
      : snapshot.manualOverride
        ? "manual-override"
        : snapshot.peakPaused
          ? "peak-paused"
          : "scheduled";
    return `gate: ${state} · ${connected ? "connected" : "not connected"} · ${mode} · peak=${snapshot.peakNow ? "yes" : "no"} · project=${snapshot.project} · control=${snapshot.state ?? "—"} · ${agents}`;
  }

  async handleCommand(rawInput) {
    const parts = String(rawInput ?? "").trim().split(/\s+/u).filter(Boolean);
    const action = parts[0] || "status";
    if (action === "status") {
      if (parts[1] === "json") return { kind: "success", text: JSON.stringify(this.statusSnapshot()) };
      return { kind: "success", text: this.summaryText() };
    }
    if (action === "pause") {
      this.pause("command");
      return { kind: "success", text: "dispatch-gate: paused" };
    }
    if (action === "resume") {
      this.resume();
      return { kind: "success", text: `dispatch-gate: resumed (${this.peakPaused ? "peak paused" : "off-peak"})` };
    }
    if (action === "force") {
      this.force();
      return { kind: "success", text: "dispatch-gate: forced through peak schedule" };
    }
    if (action === "auto") {
      this.auto();
      return { kind: "success", text: `dispatch-gate: auto schedule (${this.peakPaused ? "peak paused" : "off-peak"})` };
    }
    if (action === "tick") {
      const result = await this.tickOnce();
      return { kind: "success", text: JSON.stringify(result) };
    }
    return { kind: "error", text: "usage: /gate status [json] | pause | resume | force | auto | tick" };
  }

  async dispatch(job, agent, state) {
    const scope = {
      project: this.project,
      task: this.lastControl?.task,
      round: this.lastControl?.round,
      sequence: this.lastControl?.sequence,
      notice: job.agent === this.coordinatorAgent ? this.pendingMailboxNotice : undefined,
    };
    const message = this.createUserMessage({
      content: [{ type: "text", text: buildDispatchText(job, state, scope) }],
      source: buildSource(job, state, scope),
    });
    agent.followup(message);
    try {
      const flushed = await this.ctx.sessions.flush(agent.session);
      if (!flushed) this.logThrottled(`flush:${job.id}`, `session flush was not acknowledged for ${agent.id}`);
    } catch (error) {
      this.logThrottled(`flush:${job.id}`, `session flush failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logThrottled(key, message) {
    const now = Date.now();
    const last = this.lastLog.get(key) ?? 0;
    if (now - last < 60_000) return;
    this.lastLog.set(key, now);
    this.ctx.logger?.warn?.(`dispatch-gate: ${message}`);
  }

  async dispose() {
    this.stopping = true;
    this.started = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.initialTimer !== undefined) clearTimeout(this.initialTimer);
    if (this.soonTimer !== undefined) clearTimeout(this.soonTimer);
    this.timer = undefined;
    this.initialTimer = undefined;
    this.soonTimer = undefined;
    try {
      this.toolGuardDispose?.();
    } catch {
      // ignore guard disposal failure
    }
    this.toolGuardDispose = undefined;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore watcher close failure
      }
    }
    this.watchers = [];

    // The DSH shutdown budget is 5s. Never let a 15s control check keep the
    // process from stopping cleanly; a late tick is marked uncertain instead.
    await Promise.race([
      this.current?.catch(() => undefined),
      new Promise((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 2000);
        timer.unref?.();
      }),
    ]);

    this.cleanShutdown = true;
    this.persistState();
    this.writeStatus();
    try {
      rmSync(this.lockPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}
