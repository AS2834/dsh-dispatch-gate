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
  DEFAULT_WORKER_STATE_ROLES,
  buildDispatchText,
  buildSource,
  evaluateJob,
  findClaim,
  isCompletedClaim,
  normalizePollMs,
  parseControlStatus,
  resolveAgentId,
  workerRoleForState,
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
   * @param {{createUserMessage:Function,execFileImpl?:Function,random?:Function,acquireDispatch?:Function}} dependencies
   */
  constructor(ctx, config, dependencies = {}) {
    if (typeof dependencies.createUserMessage !== "function") {
      throw new Error("DispatchGateRuntime requires a createUserMessage dependency");
    }
    this.createUserMessage = dependencies.createUserMessage;
    this.execFileImpl = dependencies.execFileImpl ?? execFile;
    this.random = dependencies.random ?? Math.random;
    this.acquireDispatch = dependencies.acquireDispatch ?? (() => () => {});
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
    this.lastControl = null;
    const watchDir = config.watchDir ?? "plans/control";
    this.watchDir = isAbsolute(watchDir) ? watchDir : resolve(config.check?.cwd ?? process.cwd(), watchDir);
    this.mailboxDirs = (Array.isArray(config.mailboxDirs) ? config.mailboxDirs : ["plans/mailbox/astra"])
      .map((dir) => isAbsolute(dir) ? dir : resolve(config.check?.cwd ?? process.cwd(), dir));
    this.syncFiles = (Array.isArray(config.syncFiles) ? config.syncFiles : ["plans/control/SYNC.md"])
      .map((file) => isAbsolute(file) ? file : resolve(config.check?.cwd ?? process.cwd(), file));
    this.pendingMailboxNotice = null;
    this.toolGuardDispose = undefined;
    this.watchDebounceMs = Math.max(50, Number(config.watchDebounceMs ?? 300));
    this.busyRetryMs = Math.max(500, Number(config.busyRetryMs ?? 2000));
    this.offlineRecoveryEnabled = config.offlineRecoveryEnabled !== false;
    this.offlineRetryInitialDelayMs = Math.max(1000, Number(config.offlineRetryInitialDelayMs ?? 5000));
    this.offlineRetryMaxDelayMs = Math.max(
      this.offlineRetryInitialDelayMs,
      Number(config.offlineRetryMaxDelayMs ?? 300_000),
    );
    this.offlineRetryJitterRatio = Math.max(0, Math.min(1, Number(config.offlineRetryJitterRatio ?? 0.2)));
    this.offlineRecovery = new Map();
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
    this.coordinatorAgent = config.coordinatorAgent ?? "planner";
    this.controlChangeRoles = Array.isArray(config.controlChangeRoles) && config.controlChangeRoles.length > 0
      ? [...new Set(config.controlChangeRoles)]
      : [this.coordinatorAgent];
    this.requireCoordinatorIdle = config.requireCoordinatorIdle !== false;
    this.workerStateRoles = config.workerStateRoles !== null
      && typeof config.workerStateRoles === "object"
      && Object.keys(config.workerStateRoles).length > 0
      ? { ...config.workerStateRoles }
      : { ...DEFAULT_WORKER_STATE_ROLES };
    const mappedWorkerRoles = Object.values(this.workerStateRoles)
      .filter((role) => typeof role === "string" && role.length > 0);
    this.workerRoles = [...new Set([
      ...mappedWorkerRoles,
      ...(Array.isArray(config.workerRoles) ? config.workerRoles : []),
    ])];
    this.workerStates = Object.keys(this.workerStateRoles);
    this.uiShowIn = Array.isArray(config.uiShowIn) && config.uiShowIn.length > 0
      ? [...new Set(config.uiShowIn)]
      : [this.coordinatorAgent];
    this.pauseAllowsHandoff = config.pauseAllowsHandoff !== false;
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
    this.pauseSource = null;
    this.pendingPlannerWake = false;
    this.pendingPlannerWakeKind = null;
    this.pendingPlannerWakeAt = null;
    this.pendingPlannerWakeWorker = null;
    this.pendingPlannerWakeTask = null;
    this.pendingPlannerWakeRound = null;
    this.pendingPlannerWakeHandoff = null;
    this.handoffHandled = null;
    this.workerIncomplete = null;
    this.startupRecoveryPending = false;
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
      this.pauseSource = "manual";
      return true;
    }
    if (this.uncleanStart) {
      this.peakPaused = false;
      this.paused = true;
      this.pauseSource = "unclean";
      return true;
    }
    if (this.manualOverride) {
      this.peakPaused = false;
      this.paused = false;
      this.pauseSource = null;
      return false;
    }
    this.peakPaused = peak;
    this.paused = peak;
    this.pauseSource = peak ? "peak" : null;
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
    const legacyManualPause = saved?.manualPaused === undefined
      && saved?.pauseSource !== "peak"
      && saved?.pauseSource !== "unclean"
      && Boolean(saved?.paused);
    this.manualPaused = saved?.manualPaused === undefined ? legacyManualPause : Boolean(saved.manualPaused);
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
    if (saved?.offlineRecovery !== null && typeof saved?.offlineRecovery === "object") {
      for (const [sessionId, previous] of Object.entries(saved.offlineRecovery)) {
        if (previous === null || typeof previous !== "object") continue;
        this.offlineRecovery.set(sessionId, {
          status: previous.status === "recovering" ? "backoff" : String(previous.status ?? "backoff"),
          attempts: Number.isSafeInteger(previous.attempts) && previous.attempts >= 0 ? previous.attempts : 0,
          lastAttemptAt: Number.isFinite(previous.lastAttemptAt) ? previous.lastAttemptAt : 0,
          nextAttemptAt: Number.isFinite(previous.nextAttemptAt) ? previous.nextAttemptAt : 0,
          recoveredAt: Number.isFinite(previous.recoveredAt) ? previous.recoveredAt : 0,
          lastError: typeof previous.lastError === "string" ? previous.lastError : null,
        });
      }
    }

    // A worker completion that was persisted before a restart/pause must still
    // reach the planner. Restore the wake marker and its claim identity, then
    // let the first tick validate it against control.py before dispatching.
    this.pendingPlannerWake = saved?.pendingPlannerWake === true;
    this.pendingPlannerWakeKind = typeof saved?.pendingPlannerWakeKind === "string"
      ? saved.pendingPlannerWakeKind
      : this.pendingPlannerWake ? "persisted" : null;
    this.pendingPlannerWakeAt = typeof saved?.pendingPlannerWakeAt === "string" ? saved.pendingPlannerWakeAt : null;
    this.pendingPlannerWakeWorker = typeof saved?.pendingPlannerWakeWorker === "string" ? saved.pendingPlannerWakeWorker : null;
    this.pendingPlannerWakeTask = typeof saved?.pendingPlannerWakeTask === "string" ? saved.pendingPlannerWakeTask : null;
    this.pendingPlannerWakeRound = typeof saved?.pendingPlannerWakeRound === "string" ? saved.pendingPlannerWakeRound : null;
    this.pendingPlannerWakeHandoff = typeof saved?.pendingPlannerWakeHandoff === "string" ? saved.pendingPlannerWakeHandoff : null;
    this.handoffHandled = saved?.handoffHandled !== null && typeof saved?.handoffHandled === "object"
      ? saved.handoffHandled
      : null;
    this.workerIncomplete = saved?.workerIncomplete !== null && typeof saved?.workerIncomplete === "object"
      ? saved.workerIncomplete
      : null;
    // Check once after start even when no wake marker survived: a completed
    // claim with state still assigned/awaiting is exactly the missed handoff
    // this recovery exists for.
    this.startupRecoveryPending = true;

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

  /** Gate-managed role sessions may not create subagents or use grep-style search. */
  installToolGuard() {
    const tools = this.ctx.tools;
    if (tools === undefined || tools === null || typeof tools.guard !== "function") {
      this.ctx.logger?.warn?.("dispatch-gate: tools.guard is unavailable; subagent restriction is not installed");
      return;
    }
    const blocked = new Set(["subagent", "subagent_fork", "workflow", "grep", "rg"]);
    this.toolGuardDispose = tools.guard((execution) => {
      const id = execution.agent?.id;
      if (id === undefined || !this.isManagedSessionId(id)) return undefined;
      if (blocked.has(execution.name)) {
        return "Subagents and grep/rg search are disabled in gate-managed sessions. Use the configured Gate role windows and inspect code with the read tool.";
      }
      if (execution.name === "bash") {
        const command = typeof execution.arguments?.command === "string" ? execution.arguments.command : "";
        if (/(?:^|[\s;&|()])["']?(?:[^\s;&|()"']+\/)?(?:grep|rg)["']?(?=$|[\s;&|()])/u.test(command)) {
          return "grep/rg is disabled in gate-managed sessions; read code with the read tool.";
        }
      }
      return undefined;
    });
  }

  /** True when a session id is one of this gate's configured role sessions. */
  isManagedSessionId(id) {
    return this.rolesForSession(id).length > 0;
  }

  /** All enabled project roles currently bound to one exact session id. */
  rolesForSession(id, aliases = this.readAliases()) {
    if (typeof id !== "string" || id.length === 0) return [];
    const roles = [];
    for (const job of this.jobs) {
      if (job.enabled === false) continue;
      if (resolveAgentId(aliases, this.config.agentIds, job.agent) === id) roles.push(job.agent);
    }
    return [...new Set(roles)];
  }

  /** Whether this project's composer card is configured for this session. */
  isVisibleToSession(id, aliases = this.readAliases()) {
    return this.rolesForSession(id, aliases).some((role) => this.uiShowIn.includes(role));
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
    if (this.stopping) return;
    // Paused means "no new work", not "stop observing". A pending handoff, or
    // a worker that is still draining its turn, must still be checked.
    if (this.paused && !this.pendingPlannerWake && !this.hasRunningWorker()) return;
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

  /** True while a worker role is still draining an already-running turn. */
  hasRunningWorker() {
    const aliases = this.readAliases();
    for (const job of this.jobs) {
      if (job.enabled === false || !this.workerRoles.includes(job.agent)) continue;
      const id = resolveAgentId(aliases, this.config.agentIds, job.agent);
      if (id === undefined) continue;
      if (this.ctx.agents.get(id)?.status === "running") return true;
    }
    return false;
  }

  /** Configured live session id for one control role. */
  configuredRoleSession(role, aliases = this.readAliases()) {
    return resolveAgentId(aliases, this.config.agentIds, role);
  }

  /** A completed claim is valid only when it belongs to the configured role session. */
  isCompletedRoleClaim(status, role, claim = findClaim(status, role), aliases = this.readAliases()) {
    const expectedRoleSession = this.configuredRoleSession(role, aliases);
    return expectedRoleSession !== undefined && isCompletedClaim(claim, status, expectedRoleSession);
  }

  /** Return (and lazily create) durable recovery state for one configured session. */
  recoveryState(sessionId) {
    let state = this.offlineRecovery.get(sessionId);
    if (state === undefined) {
      state = {
        status: "offline",
        attempts: 0,
        lastAttemptAt: 0,
        nextAttemptAt: 0,
        recoveredAt: 0,
        lastError: null,
      };
      this.offlineRecovery.set(sessionId, state);
    }
    return state;
  }

  /** Exponential delay after a failed resume, including bounded symmetric jitter. */
  offlineRetryDelay(attempts) {
    const exponent = Math.max(0, Math.min(30, attempts - 1));
    const base = Math.min(this.offlineRetryMaxDelayMs, this.offlineRetryInitialDelayMs * (2 ** exponent));
    const jitter = 1 + ((this.random() * 2) - 1) * this.offlineRetryJitterRatio;
    return Math.max(1000, Math.round(base * jitter));
  }

  /** Bounded single-line diagnostic for a failed session recovery. */
  recoveryError(error) {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 500);
  }

  /** Status-safe view of one session's recovery state. */
  recoverySnapshot(sessionId) {
    if (sessionId === undefined) return null;
    const state = this.offlineRecovery.get(sessionId);
    if (state === undefined) return null;
    return {
      status: state.status,
      attempts: state.attempts,
      lastAttemptAt: iso(state.lastAttemptAt),
      nextAttemptAt: iso(state.nextAttemptAt),
      recoveredAt: iso(state.recoveredAt),
      lastError: state.lastError,
    };
  }

  /**
   * Resume each offline configured root once. The Session Controller owns the
   * resumed handle and restores the persisted agent preset. Failed attempts
   * use durable exponential backoff so process restarts cannot create a storm.
   */
  async recoverOfflineSessions(aliases, now = Date.now()) {
    const targets = new Map();
    for (const job of this.jobs) {
      if (job.enabled === false) continue;
      const sessionId = resolveAgentId(aliases, this.config.agentIds, job.agent);
      if (sessionId === undefined) continue;
      if (!targets.has(sessionId)) targets.set(sessionId, []);
      targets.get(sessionId).push(job.agent);
    }

    for (const [sessionId, roles] of targets) {
      if (this.ctx.agents.get(sessionId) !== undefined) {
        const previous = this.offlineRecovery.get(sessionId);
        if (previous !== undefined && previous.status !== "recovered") {
          previous.status = "online";
          previous.attempts = 0;
          previous.nextAttemptAt = 0;
          previous.lastError = null;
        }
        continue;
      }
      if (!this.offlineRecoveryEnabled) continue;

      const state = this.recoveryState(sessionId);
      if (state.nextAttemptAt > now) continue;
      if (typeof this.ctx.sessionController?.resolveAgent !== "function") {
        state.status = "unavailable";
        state.lastError = "sessionController.resolveAgent is unavailable";
        state.nextAttemptAt = now + this.offlineRetryMaxDelayMs;
        continue;
      }

      state.status = "recovering";
      state.lastAttemptAt = now;
      try {
        const agent = await this.ctx.sessionController.resolveAgent(sessionId);
        if (agent === undefined || agent.id !== sessionId) {
          throw new Error(`session controller returned the wrong agent for ${sessionId}`);
        }
        state.status = "recovered";
        state.attempts = 0;
        state.nextAttemptAt = 0;
        state.recoveredAt = Date.now();
        state.lastError = null;
        this.ctx.logger?.info?.(`dispatch-gate: recovered offline ${roles.join("/")} session ${sessionId}`);
      } catch (error) {
        // Another owner may have won the resume race. Treat the now-live
        // session as success instead of backing off a healthy agent.
        if (this.ctx.agents.get(sessionId) !== undefined) {
          state.status = "online";
          state.attempts = 0;
          state.nextAttemptAt = 0;
          state.recoveredAt = Date.now();
          state.lastError = null;
          continue;
        }
        state.attempts += 1;
        const delayMs = this.offlineRetryDelay(state.attempts);
        state.status = "backoff";
        state.nextAttemptAt = Date.now() + delayMs;
        state.lastError = this.recoveryError(error);
        this.logThrottled(
          `offline-recovery:${sessionId}`,
          `cannot recover ${roles.join("/")} session ${sessionId}; retry ${state.attempts} in ${delayMs}ms: ${state.lastError}`,
        );
      }
    }
  }

  async runTick(options = {}) {
    this.applyTimePolicy(Date.now());

    const status = await this.readStatus();
    if (!status.ok) {
      this.lastError = status.error;
      this.lastTickResult = { ok: false, error: status.error, paused: Boolean(this.paused) };
      return this.lastTickResult;
    }

    this.lastError = null;
    this.lastState = status.state;
    this.lastControl = status.raw ?? null;
    this.dispatchedThisTick = false;
    const aliases = this.readAliases();
    await this.recoverOfflineSessions(aliases, Date.now());
    const coordinatorId = resolveAgentId(aliases, this.config.agentIds, this.coordinatorAgent);
    const coordinator = coordinatorId === undefined ? undefined : this.ctx.agents.get(coordinatorId);
    const coordinatorBusy = this.requireCoordinatorIdle && coordinator?.status === "running";
    const now = Date.now();
    const results = [];
    let needsSoon = false;

    // A worker-incomplete marker only applies to the round that produced it.
    if (this.workerIncomplete !== null
        && (this.workerIncomplete.task !== (status.task_id ?? null)
            || this.workerIncomplete.round !== (status.round ?? null))) {
      this.workerIncomplete = null;
    }

    // Recover a missed completed-claim handoff before deciding anything. On
    // the first tick after start this runs even when a previous run already
    // marked the same handoff handled, so a restart cannot lose the wake.
    const startupRecovery = this.startupRecoveryPending === true;
    this.startupRecoveryPending = false;
    this.reconcileCompletedClaim(status, { startup: startupRecovery });

    // Observe running -> idle transitions once, before dispatching anything.
    // A completion found here (or recovered above) is available to the
    // planner job later in the same tick.
    const observed = new Map();
    let runningWorker = false;
    for (const job of this.jobs) {
      const agentId = resolveAgentId(aliases, this.config.agentIds, job.agent);
      const agent = agentId === undefined ? undefined : this.ctx.agents.get(agentId);
      const isRunning = agent?.status === "running";
      if (isRunning && this.workerRoles.includes(job.agent)) runningWorker = true;
      if (job.enabled !== false && agent !== undefined) {
        if (job.wasRunning === true && !isRunning) {
          this.lastIdleAt = now;
          this.lastIdleAgent = job.agent;
          this.recordWorkerIdle(job, status);
        } else if (job.wasRunning !== true && isRunning
            && this.workerRoles.includes(job.agent)
            && this.workerIncomplete?.job === job.id) {
          // A fresh worker run supersedes an earlier incomplete marker.
          this.workerIncomplete = null;
        }
      }
      job.wasRunning = agent === undefined ? false : isRunning;
      observed.set(job.id, { agentId, agent });
    }

    // Do not let a stale persisted worker wake call the planner while the
    // current claim is incomplete or belongs to a previous task/round.
    this.validatePendingWake(status);

    // Pause only stops new work. A validated worker-completion handoff may
    // still wake the coordinator (once) so the finished turn is not dropped.
    const pausedHandoff = this.paused ? this.pausedHandoffReady(status) : false;
    // Drain an already-running turn promptly instead of waiting pollMs.
    if (this.paused && runningWorker) needsSoon = true;

    for (const job of this.jobs) {
      if (this.stopping) break;
      if (job.enabled === false) {
        job.status = "disabled";
        job.lastReason = "disabled";
        results.push({ job: job.id, dispatch: false, reason: "disabled" });
        continue;
      }

      const { agentId, agent } = observed.get(job.id) ?? {};
      if (agent === undefined) {
        job.wasRunning = false;
        const recovery = this.recoverySnapshot(agentId);
        const reason = recovery?.status === "backoff"
          ? "agent_recovery_backoff"
          : recovery?.status === "unavailable"
            ? "agent_recovery_unavailable"
            : agentId === undefined
              ? "agent_unresolved"
              : "agent_offline";
        job.status = reason;
        job.lastReason = reason;
        this.logThrottled(`offline:${job.id}`, `agent "${job.agent}" is not live; skipping ${job.id}`);
        results.push({ job: job.id, dispatch: false, reason, recovery });
        continue;
      }

      const isCoordinatorJob = this.controlChangeRoles.includes(job.agent);
      const allowWhilePaused = this.paused && pausedHandoff && isCoordinatorJob;
      if (this.paused && !allowWhilePaused) {
        job.status = "paused";
        job.lastReason = "paused";
        results.push({ job: job.id, dispatch: false, reason: "paused", state: status.state });
        continue;
      }

      // A completed worker claim means the worker already did this round; the
      // next action belongs to the planner, not another worker dispatch.
      if (this.workerRoles.includes(job.agent)
          && workerRoleForState(status.state, this.workerStateRoles) === job.agent
          && this.isCompletedRoleClaim(status, job.agent, findClaim(status, job.agent), aliases)) {
        job.status = "handoff_pending";
        job.lastReason = "claim_completed";
        results.push({ job: job.id, dispatch: false, reason: "claim_completed", state: status.state });
        continue;
      }

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
        force: (this.pendingPlannerWake && isCoordinatorJob) || allowWhilePaused,
      });

      if (!decision.dispatch) {
        const incompleteHere = this.workerIncomplete?.job === job.id
          && this.workerIncomplete.task === (status.task_id ?? null)
          && this.workerIncomplete.round === (status.round ?? null);
        const reason = incompleteHere ? "worker_incomplete" : decision.reason;
        job.status = reason;
        job.lastReason = reason;
        if (decision.reason === "agent_busy" || decision.reason === "inbox_pending" || decision.reason === "coordinator_busy") {
          // Keep lastState stale so this allowed handoff is retried as soon as
          // the target becomes idle, instead of waiting retrySeconds.
          needsSoon = true;
        } else if (this.paused && isCoordinatorJob && this.pendingPlannerWake) {
          needsSoon = true;
        } else {
          job.lastState = status.state;
        }
        results.push({ job: job.id, dispatch: false, reason, state: status.state });
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

      const releaseDispatch = this.acquireDispatch(agentId, this.project, job.id);
      if (typeof releaseDispatch !== "function") {
        job.status = "session_reserved";
        job.lastReason = "session_reserved";
        needsSoon = true;
        results.push({ job: job.id, dispatch: false, reason: "session_reserved", state: status.state });
        continue;
      }

      const dispatchedWake = this.pendingPlannerWake && isCoordinatorJob;
      const wake = {
        role: this.pendingPlannerWakeWorker,
        task: this.pendingPlannerWakeTask,
        round: this.pendingPlannerWakeRound,
        handoff: this.pendingPlannerWakeHandoff,
      };
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
        if (this.workerIncomplete?.job === job.id) this.workerIncomplete = null;
        if (isCoordinatorJob) {
          if (wake.role !== null && wake.handoff !== null) {
            this.handoffHandled = {
              signature: this.handoffSignature(
                { task_id: wake.task, round: wake.round },
                wake.role,
                wake.handoff,
              ),
              task: wake.task,
              round: wake.round,
              role: wake.role,
              handoff: wake.handoff,
              at: iso(Date.now()),
            };
          }
          this.pendingPlannerWake = false;
          this.pendingPlannerWakeKind = null;
          this.pendingPlannerWakeAt = null;
          this.pendingPlannerWakeWorker = null;
          this.pendingPlannerWakeTask = null;
          this.pendingPlannerWakeRound = null;
          this.pendingPlannerWakeHandoff = null;
          this.pendingMailboxNotice = null;
          if (dispatchedWake) this.workerIncomplete = null;
        }
        results.push({ job: job.id, dispatch: true, reason: decision.reason, state: status.state, agent: agentId });
        this.ctx.logger?.info?.(`dispatch-gate: ${job.id} -> ${agentId} (${status.state}, ${decision.reason})`);
      } catch (error) {
        job.status = "failed";
        job.lastReason = "dispatch_failed";
        this.logThrottled(`dispatch:${job.id}`, `dispatch ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        results.push({ job: job.id, dispatch: false, reason: "dispatch_failed", error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseDispatch();
        this.persistState();
        this.writeStatus();
      }
    }

    this.lastTickResult = { ok: true, state: status.state, paused: Boolean(this.paused), results };
    if (needsSoon) {
      this.scheduleSoon(this.busyRetryMs, this.paused
        ? runningWorker ? "pause_drain" : "paused_handoff"
        : "agent_busy");
    }
    return this.lastTickResult;
  }

  /** Stable identity for one completed-claim handoff. */
  handoffSignature(status, role, handoff) {
    const raw = typeof handoff === "string"
      ? handoff
      : handoff !== null && typeof handoff === "object" && typeof handoff.handoff_sha256 === "string"
        ? handoff.handoff_sha256
        : "";
    return `${status?.task_id ?? ""}|${status?.round ?? ""}|${role ?? ""}|${raw.trim().toLowerCase()}`;
  }

  /** True when this exact completed claim was already handed to the planner. */
  handoffAlreadyHandled(status, role, claim) {
    return this.handoffHandled !== null
      && this.handoffHandled !== undefined
      && this.handoffHandled.signature === this.handoffSignature(status, role, claim?.handoff_sha256);
  }

  /** True when the persisted wake already names this exact worker completion. */
  pendingWakeMatches(status, role, claim) {
    if (!this.pendingPlannerWake) return false;
    return this.pendingPlannerWakeWorker === role
      && this.pendingPlannerWakeTask === (status.task_id ?? null)
      && this.pendingPlannerWakeRound === (status.round ?? null)
      && this.handoffSignature(status, role, this.pendingPlannerWakeHandoff)
        === this.handoffSignature(status, role, claim?.handoff_sha256);
  }

  /** Persist a planner wake with enough identity to survive restart/pause. */
  setPendingPlannerWake(kind, details = {}) {
    const same = this.pendingWakeMatches(
      {
        task_id: details.task !== undefined ? details.task : this.pendingPlannerWakeTask,
        round: details.round !== undefined ? details.round : this.pendingPlannerWakeRound,
      },
      details.worker !== undefined ? details.worker : this.pendingPlannerWakeWorker,
      { handoff_sha256: details.handoff !== undefined ? details.handoff : this.pendingPlannerWakeHandoff },
    ) && this.pendingPlannerWakeKind === kind;
    this.pendingPlannerWake = true;
    this.pendingPlannerWakeKind = kind;
    this.pendingPlannerWakeAt = iso(Date.now());
    if (details.worker !== undefined) this.pendingPlannerWakeWorker = details.worker ?? null;
    if (details.task !== undefined) this.pendingPlannerWakeTask = details.task ?? null;
    if (details.round !== undefined) this.pendingPlannerWakeRound = details.round ?? null;
    if (details.handoff !== undefined) this.pendingPlannerWakeHandoff = details.handoff ?? null;
    this.persistState();
    this.writeStatus();
    if (!same) {
      this.ctx.logger?.info?.(
        `dispatch-gate: planner wake pending (${kind}${this.pendingPlannerWakeWorker ? `, ${this.pendingPlannerWakeWorker}` : ""}${this.pendingPlannerWakeTask ? ` ${this.pendingPlannerWakeTask}/${this.pendingPlannerWakeRound}` : ""})`,
      );
    }
  }

  /** Drop the planner wake marker and its claim identity. */
  clearPendingPlannerWake() {
    const wasPending = this.pendingPlannerWake;
    this.pendingPlannerWake = false;
    this.pendingPlannerWakeKind = null;
    this.pendingPlannerWakeAt = null;
    this.pendingPlannerWakeWorker = null;
    this.pendingPlannerWakeTask = null;
    this.pendingPlannerWakeRound = null;
    this.pendingPlannerWakeHandoff = null;
    if (wasPending) {
      this.persistState();
      this.writeStatus();
    }
  }

  /** A worker went idle without a completed claim: never wake the planner. */
  markWorkerIncomplete(job, status, claim) {
    job.status = "worker_incomplete";
    job.lastReason = "worker_incomplete";
    // Do not immediately redispatch the same failed round: wait for the
    // normal retry window while keeping the incomplete marker visible.
    job.lastState = status.state;
    job.lastDispatchAt = Date.now();
    this.workerIncomplete = {
      job: job.id,
      role: job.agent,
      task: status.task_id ?? null,
      round: status.round ?? null,
      claimStatus: typeof claim?.status === "string" ? claim.status : "missing",
      at: iso(Date.now()),
    };
    if (this.pendingPlannerWake
        && this.pendingPlannerWakeWorker === job.agent
        && this.pendingPlannerWakeTask === (status.task_id ?? null)
        && this.pendingPlannerWakeRound === (status.round ?? null)) {
      this.clearPendingPlannerWake();
    }
    this.persistState();
    this.writeStatus();
    this.logThrottled(
      `worker_incomplete:${job.id}`,
      `${job.agent} went idle but its ${status.task_id ?? "?"}/${status.round ?? "?"} claim is ${this.workerIncomplete.claimStatus}, not completed; planner not woken`,
    );
  }

  /** Validate the claim behind a running -> idle transition. */
  recordWorkerIdle(job, status) {
    if (!this.workerRoles.includes(job.agent)) return;
    const claim = findClaim(status, job.agent);
    if (!this.isCompletedRoleClaim(status, job.agent, claim)) {
      this.markWorkerIncomplete(job, status, claim);
      return;
    }
    this.workerIncomplete = null;
    job.status = "handoff_pending";
    job.lastReason = "worker_completed";
    const signature = this.handoffSignature(status, job.agent, claim);
    if (!this.pendingWakeMatches(status, job.agent, claim) && this.handoffHandled?.signature !== signature) {
      this.setPendingPlannerWake("worker_completed", {
        worker: job.agent,
        task: status.task_id ?? null,
        round: status.round ?? null,
        handoff: claim.handoff_sha256,
      });
      this.ctx.logger?.info?.(
        `dispatch-gate: ${job.agent} completed ${status.task_id}/${status.round}; planner handoff pending`,
      );
    }
    this.persistState();
    this.writeStatus();
  }

  /**
   * Detect a completed claim even if no idle transition was observed, such as
   * after a restart or while paused. This is the startup recovery path.
   */
  reconcileCompletedClaim(status, { startup = false } = {}) {
    const role = workerRoleForState(status.state, this.workerStateRoles);
    if (role === null) return null;
    const claim = findClaim(status, role);
    if (!this.isCompletedRoleClaim(status, role, claim)) return null;
    const signature = this.handoffSignature(status, role, claim);
    const handled = this.handoffAlreadyHandled(status, role, claim);
    if ((startup || !handled) && !this.pendingWakeMatches(status, role, claim)) {
      this.setPendingPlannerWake("worker_completed", {
        worker: role,
        task: status.task_id ?? null,
        round: status.round ?? null,
        handoff: claim.handoff_sha256,
      });
      this.ctx.logger?.info?.(
        `dispatch-gate: recovered completed ${role} claim ${status.task_id}/${status.round}; planner handoff pending`,
      );
    }
    this.workerIncomplete = null;
    const job = this.jobs.find((candidate) => candidate.agent === role && candidate.enabled !== false);
    if (job !== undefined && job.status !== "attempting" && job.status !== "sent") {
      job.status = "handoff_pending";
      job.lastReason = "worker_completed";
    }
    return { role, claim, signature };
  }

  /** While paused, only a validated worker handoff may wake the coordinator. */
  pausedHandoffReady(status) {
    if (!this.pendingPlannerWake) return false;
    if (this.pauseSource !== "peak" && !this.pauseAllowsHandoff) return false;
    const role = this.pendingPlannerWakeWorker ?? workerRoleForState(status.state, this.workerStateRoles);
    if (role === null || role === undefined) return false;
    if (this.pendingPlannerWakeTask !== null && status.task_id !== this.pendingPlannerWakeTask) return false;
    if (this.pendingPlannerWakeRound !== null && status.round !== this.pendingPlannerWakeRound) return false;
    return this.isCompletedRoleClaim(status, role);
  }

  /**
   * A persisted worker wake is only actionable while its claim is still
   * completed for the same task/round. Mailbox/control wakes have no worker
   * identity and are left alone.
   */
  validatePendingWake(status) {
    if (!this.pendingPlannerWake || this.pendingPlannerWakeWorker === null) return;
    const role = this.pendingPlannerWakeWorker;
    const sameTask = this.pendingPlannerWakeTask === null || this.pendingPlannerWakeTask === (status.task_id ?? null);
    const sameRound = this.pendingPlannerWakeRound === null || this.pendingPlannerWakeRound === (status.round ?? null);
    if (!sameTask || !sameRound) {
      this.clearPendingPlannerWake();
      return;
    }
    const claim = findClaim(status, role);
    if (this.isCompletedRoleClaim(status, role, claim)) return;
    const job = this.jobs.find((candidate) => candidate.agent === role && candidate.enabled !== false);
    if (job === undefined) {
      this.clearPendingPlannerWake();
      return;
    }
    this.markWorkerIncomplete(job, status, claim);
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
    // Keep the full control payload (task/round/claims/paused) at the top
    // level: claim validation needs the mailbox records, not just `state`.
    return { ...parsed.raw, ok: true, state: parsed.state, raw: parsed.raw };
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
        recovery: this.recoverySnapshot(agentId),
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
      pauseSource: this.pauseSource,
      manualPaused: Boolean(this.manualPaused),
      manualOverride: Boolean(this.manualOverride),
      pendingPlannerWake: Boolean(this.pendingPlannerWake),
      pendingPlannerWakeDetail: this.pendingPlannerWake ? {
        kind: this.pendingPlannerWakeKind,
        at: this.pendingPlannerWakeAt,
        worker: this.pendingPlannerWakeWorker,
        task: this.pendingPlannerWakeTask,
        round: this.pendingPlannerWakeRound,
        handoff: this.pendingPlannerWakeHandoff,
      } : null,
      workerIncomplete: this.workerIncomplete ?? null,
      peakWindow: this.peakScheduleEnabled ? describePeak(Date.now(), this.timePolicy) : null,
      pollMs: this.config.pollMs,
      lastTickAt: iso(this.lastTickAt),
      state: this.lastState ?? null,
      project: this.project,
      task: this.lastControl?.task_id ?? this.lastControl?.task ?? null,
      round: this.lastControl?.round ?? null,
      sequence: this.lastControl?.sequence ?? null,
      ui: { showIn: this.uiShowIn },
      lastError: this.lastError,
      lastTickResult: this.lastTickResult ?? null,
      offlineRecovery: {
        enabled: this.offlineRecoveryEnabled,
        initialDelayMs: this.offlineRetryInitialDelayMs,
        maxDelayMs: this.offlineRetryMaxDelayMs,
        jitterRatio: this.offlineRetryJitterRatio,
      },
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
    const offlineRecovery = {};
    for (const [sessionId, recovery] of this.offlineRecovery) {
      offlineRecovery[sessionId] = { ...recovery };
    }
    const state = {
      v: 1,
      paused: Boolean(this.paused),
      manualPaused: Boolean(this.manualPaused),
      manualOverride: Boolean(this.manualOverride),
      peakPaused: Boolean(this.peakPaused),
      pauseSource: this.pauseSource,
      cleanShutdown: Boolean(this.cleanShutdown),
      lastState: this.lastState,
      pendingPlannerWake: Boolean(this.pendingPlannerWake),
      pendingPlannerWakeKind: this.pendingPlannerWakeKind,
      pendingPlannerWakeAt: this.pendingPlannerWakeAt,
      pendingPlannerWakeWorker: this.pendingPlannerWakeWorker,
      pendingPlannerWakeTask: this.pendingPlannerWakeTask,
      pendingPlannerWakeRound: this.pendingPlannerWakeRound,
      pendingPlannerWakeHandoff: this.pendingPlannerWakeHandoff,
      handoffHandled: this.handoffHandled,
      workerIncomplete: this.workerIncomplete,
      offlineRecovery,
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
   * Pause new automatic work. Already-running turns are not killed; a worker
   * that finishes with a completed claim may still hand off to the planner.
   * @param {string} reason
   */
  pause(reason = "manual") {
    this.manualPaused = true;
    this.manualOverride = false;
    this.peakPaused = false;
    this.paused = true;
    this.pauseSource = "manual";
    this.lastTickResult = { ok: true, paused: true, reason: `paused:${reason}` };
    this.persistState();
    this.writeStatus();
    this.ctx.logger?.info?.(`dispatch-gate: paused (${reason})`);
    // If a turn is already in flight or a handoff is pending, check it soon
    // so pause drains that turn instead of waiting for the next poll.
    this.scheduleSoon(this.busyRetryMs, "pause_drain");
    return { ok: true, paused: true };
  }

  /** Resume automatic dispatch and evaluate the current control state once. */
  resume() {
    this.manualPaused = false;
    this.manualOverride = false;
    this.peakPaused = false;
    this.uncleanStart = false;
    this.applyTimePolicy(Date.now());
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
    this.pauseSource = null;
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
    const mode = snapshot.paused
      ? `${snapshot.pauseSource ?? "unknown"}-paused`
      : snapshot.manualOverride
        ? "manual-override"
        : "scheduled";
    const handoff = snapshot.pendingPlannerWake
      ? ` · handoff=${snapshot.pendingPlannerWakeDetail?.worker ?? "pending"}`
      : snapshot.workerIncomplete
        ? ` · worker_incomplete=${snapshot.workerIncomplete.job}`
        : "";
    return `gate: ${state} · ${connected ? "connected" : "not connected"} · ${mode}${handoff} · peak=${snapshot.peakNow ? "yes" : "no"} · project=${snapshot.project} · control=${snapshot.state ?? "—"} · ${agents}`;
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
