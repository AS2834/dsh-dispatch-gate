[English](README.en.md) | 简体中文

# dsh-dispatch-gate

一个**独立的 DSH host 调度器**，只做一件事：

> 把固定 tick 的 dispatch 任务，改成“先查控制面状态，再判断窗口是否空闲，只有真的有活且窗口空闲才叫醒模型”。一个插件实例可以同时管理多个项目，每个项目可以定义任意角色和 job。

它**不叫“自动化任务”**，在侧边栏/插件列表里的名字是：

- English: **Dispatch Gate**
- 中文: **调度闸门**

它也不修改 DSH 自带的 Schedule 包，不修改 `agent-bus`，不修改控制面。

推荐与 **[dsh-agent-bus](https://github.com/AS2834/dsh-agent-bus)** 一起使用：Bus 提供稳定角色、持久消息、blocker 和离线补投；Gate 提供状态驱动派发、空闲闸门、pause、恢复与严格交接校验。两者组成“通信 + 调度”底座，但项目仍需提供自己的 control/state/claims。

## 先说清楚：Gate 不是整套自动化

一套完整系统由三部分组成，它们**没有合并**：

```text
项目里的 control / state / claims        决定“现在轮到谁、任务是否完成”
                  ↓
Dispatch Gate                            决定“什么时候安全地叫醒哪个窗口”
                  ↓
coordinator / worker / reviewer 窗口      真正执行工作并更新项目记录
                  ↕
Agent Bus（可选）                         注册角色别名、传消息和 blocker
```

- Gate 可以替代旧 Schedule 的固定 dispatch tick，但不创建任务、不推进项目状态。
- `dsh-agent-bus` 是独立插件，没有合并进 Gate。显式配置 `agentIds` 时 Gate 不要求安装 bus；需要角色别名、角色间消息或 blocker 时仍需 Agent Bus。
- control 和任务交接文件属于项目本身。Gate 只读它们，不生成 state、claim 或 handoff。

因此：**单靠 Gate 可以按一个现成状态叫醒窗口，但不能凭空组成完整工作流。**

## 已有配套控制面的项目怎么用

项目已经具备任务状态、持久角色窗口和必要的角色绑定时，人的操作只有三步：

1. 让普通 DSH 窗口安装或更新 Gate，并检查项目状态接口、角色绑定以及可选的 Agent Bus。
2. 重启 DSH、刷新页面。
3. 去 coordinator/目标窗口输入 `/gate`。

看到 `gate: running · connected` 就表示 Gate 已运行。`/gate` 只是查看状态，不是启动命令；之后项目状态变化会自动叫醒对应角色。

| 想做什么 | 输入什么 |
|---|---|
| 看是否正常 | `/gate` |
| 暂停新工作 | `/gate pause` |
| 恢复自动峰谷策略 | `/gate resume` |
| 峰段也立即运行 | `/gate force` |
| 回到自动峰谷策略 | `/gate auto` |
| 立即检查一次现在是否有工作 | `/gate tick` |

`/gate tick` 可能真的派发任务，一般不需要手动执行。共享窗口或从非受管窗口控制多个项目时，才需要 `/gate <project> status` 这类写法。

## 新项目要满足什么条件

### 最低要求：只能按状态派发

项目必须提供一个只读命令，成功时输出至少包含非空 `state` 的 JSON：

```json
{"state":"assigned_coding"}
```

再把状态映射给角色，例如 `assigned_coding → coding`。达到这一层后，Gate 能叫醒 coding，但还不能可靠判断这一轮是否完成。

### 完整要求：可以安全自动交接

若要使用 completed-claim 校验、pause 后交接和崩溃恢复，状态输出还需要：

```json
{
  "state": "assigned_coding",
  "task_id": "T-123",
  "round": "r01",
  "sequence": 42,
  "handoff_sha256": "<64位哈希>",
  "claims": [{
    "role": "coding",
    "task": "T-123",
    "round": "r01",
    "status": "completed",
    "claim_token": "<非空令牌>",
    "role_session": "<Gate 配置的真实 session ID>",
    "finished_at": "<带时区时间>",
    "handoff_sha256": "<与当前任务相同的64位哈希>"
  }]
}
```

必须同时满足 task、round、handoff 和 worker 身份一致，claim 已 completed，token/完成时间非空，并由角色 prompt 通过项目控制工具领取、完成和推进状态。控制工具还应使用锁、原子写和 `sequence`/CAS，防止两个窗口同时推进。

记录的产生顺序是：coordinator 创建 task/handoff 并切换 state；worker 通过项目控制工具 claim；完成后通过同一工具 finish；claim 变成 completed；Gate 校验 task/round/handoff/`role_session` 后唤醒 coordinator。Agent Bus 不生成这些记录，它只负责窗口别名、消息和 blocker。

**Public Gate 目前不附带一套通用 control starter。** 全新项目必须已有等价控制面，或先实现适配器；只安装 Gate 不能得到完整自动化。

## 为什么需要它

原来的 DSH Schedule 是：

```text
每 5/10 分钟 → 直接 followup → 模型被叫醒 → 跑 control.py → 发现没活 → 退出
```

问题：

- 窗口正在工作时，消息还是会排进下一轮
- 没活时也会叫醒模型，白花 token
- 长任务结束后容易被旧 tick 打扰

Dispatch Gate 是：

```text
每 10 秒 → 脚本跑 control.py status（不花钱）
  ├─ state 不是这个角色的活 → 跳过
  ├─ 窗口不是 idle → 跳过
  ├─ 收件箱已有未处理消息 → 跳过
  └─ 有活 + idle + 收件箱空 → 才 followup
```

## 功能总览

| 能力 | 现在能做什么 |
|---|---|
| 状态驱动派发 | 每个 job 配置允许的 control states；state 不匹配就不叫醒模型 |
| 空闲闸门 | 目标 session 必须 live、idle 且 inbox 无待处理消息；不会把固定 tick 排进忙碌窗口 |
| 自定义角色 | 角色名不限于 planner / coding / acceptance；coordinator、worker、UI 角色均由项目配置定义 |
| 多项目 | 一个插件实例管理多个独立 runtime；每个项目拥有自己的 control、watcher、jobs、pause 和持久状态 |
| 完成交接 | worker claim 通过 task、round、handoff、completed 状态和精确 `role_session` 校验后才唤醒 coordinator |
| Pause 语义 | pause 冻结新轮次，不杀正在执行的 turn；合法的 completed handoff 可继续交接 |
| 峰谷调度 | 按时区、时间窗口和节假日自动暂停/恢复，也支持 manual、force 和 auto |
| 离线恢复 | 普通持久化 session 离线后由 Session Controller 恢复；失败使用跨重启的指数退避 |
| 重试风暴保护 | DeepSeek provider transient retry 收紧为最多 2 次重试、5 秒起步退避 |
| 状态与控制 | Composer 显示当前项目、角色状态和 pause 来源；支持按 session 自动路由或显式指定项目的 `/gate` 命令 |
| 防串项目 | 项目状态目录必须唯一；共享 session 的同时派发由进程内 lease 串行化；歧义控制命令必须指定项目 |
| 崩溃保护 | `run.lock` 检测非正常关闭；handoff、pause 和恢复退避写入 gate 自己的持久状态 |

Gate 负责的是“什么时候安全地叫醒哪个持久窗口”，不是替代控制面、任务系统或模型本身。当前做不到的事情集中列在[当前不能做到的事](#当前不能做到的事)。

## 和窗口自己开 subagent 的区别

两者解决的不是同一个问题：subagent 是一个 turn 内的临时任务分解；Dispatch Gate 是多个持久窗口之间的外部调度。

| 对比项 | 窗口自己开 subagent | Dispatch Gate 窗口调度 |
|---|---|---|
| 调度发起者 | 当前父窗口/模型在 turn 内决定 | Host 根据外部 control state 决定 |
| 执行单元 | 父任务创建的临时子 agent | 预先存在、可恢复的独立 root session |
| 生命周期 | 通常跟随父任务，适合一次性并行分解 | 跨 turn、跨 pause、跨 DSH 重启持续存在 |
| 上下文来源 | 从父任务继承或由父任务写子任务 | 每个角色维护自己的长期会话和 prompt；dispatch 只发送唤醒提示 |
| 状态来源 | 父任务内部计划、消息和等待结果 | 项目自己的 `control.py status --json`、claims 和 handoff |
| 交接方式 | 子 agent 返回结果给父窗口 | worker 写 completed claim，Gate 校验后唤醒 coordinator |
| 身份边界 | 主要是 parent/child 所有权 | role 必须绑定精确 session；错误 `role_session` 不得交接 |
| 并发粒度 | 同一个父 turn 内可快速扇出多个子任务 | 多个项目/角色窗口可独立运行；同一 session 仍一次只处理一个 turn |
| 时间策略 | 父窗口一旦运行通常立即创建 | 可按峰谷、manual pause、项目状态和 retry window 延迟启动 |
| 故障恢复 | 依赖父任务继续存在并收集结果 | session、handoff 和 retry backoff 都有恢复路径 |
| 配置成本 | 低，适合临时探索 | 高，需要 control 协议、角色、session、prompt 和隔离路径 |
| 最适合 | 一次性代码搜索、并行分析、短任务拆分 | 长时间、多轮、可审计的 planner/worker/acceptance 类协作 |

当前实现为了防止绕开角色身份、窗口预算和 handoff 审计，**会在 Gate 管理的 session 中拦截 `subagent`、`subagent_fork`、`workflow`，以及 grep/rg 类工具调用**。因此它不是“在受管窗口里再套一层 subagent”的方案：

- 临时、一次性的并行拆分：优先用 subagent，不需要 Gate。
- 需要跨时段、跨重启、固定角色和严格交接：使用 Gate 管理独立窗口。
- 混合使用时，让未被 Gate 管理的外层操作窗口使用 subagent；Gate 管理的角色窗口继续遵守单角色、单 session 的执行边界。

### 受管窗口的工具限制

这项限制已经在 Host 侧实现，不只是写在角色 prompt 里的约定：

- session 只要解析为某个已启用 Gate job 的角色，就属于受管窗口；显式 `agentIds` 和 agent-bus alias 两种绑定都生效。
- `tools.guard` 会拒绝 `subagent`、`subagent_fork`、`workflow`、`grep`、`rg` 工具，也会拒绝 bash 中直接调用 `grep` / `rg`（包括绝对路径调用）。源码检查应改用 read 工具。
- 未绑定到 Gate job 的外层窗口不受该限制，可以继续创建 subagent 或使用 grep/rg。
- runtime dispose 时会注销 guard。若当前 DSH 环境没有提供 `tools.guard`，Host 会记录 `subagent restriction is not installed` 警告，此时不能宣称限制已生效。
- 这是一层防止普通工具调用绕过角色边界的 guard，不是通用操作系统沙箱；当前也没有按项目关闭它的配置。

## 高级：让 DSH 自己完成完整部署验收

上面的短提示足以覆盖大多数安装。只有需要审计完整配置过程、部署多个项目或排查失败时，才需要展开下面的详细要求。

<details>
<summary>展开完整部署提示词与所需信息</summary>

多项目配置涉及 session ID、control 命令、角色状态映射、prompt 文件和持久目录。推荐让一个具备以下权限的 DSH 窗口完成部署：

- 能读取插件源码和目标项目；
- 能读取并修改目标 DSH profile；
- 能查看当前 session/agent-bus alias；
- 能运行测试和 `dsh --dump-config`；
- 如果需要安装依赖或重启 DSH，由人类明确授权。

可以直接把下面这段发给它：

```text
请为我的 DSH web profile 部署本地插件：
/absolute/path/to/dsh-dispatch-gate

先完整阅读插件 README、cordis.patch.yml、lib/index.js 和现有测试，再检查当前
profile、agent-bus aliases、目标项目的 control 协议、现有 Schedule dispatch 任务。

部署要求：
1. 保留现有用户修改，不覆盖无关配置，不凭空编造 session ID。
2. 识别我要管理的每个项目，为其建立唯一 project 名、check.cwd、check.command、
   stateDir、statusPath、角色映射、agentIds、jobs 和 promptFile。
3. 同名角色跨项目绑定不同窗口时，必须在各项目显式写 agentIds。
4. 校验 workerStateRoles、coordinatorAgent、uiShowIn 与 control states/claims 一致。
5. 先保留旧 Schedule dispatch；完成配置、测试和 profile 装载校验后，再列出应停用的
   重复 Schedule 任务，未经确认不要删除其他任务。
6. 运行 node --test test/*.test.js；分别对 lib/index.js、lib/runtime.js、
   lib/manager.js、client.js 运行 node --check；再运行 git diff --check、
   dsh --profile web --dump-config 和 dsh --profile web --help。
7. 报告最终 diff、每个项目的角色→session 映射、持久目录、验证结果、仍需我决定的事项。
8. 如果缺少项目目录、session ID、control 输出示例或 prompt，不要猜，先向我询问。
9. 不要启动真实工作轮次；部署验收只执行配置与只读状态检查。重启 DSH 前先告诉我。
```

至少要给部署窗口这些信息，或者允许它从本机只读检查中取得：

- 每个项目的稳定名称和绝对路径；
- `control.py status --json` 的实际命令及一份输出示例；
- 角色名称、每个角色负责的 states、coordinator 是谁；
- 每个角色已有的普通持久化 session ID；
- 每个 job 使用的 prompt 文件；
- 是否采用默认峰谷时间，以及哪些旧 Schedule dispatch 需要停用。

推荐分两阶段：先让 DSH 生成配置、跑测试并报告 diff；人类验收后，再授权它停用重复 Schedule、安装/更新 profile 并重启。这样比直接手写 YAML 更安全，也方便回滚。

</details>

## 部署运行成功后是什么样

“插件能加载”只是第一步。一个项目真正部署成功，应同时满足配置、运行状态、派发行为和防重复四组条件。

### 1. 配置和装载成功

以下命令应成功退出：

```bash
cd /absolute/path/to/dsh-dispatch-gate
node --test test/*.test.js
node --check lib/index.js
node --check lib/runtime.js
node --check lib/manager.js
node --check client.js
git diff --check
dsh --profile web --dump-config
dsh --profile web --help
```

`--dump-config` 中应只有一个 `dispatch-gate` Host row，其 `config.projects` 包含所有项目；每个项目的 `project`、`check.cwd`、`stateDir` 和 `statusPath` 都能明确区分。DeepSeek 两个 provider row 应显示 `maxRetries: 2` 和 `initialDelayMs: 5000`。

### 2. 重启后的状态正常

重启 DSH、刷新浏览器后，在某个受管 session 执行：

```text
/gate <project> status json
```

正常结果大致如下；实际 state、pause 和角色名由项目决定：

```json
{
  "v": 1,
  "running": true,
  "project": "project-a",
  "paused": false,
  "pauseSource": null,
  "lastError": null,
  "state": "idle",
  "lastTickAt": "2026-11-04T10:00:00.000Z",
  "jobs": [
    {
      "id": "builder-dispatch",
      "agent": "builder",
      "agentId": "session-...",
      "live": true,
      "agentStatus": "idle",
      "lastReason": "state_not_allowed"
    }
  ]
}
```

注意：处于峰段时 `paused: true`、`pauseSource: "peak"` 是正常状态，不代表部署失败。刚启动尚未完成首个 poll 时 `state` 或 `lastTickAt` 也可能暂时为空；超过 `initialDelayMs + pollMs` 仍为空才需要排查。

每个项目还应生成独立文件：

```text
<stateDir>/state.json
<stateDir>/run.lock
<stateDir>/status.json
<check.cwd>/<statusPath>  # statusPath 为相对路径时
```

`statusPath` 为绝对路径时直接写该路径。正常关闭后 `run.lock` 会删除；进程运行期间存在是正常的。

### 3. Composer 和多项目路由正常

- 状态条只出现在该项目 `uiShowIn` 指定的角色窗口，不应出现在无关 session。
- 状态条显示项目、control state、角色 live/idle/running、pause 来源和最近检查时间。
- 同一 session 同时属于多个可见项目时，会出现项目选择器。
- 点击暂停/恢复后，只改变选择的项目；另一个项目的 `paused` 不应跟着变化。
- 在非受管窗口执行 `/gate status` 可以看到项目摘要；修改时应使用 `/gate <project> pause|resume|...`。
- Host 日志中不应出现 `tools.guard is unavailable` 或 `subagent restriction is not installed`。
- 在受管 session 中，subagent/workflow、grep/rg 工具和 bash 的 grep/rg 调用应被拒绝，read 工具仍可使用；同样操作在未受管外层窗口不应被 Gate 拦截。

### 4. 派发和交接行为正常

在测试项目或确认不会触发真实工作后再做行为验收。`/gate <project> tick` 可能真的派发任务，不是只读命令。

正常派发应表现为：

1. control state 命中某 job；
2. 对应 session 为 live + idle，inbox 为空；
3. 日志出现类似：

   ```text
   dispatch-gate: builder-dispatch -> session-... (building, state_changed)
   ```

4. 目标窗口收到以 `[DISPATCH GATE]` 开头、包含正确 project/state 的 followup；
5. status 中该 job 出现 `status: "sent"` 和新的 `lastDispatchAt`；
6. 立即再次 tick 不会重复发送，通常显示 `state_unchanged`。

正常跳过应表现为：

- session running → `agent_busy`，不向 inbox 追加旧 tick；
- inbox 已有消息 → `inbox_pending`；
- state 不属于 job → `state_not_allowed`；
- 另一个项目正在占用同一 session → `session_reserved`；
- session 离线且恢复失败 → `agent_recovery_backoff`，并带 `nextAttemptAt`，不会每个 tick 重试。

正常交接应表现为：

- worker 完成后，claim 的 task/round/handoff/status/`role_session` 全部匹配；
- Gate 记录 `pendingPlannerWake`，随后只唤醒配置的 coordinator；
- claim 不完整或 session 不匹配时显示 `worker_incomplete`，且不得把错误执行者当成合法交接；有效的 completed claim 由 coordinator 接手后，原 worker job 才可能显示 `claim_completed`；
- 峰段 pause 仍允许已完成 worker 的交接，但不会启动下一轮 worker。

### 5. 不应出现的现象

出现以下任一情况都不能算部署成功：

- `agent_unresolved`：角色没有解析到 session，通常是 `agentIds` 或 alias 错误；
- `lastError` 长期为 control check 失败；
- 两个项目写入同一个 `stateDir` / `statusPath`；
- 旧 Schedule 和 Gate 同时向同一角色派发，产生双消息；
- 非 `uiShowIn` session 出现状态条，或暂停 A 项目却暂停了 B 项目；
- `role_session` 不匹配仍触发 coordinator handoff；
- 离线恢复或 transport timeout 在短时间内无退避重复刷屏；
- 正常重启后长期停在 `pauseSource: "unclean"`；
- Gate 管理的窗口仍能绕过限制创建 subagent/workflow。

最小验收结论应记录：测试数量、profile 装载结果、每个项目的 `/gate <project> status json`、角色→session 映射、旧 Schedule 处理结果，以及一次“应派发”和一次“应跳过”的证据。

## 默认三个 job

内置示例仍对应原来的三条任务，但它们只是默认值，不是插件限制：

| job | 角色 | state 条件 | 重试间隔 |
|---|---|---|---|
| `coding-dispatch` | coding | `assigned_coding` | 300s |
| `acceptance-dispatch` | acceptance | `awaiting_verification` | 300s |
| `planner-dispatch` | planner | `idle` / `assigned_coding` / `awaiting_verification` / `verified` / `submitted` | 600s |

触发规则：

- **事件驱动**：`watchDir`（默认 `plans/control`）里 state/HISTORY/验收产物一写，约 300ms 内触发一次 tick，不等 10s/5min 定时
- **state 变化**：立即判断一次
- **目标角色 live 但 busy / 收件箱有货**：每 `busyRetryMs`（默认 2s）重试，直到它 idle，不等 `retrySeconds`
- **state 没变且空闲**：等 `retrySeconds` 后再判断一次（兜底）
- 每次判断都必须满足：`agent.status === "idle"` 且 `agent.inbox.hasPending === false`
- 忙/没活/收件箱有货：跳过，不排队、不补发
- **worker 完成校验**：coding/acceptance 从 running 变 idle 时，检查当前 `task/round` 的 claim 是否 `completed` 且 `handoff_sha256` 与 state 一致。是 → 打上 `pendingPlannerWake`，叫醒 planner 做交接；不是 → 标记 `worker_incomplete`，**不叫 planner**。
- **启动补唤醒**：启动后首个 tick 检查 `state` 仍是 `assigned_coding` / `awaiting_verification` 但对应 claim 已 `completed` 的情况，自动补一次 planner 唤醒，修复重启/暂停期间漏掉的交接。
- **交接去重**：同一份 completed claim 在一个进程内只唤醒一次 planner；真正的重启会重新做一次启动恢复检查。
- **离线自动恢复**：配置角色的 session 离线时，通过 DSH Session Controller 按持久化会话及原 preset 自动恢复；恢复本身不发送新 followup，控制 state 未变化时不会重放上一轮。
- **恢复退避持久化**：恢复失败按 5s 起步指数退避（默认上限 5min，20% jitter），`attempts` / `nextAttemptAt` 写入 `state.json`，进程重启不会清零后形成恢复风暴。
- **上游 transport 退避**：bundle 将 DeepSeek API-key/account 两条 provider 的 transient retry 从默认 5 次、500ms 起步收紧为最多 2 次、5s 起步（上限 60s，20% jitter），避免 timeout/transport 在多个 session 间叠加。

## 自定义角色

角色名不再写死为 planner / coding / acceptance。每个项目通过以下字段定义自己的角色模型：

- `jobs[].agent`：任意角色名及其允许触发的 control states
- `coordinatorAgent`：接收 worker 完成交接的协调角色，默认 `planner`
- `workerStateRoles`：需要 completed-claim 校验的 `state → worker role` 映射
- `workerRoles`：可选附加 worker 列表；`workerStateRoles` 中的角色始终自动纳入
- `controlChangeRoles`：可选控制面交接角色；省略时使用 `coordinatorAgent`
- `uiShowIn`：显示 Composer 状态条的角色；省略时使用 `coordinatorAgent`
- `agentIds`：该项目的 `role → session id` 映射

例如：

```yaml
coordinatorAgent: lead
workerStateRoles:
  researching: researcher
  reviewing: reviewer
uiShowIn: [lead, reviewer]
agentIds:
  lead: session-...
  researcher: session-...
  reviewer: session-...
jobs:
  - id: research-dispatch
    agent: researcher
    states: [researching]
    promptFile: /absolute/path/researcher.md
  - id: review-dispatch
    agent: reviewer
    states: [reviewing]
    promptFile: /absolute/path/reviewer.md
  - id: lead-dispatch
    agent: lead
    states: [idle, researching, reviewing, done]
    controlOnlyStates: [researching, reviewing]
    promptFile: /absolute/path/lead.md
```

## 多项目并行

顶层 `projects` 是项目实例数组。每个项目都有独立的：

- `check.cwd` / `check.command`
- control state、watcher 和 mailbox 路径
- jobs、角色映射和 session 映射
- pause、handoff、offline-recovery 状态
- `stateDir` 和 `statusPath`

省略路径时自动使用项目隔离路径：

```text
~/.dsh/storages/dispatch-gate/<project>/
<check.cwd>/logs/dispatch-gate/<project>/status.json
```

示例：

```yaml
projects:
  - project: project-a
    agentIds:
      lead: session-...
      builder: session-...
    coordinatorAgent: lead
    workerStateRoles: {building: builder}
    check:
      cwd: /work/project-a
      command: [.venv/bin/python, control.py, status, --json]
    jobs: [...]

  - project: project-b
    agentIds:
      planner: session-...
      coding: session-...
    check:
      cwd: /work/project-b
      command: [.venv/bin/python, control.py, status, --json]
    jobs: [...]
```

项目名必须由字母、数字、点、下划线或连字符组成，并且不能使用 `status` / `pause` / `resume` / `force` / `auto` / `tick`。

建议每个并行项目使用独立 session，并显式配置 `agentIds`。同一 session 属于多个项目时，读取状态仍可用，但修改命令必须显式写项目名，防止暂停错项目。

## 峰谷定时

默认启用北京时间峰谷策略：

```text
高峰：周一至周五（不含中国法定节假日）
      09:00-12:00、14:00-18:00
其余：午休、夜间、周末、法定节假日全天
```

- 峰段自动 paused；正在跑的 turn 不杀
- 谷段自动恢复
- `/gate pause` 手动暂停优先
- `/gate resume` 回到自动峰谷；峰段内会保持暂停
- `/gate force` 强制运行，忽略峰段，直到手动暂停
- `/gate auto` 清除强制，回到峰谷策略
- **paused 只阻止新工作**：不会杀掉正在跑的 worker turn。worker 完成后如果 claim 已 `completed` 且 `role_session` 精确等于该角色配置的 session，仍会唤醒 planner 完成交接。峰段 pause 永远放行这种交接，只冻结新轮次；manual / unclean pause 可用 `pauseAllowsHandoff: false` 冻结交接。pause 后仍在运行的 worker 会按 `busyRetryMs` 继续观察，直到它 idle 并完成交接。
- **pauseSource**：状态文件和 `/gate status json` 明确输出 `manual` / `peak` / `unclean`（未暂停时为 `null`），不再依赖多个布尔值猜测暂停来源。
- **pendingPlannerWake 持久化**：worker 完成产生的待唤醒标记会写入 `state.json`；重启或暂停后仍然保留，planner 空下来后继续投递。

2026 法定节假日按国办发明电〔2025〕7号内置；2027 年通知发布后更新 `holidays` 配置。

周末调休上班日仍按“周末 = 谷段”处理，与用户规则一致。

## Composer 状态条与暂停

这个版本带一个可选的 Client 半，注册在 `conversation.input.dock`（输入框上方）：

```text
调度闸门  ▾ ● 已暂停  state=awaiting_verification        [恢复]
coding idle · acceptance idle · planner idle
上次检查 3s · 上次派发 15:10:52 · 消息总线 planner:coding
```

- Client 通过当前 session 执行 `/gate status json`；Host 自动解析该 session 属于哪个项目，不依赖硬编码 session id
- 默认只在各项目的 `coordinatorAgent` 窗口显示；`uiShowIn` 可配置多个任意角色
- 同一 session 命中多个项目时，Host 返回项目 registry，Client 选择其中允许显示的项目，并在操作命令里带上明确项目名
- `▾` / `▸` 收起/展开；选择记在 localStorage
- dispatch 头会带稳定的 `Project` 和当前 control `state`；task / round / sequence 由 prompt 每次从控制面读取，不缓存进 Gate 配置
- Host 明确返回 `running: false` 或命令读取失败时，状态条显示“未运行”或错误；不会仅凭状态时间较旧误判 Host 已离线
- `[暂停]` / `[恢复]` 调用 `/gate pause` / `/gate resume`
- **暂停只暂停 gate 的新工作派发**；bus 的收发、blocker 通知不受影响；已运行 worker 的 completed claim 交接仍会唤醒 planner
- 当前 session 只属于一个项目时，可以输入 `/gate status`、`/gate pause`、`/gate resume`、`/gate tick`
- 多项目或非受管窗口可使用 `/gate <project> status|pause|resume|force|auto|tick`

Client 使用现有的 `commands` 执行 `/gate` 并读取 JSON 状态，不新增自定义 Remote 服务。`commands` 在 Host 的 static `inject` 里直接注册，不靠延迟 `ctx.inject`。

## 重启与 `uncertain`

- 正常情况下 Ctrl+C，gate 会写 `state.json`、删掉 `run.lock`
- 强杀/崩溃后 `run.lock` 还在，下次启动 **默认 paused**，状态条显示“上次未正常关闭”
- 恢复时只按当前 `control.py state` 判断一次，不回放旧 tick
- **启动恢复 completed claim**：如果当前 state 命中 `workerStateRoles`，且对应 worker claim 已 `completed` 并与当前 handoff 匹配，启动后自动补一次 coordinator 唤醒（即使启动时是 peak pause 也照常交接）
- **pendingPlannerWake 持久化**：worker 完成但 coordinator 忙/离线时，待唤醒标记和 claim 身份会写入 `state.json`；重启后继续尝试，不会因为重启丢掉交接
- **worker_incomplete**：worker 变 idle 但 claim 不是 `completed` 时，job 状态标为 `worker_incomplete`，不叫 planner；等 claim 补齐或下一轮 retry 再继续
- 如果正在 dispatch 时被强杀，状态可能停在 `attempting` / `uncertain`；等下一次 tick 重新判断，不立刻补发

单项目旧配置的持久文件保持不变；`projects[]` 中未显式配置路径的项目使用 `<project>` 隔离目录：

```text
~/.dsh/storages/dispatch-gate/state.json   # 暂停、上次 dispatch、attempt
~/.dsh/storages/dispatch-gate/run.lock     # 非正常关闭检测
~/.dsh/storages/dispatch-gate/status.json  # Gate 自身的只读诊断快照
<check.cwd>/logs/dispatch-gate/status.json # 同一快照的 workspace 副本
```

## 角色怎么找

优先读 `agent-bus` 的 `state.json`：

```text
~/.dsh/storages/agent-bus/state.json
```

其中 alias key 与 `jobs[].agent` 的任意角色名一致。
如果你不想依赖 bus，也可以在 Config 里写死：

```yaml
agentIds:
  coding: session-...
  acceptance: session-...
  planner: session-...
```

`agentIds` 优先于 bus 别名。多个项目复用相同角色名但绑定不同 session 时，必须在每个项目里显式配置 `agentIds`，不能共用一套全局 alias。

## 手动安装（不推荐，官方本地 bundle）

除非已经熟悉 DSH profile、session 和 control 协议，否则先阅读[已有配套控制面的项目怎么用](#已有配套控制面的项目怎么用)和[新项目要满足什么条件](#新项目要满足什么条件)。以下步骤适合需要自己维护 YAML 的用户。

从 GitHub 克隆后，通过官方命令安装：

```bash
git clone https://github.com/AS2834/dsh-dispatch-gate.git
cd dsh-dispatch-gate
./install.sh
```

等价：

```bash
export PATH="/opt/homebrew/bin:$PATH"
dsh plugin --profile web add /absolute/path/to/dsh-dispatch-gate
```

安装后：

1. 在插件列表确认名字是 **Dispatch Gate / 调度闸门**，不是“自动化任务”
2. **先不要启用**；找出与 Gate jobs 重复的 DSH Schedule `every` 任务并停用
3. 确认旧 dispatch 不再触发后，再让 Gate 开始工作
4. 用 `dispatch-gate` 的日志确认它只在 state 匹配 + idle 时发
5. Host+Client 版本需要重启 DSH 并在浏览器刷新后，composer 状态条才出现；只改 Host 不会热加载 Client 半

> 默认示例对应的旧任务：
> - coding `every 300s`
> - acceptance `every 300s`
> - planner `every 600s`
>
> 插件 `dsh-schedule` 本身可以保留，用来做别的提醒；只删这三条 dispatch 任务。

## 配置

`cordis.patch.yml` 已使用 `projects[]` 给出默认配置；旧的顶层 `project/check/jobs` 单项目写法仍然兼容。完整字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `projects` | `[]` | 多项目实例数组；非空时忽略顶层旧式单项目的 runtime 字段 |
| `projects[].project` | 必填 | 唯一项目名，也是 `/gate <project> ...` 的路由键 |
| `projects[].stateDir` | 按 project 隔离 | 项目 pause、handoff、恢复退避和 run lock |
| `projects[].statusPath` | 按 project 隔离 | 相对各自 `check.cwd` 的状态快照 |
| `pollMs` | `10000` | 确定性检查周期 |
| `initialDelayMs` | `5000` | 启动后首次检查延迟 |
| `aliasStatePath` | bus `state.json` | 角色别名来源 |
| `stateDir` | `~/.dsh/storages/dispatch-gate` | 持久状态、run lock、绝对 status 文件 |
| `statusPath` | `logs/dispatch-gate/status.json` | 只读状态快照；相对 `check.cwd`，多项目默认带 project 子目录 |
| `busLogPath` | bus `messages.jsonl` | composer 里 bus 最后一行的来源 |
| `watchDir` | `plans/control` | 事件驱动的目录；state/HISTORY/验收产物写入即 tick |
| `watchDebounceMs` | `300` | watch 事件合并窗口 |
| `busyRetryMs` | `2000` | 目标角色 live 但 busy/收件箱有货时的短重试 |
| `offlineRecoveryEnabled` | `true` | 配置角色 session 离线时按持久化会话自动恢复；pause 不阻止恢复，但恢复不会创建新轮次 |
| `offlineRetryInitialDelayMs` | `5000` | 离线恢复失败后的首次退避 |
| `offlineRetryMaxDelayMs` | `300000` | 离线恢复指数退避上限 |
| `offlineRetryJitterRatio` | `0.2` | 离线恢复退避的对称 jitter 比例 |
| `peakScheduleEnabled` | `true` | 启用北京峰谷定时 |
| `timeZone` | `Asia/Shanghai` | 峰谷判断时区 |
| `peakWindows` | `["09:00-12:00","14:00-18:00"]` | 工作日高峰窗口 |
| `holidays` | 2026 法定节假日 | 这些日期全天谷段；2027 发布后更新 |
| `controlChangeRoles` | `coordinatorAgent` | 哪些角色参与控制面交接；pause 时允许这些角色做 completed-claim 交接 |
| `coordinatorAgent` | `planner` | 规划角色名 |
| `requireCoordinatorIdle` | `true` | planner 忙时不派发其他 job |
| `workerStateRoles` | `{assigned_coding: coding, awaiting_verification: acceptance}` | 控制面 state → 负责该轮 claim 的 worker 角色；claim 校验和交接恢复使用 |
| `workerRoles` | `[]` | 可选附加 worker 角色；与 `workerStateRoles` 推导结果合并 |
| `pauseAllowsHandoff` | `true` | manual / unclean pause 时是否仍允许 completed worker claim 唤醒 planner；峰段 pause 始终允许交接 |
| `project` | `default` | 写进 dispatch 头/状态的稳定 scope 名字；task/round 不写进配置，由 control.py 每次动态读取 |
| `uiShowIn` | `coordinatorAgent` | 哪些角色窗口显示该项目状态条 |
| `agentIds` | `{}` | 角色 -> session id，优先于别名 |
| `requireIdle` | `true` | 只对 idle 窗口发 |
| `skipIfInboxPending` | `true` | 收件箱有未处理消息就不发 |
| `check.cwd` | 必填 | `control.py` 工作目录 |
| `check.command` | 必填 | 固定 argv，不经过 shell |
| `check.timeoutMs` | `15000` | 检查超时 |
| `jobs[].states` | 必填 | 允许触发的 state |
| `jobs[].retrySeconds` | `300` | state 不变时的重试间隔；0 表示只在状态变化时触发 |
| `jobs[].promptFile` | 必填 | 原 dispatch prompt |
| `jobs[].enabled` | `true` | 单独开关 |

`check.command` 是数组，直接 `execFile`，不拼 shell；消息正文不会被当命令执行。

## 测试

```bash
cd /absolute/path/to/dsh-dispatch-gate
node --test test/*.test.js
```

覆盖：

- state 允许/不允许
- 窗口 running -> 不发
- 收件箱 pending -> 不发
- state 变化 -> 发一次
- state 不变、未到重试时间 -> 不发
- 到重试时间 -> 再发
- control.py 失败 -> 不发，只记日志
- bus 别名解析
- dispose 后不再 tick
- pause 后不 dispatch，status.json 显示 paused
- run.lock 残留 -> 启动 paused；正常 dispose 删除 lock
- `/gate status` 返回 peers / last message，pause/resume 切换
- 配置 session 离线后自动恢复，且 state 未变化时不重放 dispatch
- 任意自定义 worker/coordinator/UI 角色均从项目配置推导
- 多项目 manager 按 session 自动路由，歧义修改要求显式项目名
- 工具 guard 只在受管 session 阻止 subagent/workflow 和 grep/rg，并在 dispose 时注销
- 离线恢复失败指数退避，`nextAttemptAt` 持久化并在重启后保留
- 两条 DeepSeek provider 都使用最多 2 次、5s 起步的 timeout/transport 退避
- pause 后 worker 完成且 claim 已 completed -> 仍唤醒 planner 做交接
- pendingPlannerWake 写入 `state.json`，重启后恢复并投递
- 启动时 state 仍为 assigned/awaiting 且 claim 已 completed -> 自动补一次 planner 唤醒
- worker idle 但 claim 未 completed -> `worker_incomplete`，不叫 planner
- 旧 persisted wake 对应的 claim 未 completed -> 不叫 planner
- 侧边栏标题不是“自动化任务”
- client 半声明、composer slot、按 session/project 的 commands 路由

## 卸载/回滚

```bash
cd /absolute/path/to/dsh-dispatch-gate
./uninstall.sh
```

回滚：

1. 卸载 gate
2. 重新创建/启用先前停用的 Schedule dispatch 任务
3. 不需要改控制面或仓库

## 当前不能做到的事

### 不是任务系统或工作流引擎

- Gate 不创建任务、不决定下一步工作，也不维护 DAG、优先级或任务队列。它只读取现有控制面并决定是否唤醒窗口。
- Gate 不替项目写控制面文件，例如 `INDEX`、项目自己的 `state.json`、`PAUSE.json`、`roles.json`、claim 或 handoff。`<stateDir>/state.json` 是 Gate 自己的调度持久状态，不是项目控制面。
- Gate 不自动创建角色窗口、session、agent-bus alias、prompt 或 `control.py`，也不会替人判断每个 control state 应交给哪个角色。
- 每个项目只接受一套控制协议：`check.command` 必须输出含非空 `state` 的 JSON；completed-claim 交接还要求协议提供 task、round、claims、handoff hash 和精确 `role_session`。

### 不是无限并行或分布式调度

- 多项目可以并行，但一个 session 同一时间仍只能安全处理一个 turn。故意跨项目共享 session 时会被进程内 lease 串行化，不会变成真正并行。
- dispatch lease 只在当前 DSH Host 进程内生效，不是跨进程、跨机器的分布式锁；不要让两个 Host 实例同时管理同一 session 和项目状态目录。
- Gate 不提供跨机器队列、集群选主或全局 exactly-once 保证。进程在发送边界硬崩溃时会进入 `attempting` / `uncertain`，重启后重新检查当前事实，而不是盲目重放。
- 状态条只展示当前 Host、当前配置项目和角色，不是跨主机 fleet dashboard，也不主动发送外部告警。

### 恢复能力有前提

- 离线自动恢复只适用于 DSH Session Controller 能重新载入的普通持久化 session。已删除、不可持久化、归属其他父任务的 subagent session，或仍被其他 writer 占用的 session，Gate 无法强行恢复。
- 恢复失败会退避并显示状态，但 Gate 不会自动修复损坏的 profile、缺失的 preset、错误 session ID 或失败的控制脚本。
- 控制面检查失败时 Gate 只记录 `lastError` 并跳过，不会自动修改项目、通知 planner 或执行补救命令。
- 窗口忙时只延后重新判断，不会把旧 tick 排队；它也无法中断、迁移或接管已经运行的模型 turn。

### 配置和策略仍需人工维护

- 插件不会自动停用旧 Schedule。若旧任务与 Gate 同时存在，仍可能发生重复派发，部署验收必须显式检查。
- 配置、Host 或 Client 变更不保证热加载；应重启 DSH，Client 变化后还要刷新浏览器。
- 内置节假日目前只覆盖 2026 年。周末调休上班日仍按周末谷段处理；2027 及之后需要更新 `holidays`。
- transport 重试收紧目前只覆盖 bundle 中两条 DeepSeek provider row，不会自动改写其他 provider 的 retry 策略。
- 相对 `promptFile` 按插件目录解析，不按项目 `check.cwd` 解析；项目自有 prompt 推荐使用绝对路径。
- agent-bus alias 是全局名称。同名角色在不同项目绑定不同窗口时，必须为各项目显式配置 `agentIds`。
- 受管 session 对 subagent/workflow 和 grep/rg 的限制当前是安全边界，不提供按项目关闭的配置；需要临时并行探索时应在未受管的外层窗口完成。

### 安全边界不会代替业务校验

- Gate 不执行 followup 消息正文，只用固定 argv 运行配置中的 `check.command`；它也不修改 DSH 核心或 `agent-bus`。
- 精确 `role_session`、task/round/handoff 校验只能证明执行者与交接记录符合协议，不能证明模型产出的代码或验收结论本身正确。
- `/gate <project> tick` 是有副作用的人工触发，可能真实派发工作；它不是 dry-run。当前没有单独的“只模拟本次派发决策”命令。
