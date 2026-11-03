/**
 * Pure dispatch-gate rules: state allowlists, idle gating, retry windows, and
 * model-facing framing. No filesystem or Cordis imports live here.
 */

/** Producer-owned source kind for gate-delivered prompts. */
export const DISPATCH_SOURCE_KIND = "dispatch-gate";

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

/** @returns {number} normalized poll interval */
export function normalizePollMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 10000;
  return Math.max(1000, Math.min(60000, Math.floor(number)));
}
