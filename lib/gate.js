/**
 * Pure dispatch-gate rules: state allowlists, idle gating, retry windows, and
 * model-facing framing. No filesystem or Cordis imports live here.
 */

/** Producer-owned source kind for gate-delivered prompts. */
export const DISPATCH_SOURCE_KIND = "dispatch-gate";

/**
 * Control states that mean "a worker is responsible for this round" and the
 * role whose completed claim is the handoff signal for the planner.
 * Override with Config.workerStateRoles when a project uses other names.
 */
export const DEFAULT_WORKER_STATE_ROLES = Object.freeze({
  assigned_coding: "coding",
  awaiting_verification: "acceptance",
});

/**
 * Decide whether one job may dispatch now.
 * @param {object} job normalized job with states, retrySeconds, lastDispatchAt
 * @param {object} input current state and observed agent facts
 * @returns {{dispatch:boolean,reason:string,stateChanged:boolean}}
 */
export function evaluateJob(job, {
  state,
  stateChanged,
  now,
  agentStatus,
  inboxPending,
  requireIdle = true,
  skipIfInboxPending = true,
  coordinatorBusy = false,
  force = false,
}) {
  if (job.enabled === false) return { dispatch: false, reason: "disabled", stateChanged };
  if (!Array.isArray(job.states) || !job.states.includes(state)) {
    return { dispatch: false, reason: "state_not_allowed", stateChanged };
  }
  if (requireIdle && agentStatus !== "idle") {
    return { dispatch: false, reason: "agent_busy", stateChanged };
  }
  if (skipIfInboxPending && inboxPending) {
    return { dispatch: false, reason: "inbox_pending", stateChanged };
  }
  if (coordinatorBusy) return { dispatch: false, reason: "coordinator_busy", stateChanged };
  if (force) return { dispatch: true, reason: "control_changed", stateChanged };
  if (Array.isArray(job.controlOnlyStates) && job.controlOnlyStates.includes(state)) {
    return { dispatch: false, reason: "wait_for_control_change", stateChanged };
  }
  if (stateChanged) return { dispatch: true, reason: "state_changed", stateChanged };
  const retryMs = Math.max(0, Number(job.retrySeconds ?? 0)) * 1000;
  const lastDispatchAt = Number(job.lastDispatchAt ?? 0);
  if (retryMs > 0 && now - lastDispatchAt >= retryMs) {
    return { dispatch: true, reason: "retry_due", stateChanged };
  }
  return { dispatch: false, reason: "state_unchanged", stateChanged };
}

/**
 * Build the model-visible gate framing. The task prompt is appended verbatim.
 * Only the stable project id is in the framing; task/round/sequence are read by
 * the prompt from control.py on every tick, so they never need a config edit.
 * @param {object} job job with id and prompt
 * @param {string} state current control state
 * @param {{project?:string}} [scope]
 * @returns {string}
 */
export function buildDispatchText(job, state, scope = {}) {
  const lines = [
    "[DISPATCH GATE]",
    `Automated control-plane tick for ${job.id}. Current control state: ${state}.`,
  ];
  if (scope.project) lines.push(`Project: ${scope.project}.`);
  if (scope.notice) lines.push(`Codex review updated: ${scope.notice}. Read it before acting.`);
  lines.push("This is not a user instruction. Follow the task prompt below; it remains advisory automation.", "", job.prompt);
  return lines.join("\n");
}

/**
 * Build the producer-owned source object for a gate delivery.
 * @param {object} job job with id
 * @param {string} state current control state
 * @param {{project?:string}} [scope]
 * @returns {object}
 */
export function buildSource(job, state, scope = {}) {
  return {
    kind: DISPATCH_SOURCE_KIND,
    form: "notice",
    summary: `Dispatch gate tick ${job.id}${scope.project ? ` [${scope.project}]` : ""} (${state})`,
    producer: "dsh-dispatch-gate",
  };
}

/**
 * Parse `control.py status --json` output.
 * @param {string} stdout process stdout
 * @returns {{ok:true,state:string,raw:object}|{ok:false,error:string}}
 */
export function parseControlStatus(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, error: `control status is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "control status must be a JSON object" };
  }
  if (typeof parsed.state !== "string" || parsed.state.length === 0) {
    return { ok: false, error: "control status.state must be a non-empty string" };
  }
  return { ok: true, state: parsed.state, raw: parsed };
}

/**
 * Resolve a job's role alias to a live session id.
 * @param {Record<string,string>} aliases durable role aliases from the bus
 * @param {Record<string,string>} agentIds explicit role -> session id overrides
 * @param {string} role job role
 * @returns {string|undefined}
 */
export function resolveAgentId(aliases, agentIds, role) {
  if (agentIds && typeof agentIds[role] === "string" && agentIds[role].length > 0) return agentIds[role];
  if (aliases && typeof aliases[role] === "string" && aliases[role].length > 0) return aliases[role];
  if (/^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(role)) return role;
  return undefined;
}

/**
 * Resolve the worker role that owns the current control state.
 * @param {string} state control state
 * @param {Record<string,string>} [map] state -> role
 * @returns {string|null}
 */
export function workerRoleForState(state, map = DEFAULT_WORKER_STATE_ROLES) {
  if (typeof state !== "string" || state.length === 0) return null;
  if (map === null || typeof map !== "object") return null;
  const role = map[state];
  return typeof role === "string" && role.length > 0 ? role : null;
}

/**
 * Find the claim file record for one role in the active task/round.
 * control.py status --json already returns all mailbox claims in `claims`.
 * @param {object} status parsed control status
 * @param {string} role worker role
 * @returns {object|null}
 */
export function findClaim(status, role) {
  if (status === null || typeof status !== "object" || typeof role !== "string") return null;
  if (!Array.isArray(status.claims)) return null;
  const task = typeof status.task_id === "string" ? status.task_id : null;
  const round = typeof status.round === "string" ? status.round : null;
  if (task === null || round === null) return null;
  return status.claims.find((claim) => claim !== null
    && typeof claim === "object"
    && claim.role === role
    && claim.task === task
    && claim.round === round) ?? null;
}

/**
 * A claim only counts as a handoff when it is finished, complete, and bound to
 * the current state's handoff hash. This mirrors control.py's
 * require_completed_claim() without writing anything.
 * @param {object|null} claim claim record
 * @param {object} status parsed control status
 * @param {string} [expectedRoleSession] configured session id for the role
 * @returns {boolean}
 */
export function isCompletedClaim(claim, status, expectedRoleSession) {
  if (claim === null || typeof claim !== "object") return false;
  if (claim.status !== "completed") return false;
  if (typeof claim.claim_token !== "string" || claim.claim_token.length === 0) return false;
  if (typeof claim.role_session !== "string" || claim.role_session.length === 0) return false;
  if (expectedRoleSession !== undefined && claim.role_session !== expectedRoleSession) return false;
  if (typeof claim.finished_at !== "string" || claim.finished_at.length === 0) return false;
  const expectedHandoff = status !== null && typeof status === "object" && typeof status.handoff_sha256 === "string"
    ? status.handoff_sha256.trim().toLowerCase()
    : "";
  const claimHandoff = typeof claim.handoff_sha256 === "string" ? claim.handoff_sha256.trim().toLowerCase() : "";
  return expectedHandoff.length > 0 && claimHandoff.length > 0 && claimHandoff === expectedHandoff;
}

/**
 * Return the completed worker claim that should wake the coordinator, if any.
 * @param {object} status parsed control status
 * @param {Record<string,string>} [map] state -> role
 * @param {Record<string,string>} [roleSessions] role -> configured session id
 * @returns {{role:string,claim:object}|null}
 */
export function completedWorkerClaim(status, map = DEFAULT_WORKER_STATE_ROLES, roleSessions = {}) {
  const role = workerRoleForState(status?.state, map);
  if (role === null) return null;
  const expectedRoleSession = roleSessions?.[role];
  if (typeof expectedRoleSession !== "string" || expectedRoleSession.length === 0) return null;
  const claim = findClaim(status, role);
  return isCompletedClaim(claim, status, expectedRoleSession) ? { role, claim } : null;
}

/** @returns {number} normalized poll interval */
export function normalizePollMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 10000;
  return Math.max(1000, Math.min(60000, Math.floor(number)));
}
