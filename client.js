window.__ModuleLoader__.load({
  id: "dsh-dispatch-gate",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dispatch-gate";
    const COLLAPSE_KEY = "dispatch-gate:collapsed";

    const zh = {
      "title": "调度闸门",
      "running": "运行中",
      "paused": "已暂停",
      "stale": "未运行",
      "pause": "暂停",
      "resume": "恢复",
      "collapse": "收起",
      "expand": "展开",
      "lastTick": "上次检查",
      "lastDispatch": "上次派发",
      "bus": "消息总线",
      "waiting": "等待第一次检查…",
      "unavailable": "状态不可读",
      "unclean": "上次未正常关闭，已默认暂停",
      "state": "状态",
      "noJobs": "暂无角色",
      "noSession": "缺少 sessionId",
      "commandFailed": "命令失败",
      "connected": "已连接",
      "disconnected": "未连接",
      "retry": "重试",
      "peakPaused": "峰段暂停",
      "manualPaused": "手动暂停",
      "uncleanPaused": "异常恢复暂停",
      "forced": "峰段强制运行",
      "peak": "峰段",
      "offPeak": "谷段",
    };
    const en = {
      "title": "Dispatch Gate",
      "running": "running",
      "paused": "paused",
      "stale": "not running",
      "pause": "Pause",
      "resume": "Resume",
      "collapse": "Collapse",
      "expand": "Expand",
      "lastTick": "last tick",
      "lastDispatch": "last dispatch",
      "bus": "Message bus",
      "waiting": "waiting for the first check…",
      "unavailable": "status unavailable",
      "unclean": "previous run did not shut down cleanly; started paused",
      "state": "state",
      "noJobs": "no roles",
      "noSession": "missing sessionId",
      "commandFailed": "command failed",
      "connected": "connected",
      "disconnected": "disconnected",
      "retry": "Retry",
      "peakPaused": "peak hours paused",
      "manualPaused": "manually paused",
      "uncleanPaused": "unclean-start paused",
      "forced": "peak-hours override",
      "peak": "peak",
      "offPeak": "off-peak",
    };

    function relativeTime(iso, now) {
      if (!iso) return "—";
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return "—";
      const seconds = Math.max(0, Math.round((now - at) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      return `${Math.floor(minutes / 60)}h`;
    }

    function dot(color) {
      return h("span", {
        "aria-hidden": true,
        style: {
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: 999,
          background: color,
          marginRight: 5,
          flex: "none",
        },
      });
    }

    function statusColor(value) {
      if (value === "idle") return "var(--dsw-alias-state-success-primary)";
      if (value === "running") return "var(--dsw-alias-state-warning-primary)";
      return "var(--dsw-alias-label-tertiary)";
    }

    function readCollapsed() {
      try {
        const value = window.localStorage.getItem(COLLAPSE_KEY);
        return value === null ? true : value === "1";
      } catch {
        return true;
      }
    }

    function writeCollapsed(value) {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
      } catch {
        // ignore storage denial
      }
    }

    let ctx;

    function GateDock({ sessionId, t }) {
      const [statusPayload, setStatusPayload] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState(readCollapsed);
      const [selectedProject, setSelectedProject] = React.useState(null);

      const refresh = React.useCallback(async () => {
        if (!sessionId) {
          setError(t("noSession"));
          return;
        }
        try {
          const response = await ctx.remote.commands.execute(sessionId, "/gate status json", []);
          if (!response || response.ok !== true) {
            throw new Error(response?.error?.message ?? t("commandFailed"));
          }
          const execution = response.value;
          const text = execution?.result?.text;
          if (!execution || execution.result?.kind === "error" || typeof text !== "string") {
            throw new Error(t("commandFailed"));
          }
          setStatusPayload(JSON.parse(text));
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [sessionId]);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      async function run(line) {
        if (busy) return;
        if (!sessionId) {
          setError(t("noSession"));
          return;
        }
        setBusy(line);
        setError(null);
        try {
          const routedLine = status?.commandProject
            ? line.replace(/^\/gate\b/u, `/gate ${status.commandProject}`)
            : line;
          const response = await ctx.remote.commands.execute(sessionId, routedLine, []);
          if (!response || response.ok !== true) {
            throw new Error(response?.error?.message ?? t("commandFailed"));
          }
          const execution = response.value;
          if (!execution) throw new Error(t("commandFailed"));
          if (execution.result?.kind === "error") throw new Error(execution.result.text || t("commandFailed"));
          await new Promise((resolve) => setTimeout(resolve, 300));
          await refresh();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(null);
        }
      }

      function toggleCollapsed() {
        const next = !collapsed;
        setCollapsed(next);
        writeCollapsed(next);
      }

      if (!statusPayload) return null;
      const visibleProjects = Array.isArray(statusPayload.projects)
        ? statusPayload.projects.filter((project) => project.visible !== false)
        : statusPayload.visible === false ? [] : [statusPayload];
      const status = visibleProjects.find((project) => project.project === selectedProject) ?? visibleProjects[0];
      if (!status || status.visible === false) return null;
      const jobs = Array.isArray(status.jobs) ? status.jobs : [];

      const now = Date.now();
      // The bar fetches status on demand, so wall-clock age is not a liveness
      // signal. Only an explicit running:false means the Host is gone.
      const stale = status.running === false;
      const paused = Boolean(status.paused);
      const pauseSource = status.pauseSource ?? (status.peakPaused ? "peak" : status.uncleanStart ? "unclean" : paused ? "manual" : null);
      const peakPaused = pauseSource === "peak";
      const forced = Boolean(status.manualOverride) && Boolean(status.peakNow);
      const stateColor = paused || forced
        ? "var(--dsw-alias-state-warning-primary)"
        : stale || error || status.lastError
          ? "var(--dsw-alias-state-error-primary)"
          : "var(--dsw-alias-state-success-primary)";
      const label = paused
        ? (pauseSource === "peak" ? t("peakPaused") : pauseSource === "unclean" ? t("uncleanPaused") : pauseSource === "manual" ? t("manualPaused") : t("paused"))
        : forced
          ? t("forced")
          : stale
            ? t("stale")
            : t("running");
      const connection = stale ? t("disconnected") : t("connected");
      const peers = Array.isArray(status.bus?.peers) ? status.bus.peers : [];
      const lastMessage = status.bus?.lastMessage;
      const lastDispatchAt = jobs
        .map((job) => job.lastDispatchAt)
        .filter(Boolean)
        .sort()
        .at(-1);
      const scope = [
        status.project && status.project !== "default" ? status.project : null,
        status.state ? `state=${status.state}` : null,
      ].filter(Boolean).join(" · ");

      const iconButtonStyle = {
        flex: "none",
        cursor: busy ? "default" : "pointer",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: "var(--dsw-radius-sm)",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        fontSize: 12,
        lineHeight: "18px",
        padding: "1px 8px",
        opacity: busy ? 0.5 : 1,
      };

      return h("div", {
        style: {
          boxSizing: "border-box",
          width: "100%",
          maxWidth: "var(--dsh-composer-card-max-width)",
          margin: "0 auto 6px",
          padding: "6px 10px",
          border: "1px solid var(--dsw-alias-border-l1)",
          borderRadius: "var(--dsw-radius-md)",
          background: "var(--dsw-specific-menu)",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 12,
          lineHeight: "18px",
          display: "grid",
          gap: 2,
        },
      }, [
        h("div", {
          key: "gate-row",
          style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
        }, [
          h("button", {
            key: "collapse",
            type: "button",
            "aria-label": collapsed ? t("expand") : t("collapse"),
            title: collapsed ? t("expand") : t("collapse"),
            onClick: toggleCollapsed,
            style: { ...iconButtonStyle, border: "none", padding: "0 4px", color: "var(--dsw-alias-label-tertiary)" },
          }, collapsed ? "▸" : "▾"),
          h("span", { key: "title", style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, flex: "none" } }, t("title")),
          visibleProjects.length > 1 ? h("select", {
            key: "project",
            value: status.project,
            onChange: (event) => setSelectedProject(event.target.value),
            style: {
              maxWidth: 160,
              border: "1px solid var(--dsw-alias-border-l1)",
              borderRadius: "var(--dsw-radius-sm)",
              background: "transparent",
              color: "var(--dsw-alias-label-secondary)",
              fontSize: 12,
            },
          }, visibleProjects.map((project) => h("option", { key: project.project, value: project.project }, project.project))) : null,
          h("span", { key: "label", style: { display: "inline-flex", alignItems: "center", minWidth: 0, color: stateColor } }, [dot(stateColor), label]),
          h("span", {
            key: "state",
            style: { color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 },
          }, collapsed ? connection : scope),
          h("button", {
            key: "toggle",
            type: "button",
            disabled: Boolean(busy),
            onClick: () => void run(paused ? ((peakPaused || status.peakNow) ? "/gate force" : "/gate resume") : "/gate pause"),
            style: iconButtonStyle,
          }, busy ? "…" : paused ? t("resume") : t("pause")),
          h("button", {
            key: "refresh",
            type: "button",
            title: t("retry"),
            "aria-label": t("retry"),
            disabled: Boolean(busy),
            onClick: () => void refresh(),
            style: { ...iconButtonStyle, border: "none", padding: "0 4px", color: "var(--dsw-alias-label-tertiary)" },
          }, "↻"),
        ]),
        collapsed ? null : h("div", {
          key: "jobs-row",
          style: { display: "flex", flexWrap: "wrap", gap: "2px 10px", minWidth: 0 },
        }, jobs.length === 0
          ? [h("span", { key: "none", style: { color: "var(--dsw-alias-label-tertiary)" } }, t("noJobs"))]
          : jobs.map((job) => h("span", { key: job.id, style: { display: "inline-flex", alignItems: "center", minWidth: 0 } }, [
            dot(statusColor(job.agentStatus)),
            h("span", { key: "name", style: { color: "var(--dsw-alias-label-secondary)" } }, job.agent),
            h("span", {
              key: "value",
              style: { color: job.agentStatus === "running" ? "var(--dsw-alias-state-warning-primary)" : "var(--dsw-alias-label-tertiary)", marginLeft: 3 },
            }, job.agentStatus ?? "unknown"),
          ]))),
        collapsed ? null : h("div", {
          key: "meta-row",
          style: { display: "flex", flexWrap: "wrap", gap: "2px 10px", color: "var(--dsw-alias-label-tertiary)", minWidth: 0 },
        }, [
          h("span", { key: "connection" }, connection),
          status.peakScheduleEnabled ? h("span", { key: "peak" }, `${status.peakNow ? t("peak") : t("offPeak")}${status.peakWindow?.next ? ` → ${status.peakWindow.next}` : ""}`) : null,
          h("span", { key: "tick" }, `${t("lastTick")} ${relativeTime(status.lastTickAt, now)}`),
          h("span", { key: "dispatch" }, `${t("lastDispatch")} ${relativeTime(lastDispatchAt, now)}`),
          h("span", { key: "bus" }, `${t("bus")} ${peers.length > 0 ? peers.map((peer) => `${peer.alias}:${peer.status}`).join(" · ") : "—"}`),
          lastMessage ? h("span", {
            key: "msg",
            style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
          }, `${lastMessage.from ?? "?"}→${lastMessage.to ?? "?"} ${lastMessage.kind ?? ""}`) : null,
        ]),
        status.uncleanStart ? h("div", { key: "unclean", style: { color: "var(--dsw-alias-state-warning-primary)" } }, t("unclean")) : null,
        error ? h("div", { key: "error", style: { color: "var(--dsw-alias-state-error-primary)" } }, `${t("commandFailed")}: ${error}`) : null,
        status.lastError ? h("div", { key: "lasterr", style: { color: "var(--dsw-alias-state-error-primary)" } }, `control: ${status.lastError}`) : null,
      ]);
    }

    return {
      inject: ["slots", "remote", "remote.commands", "locale"],
      apply(clientCtx) {
        ctx = clientCtx;
        clientCtx.effect(() => clientCtx.locale.register(NS, { zh, en }), "dispatch-gate.locale()");
        // `sessionId` is a standard slot prop; do not override it with an
        // `inject` factory (that was why the pause button could be inert).
        clientCtx.slots.inject("conversation.input.dock", () => clientCtx.slots.register({
          name: "conversation.input.dock",
          id: "dispatch-gate",
          order: 30,
          locale: NS,
        }, GateDock));
      },
    };
  },
});
