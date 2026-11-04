/**
 * Process-wide owner for any number of independent dispatch-gate projects.
 * It routes human commands by the receiving session and keeps project names
 * explicit when one session participates in more than one project.
 */
export class DispatchGateManager {
  constructor(runtimes) {
    this.runtimes = [...runtimes];
    this.byProject = new Map(this.runtimes.map((runtime) => [runtime.project, runtime]));
  }

  start() {
    const started = [];
    try {
      for (const runtime of this.runtimes) {
        runtime.start();
        started.push(runtime);
      }
    } catch (error) {
      for (const runtime of started.reverse()) void runtime.dispose();
      throw error;
    }
  }

  async dispose() {
    await Promise.allSettled(this.runtimes.map((runtime) => runtime.dispose()));
  }

  matchingSession(sessionId) {
    return this.runtimes.filter((runtime) => runtime.rolesForSession(sessionId).length > 0);
  }

  statusFor(runtime, sessionId, explicit = false) {
    return {
      ...runtime.statusSnapshot(),
      commandProject: runtime.project,
      visible: explicit || runtime.isVisibleToSession(sessionId),
    };
  }

  registryStatus(sessionId, runtimes = this.runtimes) {
    return {
      v: 2,
      multiProject: true,
      projects: runtimes.map((runtime) => this.statusFor(runtime, sessionId)),
    };
  }

  async handleCommand(rawInput, sessionId) {
    const parts = String(rawInput ?? "").trim().split(/\s+/u).filter(Boolean);
    const explicit = parts.length > 0 ? this.byProject.get(parts[0]) : undefined;
    const command = explicit === undefined ? parts.join(" ") || "status" : parts.slice(1).join(" ") || "status";
    const action = command.split(/\s+/u)[0] || "status";
    const wantsJson = action === "status" && command.split(/\s+/u)[1] === "json";

    if (explicit !== undefined) {
      if (wantsJson) return { kind: "success", text: JSON.stringify(this.statusFor(explicit, sessionId, true)) };
      return explicit.handleCommand(command);
    }

    const matches = this.matchingSession(sessionId);
    if (matches.length === 1) {
      if (wantsJson) return { kind: "success", text: JSON.stringify(this.statusFor(matches[0], sessionId)) };
      return matches[0].handleCommand(command);
    }

    if (action === "status") {
      if (wantsJson) return { kind: "success", text: JSON.stringify(this.registryStatus(sessionId, matches.length > 0 ? matches : this.runtimes)) };
      return {
        kind: "success",
        text: (matches.length > 0 ? matches : this.runtimes).map((runtime) => runtime.summaryText()).join("\n"),
      };
    }

    if (matches.length > 1) {
      return { kind: "error", text: `dispatch-gate: session belongs to multiple projects; use /gate <project> ${command}` };
    }
    return { kind: "error", text: `dispatch-gate: this session is not managed; use /gate <project> ${command}` };
  }
}
