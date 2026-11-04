[English] | [简体中文](README.md)

# Dispatch Gate

Dispatch Gate is a local DSH scheduling plugin for handing work between
long-lived DSH windows. It reads the project's control state, determines which
role should work next, and sends configured prompts only when the target window
is idle.

A typical workflow:

```text
planner -> coding -> acceptance -> planner
```

The plugin does not create agents or modify control-plane state. It handles
window scheduling and prompt delivery; task state, rounds, and handoffs remain
owned by the project's control plane.

It is designed to pair with
**[dsh-agent-bus](https://github.com/AS2834/dsh-agent-bus)**: Bus provides stable
roles, durable messages, blockers, and offline redelivery, while Gate provides
state-driven dispatch, idle gating, pause/recovery, and strict handoff checks.
Together they form a communication-and-scheduling foundation; the project
still owns its control/state/claims workflow.

## Architecture and prerequisites

Dispatch Gate is not a complete workflow system by itself:

```text
project control/state/claims  decides what is next and whether work completed
             ↓
Dispatch Gate                 decides when it is safe to wake a role window
             ↓
coordinator/worker windows    perform work and update project records
             ↕
Agent Bus (optional)          role aliases, advisory messages, and blockers
```

Agent Bus remains a separate plugin; it has not been merged into Gate. Gate can
dispatch without it when every role has an explicit `agentIds` mapping, but
role messaging and blocker delivery still require Agent Bus. Gate replaces
fixed Schedule dispatch ticks, not the project's task state machine.

For basic state-based dispatch, the configured read-only command must exit
successfully and print at least:

```json
{"state":"assigned_coding"}
```

For safe completed-worker handoff and restart recovery, it must also expose the
current `task_id`, `round`, `sequence`, `handoff_sha256`, and claims. A completed
claim must match the current task/round/handoff and contain a non-empty token,
completion time, and exact configured `role_session`. Role prompts and the
project's control tool—not Gate—must create claims and advance state. The
control tool should use locking, atomic writes, and sequence/CAS checks.

The lifecycle is: the coordinator creates a task/handoff and changes state;
the worker claims through the project control tool; the worker finishes the
same claim; Gate validates task/round/handoff/session and wakes the
coordinator. Agent Bus carries aliases and messages but does not create these
records.

This public package does not ship a generic control-plane starter. A new
project needs an existing compatible control plane or an adapter before Gate
can provide a complete automated workflow.

## Quick start for an already integrated project

1. Ask an ordinary DSH window to install/update Gate and verify the project's
   state command, persistent role sessions, and optional Agent Bus aliases.
2. Restart DSH and refresh the page.
3. In the coordinator or target window, enter `/gate`.

A response beginning with `gate: running · connected` means Gate is active.
It starts with the DSH Host; `/gate` displays status rather than starting it.

| Goal | Command |
|---|---|
| Show status | `/gate` |
| Pause new work | `/gate pause` |
| Resume automatic scheduling | `/gate resume` |
| Run through a peak window | `/gate force` |
| Return to automatic scheduling | `/gate auto` |
| Check for work immediately | `/gate tick` |

`/gate tick` can dispatch real work and is normally unnecessary. Use
`/gate <project> ...` only for shared sessions or project control from an
unmanaged window.

## Features

- Dispatch prompts by control state, role, and retry interval
- Check that the target window is live and idle, and that its inbox is empty
- Configure arbitrary coordinator, worker, and UI roles
- Run multiple isolated projects from one plugin instance
- Watch the control directory, `SYNC.md`, and reviewer mailbox for changes
- Retry briefly while a target is busy without queueing duplicate prompts
- Recover ordinary persistent sessions with durable exponential backoff
- Validate completed handoffs against task, round, handoff, and exact
  `role_session`
- Persist runtime state, lock data, and status snapshots
- Provide a composer status bar with pause, resume, and force controls
- Optional peak/off-peak scheduling
- `/gate` commands for status and manual control

## How it works

```text
control command -> JSON state -> gate evaluates jobs
                                  |
                                  +-- target live
                                  +-- target idle
                                  +-- inbox empty
                                  +-- state and retry match
                                  |
                                  v
                           followup + flush
```

The gate reads control-plane output and does not write control-plane files. It
rechecks the target window before every dispatch, so it does not insert
messages into a session that is already working.

## Requirements

- DSH `^0.2.1-rc.2`
- Node.js
- pnpm
- A control command that prints control-state JSON

## Installation

Install from source:

```bash
git clone https://github.com/AS2834/dsh-dispatch-gate.git
cd dsh-dispatch-gate
./install.sh
```

Alternatively, install the local package directly:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-dispatch-gate
```

The install script runs the same command and prints the configuration steps.

## Configuration

After installation, edit `cordis.patch.yml` and replace the example paths and
command with your project's configuration:

```yaml
- insert:
    - id: dispatch-gate
      name: dsh-dispatch-gate
      # Remove this line after configuration
      disabled: true
      config:
        projects:
          - project: my-project
            coordinatorAgent: lead
            workerStateRoles: {building: builder}
            agentIds:
              lead: session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
              builder: session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
            check:
              cwd: /absolute/path/to/project
              command: [python3, tools/control.py, status, --json]
            jobs:
              - id: builder-dispatch
                agent: builder
                states: [building]
                promptFile: /absolute/path/to/builder.md
```

Main configuration fields:

| Field | Default | Description |
|---|---|---|
| `projects` | `[]` | Isolated project runtimes; the legacy single-project form remains supported |
| `pollMs` | `10000` | Fallback poll interval |
| `initialDelayMs` | `5000` | Delay before the first check |
| `watchDir` | `plans/control` | Control-plane event directory |
| `mailboxDirs` | `["plans/mailbox/astra"]` | Reviewer reply directories |
| `syncFiles` | `["plans/control/SYNC.md"]` | Sync files that trigger a check |
| `statusPath` | project-scoped | Read-only diagnostic status snapshot |
| `project` | required in `projects[]` | Project label and `/gate` route key |
| `uiShowIn` | coordinator role | Roles that render the status bar |
| `agentIds` | `{}` | Role-to-session-id mapping |
| `aliasStatePath` | DSH agent-bus state | Optional bus alias file |
| `requireIdle` | `true` | Dispatch only to idle windows |
| `skipIfInboxPending` | `true` | Skip targets with pending inbox work |
| `coordinatorAgent` | `planner` | Role that receives completed worker handoffs |
| `workerStateRoles` | coding/acceptance defaults | Control state to worker-role mapping |
| `offlineRecoveryEnabled` | `true` | Resume ordinary persistent sessions when offline |
| `offlineRetryInitialDelayMs` | `5000` | Initial recovery backoff |
| `offlineRetryMaxDelayMs` | `300000` | Maximum recovery backoff |
| `maxConcurrentAgents` | `1` | Concurrent gate-managed windows allowed to run |
| `syncWakeCooldownMs` | `30000` | Cooldown for SYNC-triggered planner wakes |
| `dispatchCooldownMs` | `10000` | Global cooldown after any dispatch |
| `peakScheduleEnabled` | `true` | Enable peak/off-peak scheduling; the public template overrides it to `false` |

Job fields:

- `agent`: role name
- `states`: control states allowed to dispatch this job
- `controlOnlyStates`: states where the coordinator waits for a worker event
- `promptFile`: prompt file path
- `retrySeconds`: fallback retry interval when state is unchanged
- `enabled`: set to `false` to disable the job

Restart or refresh DSH after editing, then enable `Dispatch Gate` in the plugin
manager.


## Role configuration

The gate does not discover roles or create sessions. The `agent` field of each
job is a role name, and the target session is resolved in this order:

1. `agentIds[role]`
2. The role entry in the file referenced by `aliasStatePath`
3. The role itself, if it is a session UUID

Explicit mapping is recommended:

```yaml
config:
  agentIds:
    planner: session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
    coding: session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
    acceptance: session-cccccccc-cccc-4ccc-8ccc-cccccccccccc
```

A bus alias file uses the same role-to-session mapping:

```json
{
  "planner": "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "coding": "session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "acceptance": "session-cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

`agentIds` takes precedence over the alias file. If a role cannot be resolved,
the job is skipped; the gate never sends a prompt to an unknown session.

### Three-role example

```yaml
jobs:
  - id: coding-dispatch
    agent: coding
    states: [assigned_coding]
    promptFile: ./prompts/coding.md
    retrySeconds: 300

  - id: acceptance-dispatch
    agent: acceptance
    states: [awaiting_verification]
    promptFile: ./prompts/acceptance.md
    retrySeconds: 300

  - id: planner-dispatch
    agent: planner
    states: [idle, assigned_coding, awaiting_verification, verified, submitted]
    controlOnlyStates: [assigned_coding, awaiting_verification]
    promptFile: ./prompts/planner.md
    retrySeconds: 600
```

Job fields:

- `agent`: role name; each role maps to one session
- `states`: control states that allow this role to be dispatched
- `controlOnlyStates`: states where the coordinator waits for a worker event.
  The planner is not woken by ordinary polling in these states; it is triggered
  by coding/acceptance completion or an external file change
- `promptFile`: prompt file for this role
- `retrySeconds`: fallback retry interval when the state is unchanged
- `enabled`: set to `false` to disable the job

The role must resolve to a normal persistent root session. If it is offline,
the gate asks DSH Session Controller to resume it. Failed recovery attempts use
durable exponential backoff; deleted, non-persistent, subagent-owned, or
writer-held sessions cannot be forced back online.

### Status bar roles

`uiShowIn` uses role names:

```yaml
uiShowIn: [planner, coding]
```

When omitted or empty, `uiShowIn` falls back to `coordinatorAgent`.


## Concurrency control

By default, the gate allows only one gate-managed window to run at a time:

```yaml
maxConcurrentAgents: 1
```

If coding is running, waiting, or still has pending inbox work, a planner sync
event is deferred as `peer_busy` until coding is fully idle. This keeps local
roles serialized and prevents multiple sessions from issuing model requests to
the upstream provider at the same time.

`dispatchCooldownMs` adds a global cooldown after every dispatch, so the gate
does not start the next role while DSH status is still catching up.

Increase the value only if your provider and workflow can tolerate parallel
requests.

`syncWakeCooldownMs` controls the cooldown for planner wakes triggered by
`SYNC.md`, defaulting to 30 seconds. It prevents the planner from waking itself
after writing its own sync file.

## Control interface

The gate runs `check.command` and reads JSON from standard output. The minimum
fields are:

```json
{
  "state": "assigned_coding",
  "task": "T-1",
  "round": "r01",
  "sequence": 17
}
```

The control tool and state machine are provided by the project. The gate uses
`state` for dispatch decisions and copies `task`, `round`, and `sequence` into
dispatch headers so roles can confirm their context.

## Usage

1. Open every DSH window that participates in the workflow and keep the
   sessions live.
2. Enable the plugin and verify that roles and session IDs in the configuration
   are correct.
3. Run this in any window:

```text
/gate status
```

A healthy result looks like:

```text
gate: running · connected · scheduled
project=my-project · control=assigned_coding
planner=idle, coding=idle, acceptance=idle
```

4. Gate-managed windows show a collapsed composer bar above the input:

```text
▸ Dispatch Gate · running
```

Expand it to inspect role status, refresh, pause, or resume.

## Commands

| Command | Description |
|---|---|
| `/gate status` | Show a short status summary |
| `/gate status json` | Show the full status JSON |
| `/gate pause` | Pause dispatch |
| `/gate resume` | Resume according to the peak schedule |
| `/gate force` | Ignore peak hours and run |
| `/gate auto` | Clear force mode and restore the schedule |
| `/gate tick` | Run one check immediately |

## Peak/off-peak scheduling

When `peakScheduleEnabled` is on, the default policy uses Beijing time:

- Peak: Monday-Friday, 09:00-12:00 and 14:00-18:00, excluding Chinese
  statutory holidays
- Off-peak: all other times

The 2026 holiday list is bundled. Update `holidays` when the next official
notice is published. This feature is disabled in the public template.

## Runtime files

The gate writes:

```text
<check.cwd>/logs/dispatch-gate/<project>/status.json
~/.dsh/storages/dispatch-gate/<project>/state.json
~/.dsh/storages/dispatch-gate/<project>/run.lock
```

These files are used for status display and restart recovery and should not be
committed.

## Relation to subagents

A subagent is a child execution created by a parent agent. It is suitable for
a one-off task with a clear scope, and its result returns to the parent.

Dispatch Gate manages multiple independent, long-lived windows. Each window
has its own context, tools, and permissions, and an external control plane
decides when roles switch. The plugin does not create subagents or aggregate
their results.

## Subagent restriction

Sessions managed by the gate are hard-blocked from calling:

```text
subagent
subagent_fork
workflow
grep
rg
```

The block is enforced by `ctx.tools.guard()`, not by prompt text. A denied call
returns an error and does not create a child agent. Direct `grep`/`rg` calls
through the bash tool, including absolute-path invocations, are also denied;
use the read tool for source inspection.

Existing subagents are not killed; the restriction applies to future calls.
Manually created sessions that are not mapped to a gate job are not restricted.
The guard is removed when the runtime is disposed. If the DSH environment does
not provide `tools.guard`, the Host logs `subagent restriction is not installed`
and this restriction is not active. This guard is not an operating-system
sandbox.

## Limitations

- Offline recovery requires a resumable persistent DSH root session
- Multiple projects are isolated in one Host process, but the shared-session
  lease is not a cross-process or distributed lock
- A shared session still processes only one turn at a time
- The plugin does not make architecture, security, or commit decisions
- Files under `prompts/` are examples and must be adapted
- The plugin does not read or modify a `PAUSE` file directly; pause behavior
  belongs to the control command or planner prompt

## Development

```bash
node --test test/*.test.js
```

## License

MIT
