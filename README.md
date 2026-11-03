[English](README.en.md) | 简体中文

# Dispatch Gate / 调度闸门

Dispatch Gate 是一个 DSH 本地调度插件，用于在多个长期运行的 DSH 窗口之间
自动交接任务。它读取项目控制面的状态，判断当前应由哪个角色工作，并仅在目标
窗口空闲时发送预设提示。

典型流程：

```text
planner -> coding -> acceptance -> planner
```

插件不会创建 Agent，也不会修改控制面状态。它负责窗口调度和消息投递，任务
状态、轮次和交接条件由项目自己的控制面维护。

## 功能

- 按控制面状态、角色和重试间隔派发提示
- 发送前检查目标窗口是否 live、idle，收件箱是否为空
- 监听控制目录、`SYNC.md` 和 reviewer mailbox 的变化
- 目标忙碌时短间隔重试，不向队列堆积重复提示
- 持久化运行状态、锁文件和状态快照
- 提供 Composer 状态条，支持暂停、恢复和强制运行
- 可选的峰谷定时
- 提供 `/gate` 命令用于查看状态和手动控制

## 工作方式

```text
控制面命令 -> JSON 状态 -> gate 评估任务
                              |
                              +-- 目标是否 live
                              +-- 目标是否 idle
                              +-- 收件箱是否为空
                              +-- 状态和重试条件是否匹配
                              |
                              v
                       followup + flush
```

gate 只读取控制面输出，不写入控制面文件。每次派发前都会重新检查目标窗口状态，
因此不会向正在工作的窗口插入消息。

## 环境要求

- DSH `^0.2.1-rc.2`
- Node.js
- pnpm
- 一个输出控制面 JSON 的命令

## 安装

从源码安装：

```bash
git clone https://github.com/AS2834/dsh-dispatch-gate.git
cd dsh-dispatch-gate
./install.sh
```

也可以直接使用 DSH 的本地插件安装命令：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-dispatch-gate
```

安装脚本执行相同的安装步骤，并打印后续配置提示。

## 配置

安装后编辑 `cordis.patch.yml`，将示例路径和命令替换为项目实际配置：

```yaml
- insert:
    - id: dispatch-gate
      name: dsh-dispatch-gate
      # 配置完成后删除此行
      disabled: true
      config:
        project: my-project
        check:
          cwd: /absolute/path/to/project
          command: [python3, tools/control.py, status, --json]
        jobs:
          - id: coding-dispatch
            agent: coding
            states: [assigned_coding]
            promptFile: ./prompts/coding.md
```

主要配置项：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `pollMs` | `10000` | 兜底轮询间隔 |
| `initialDelayMs` | `5000` | 首次检查延迟 |
| `watchDir` | `plans/control` | 控制面事件目录 |
| `mailboxDirs` | `["plans/mailbox/codex"]` | reviewer 回复目录 |
| `syncFiles` | `["plans/control/SYNC.md"]` | 可触发检查的同步文档 |
| `statusPath` | `logs/dispatch-gate/status.json` | Composer 读取的状态文件 |
| `project` | `default` | 派发头中的项目名称 |
| `uiShowIn` | `[]` | 显示状态条的角色；空表示所有被管理角色 |
| `agentIds` | `{}` | 角色到 session id 的映射 |
| `aliasStatePath` | 未设置 | 可选的 bus alias 文件 |
| `requireIdle` | `true` | 仅向 idle 窗口派发 |
| `skipIfInboxPending` | `true` | 收件箱有消息时跳过 |
| `maxConcurrentAgents` | `1` | 同时允许运行的 gate 管理窗口数 |
| `syncWakeCooldownMs` | `30000` | SYNC 触发 planner 唤醒的冷却时间 |
| `dispatchCooldownMs` | `10000` | 任意派发后的全局冷却时间 |
| `peakScheduleEnabled` | `false` | 是否启用峰谷定时 |

任务配置支持：

- `agent`：角色名称
- `states`：允许派发的控制状态
- `controlOnlyStates`：协调者需要等待 worker 事件的状态
- `promptFile`：提示文件路径
- `retrySeconds`：状态不变时的兜底重试间隔
- `enabled`：设为 `false` 可停用该任务

完成配置后重启或刷新 DSH，并在插件管理器中启用 `Dispatch Gate`。


## 角色配置

gate 不自动发现角色，也不创建 session。每个 job 的 `agent` 是角色名称，实际目标
session 按以下顺序解析：

1. `agentIds[role]`
2. `aliasStatePath` 指向的 bus alias 文件中的 `role`
3. 如果 `role` 本身是 session UUID，则直接使用

推荐在配置中显式写出 `agentIds`：

```yaml
config:
  agentIds:
    planner: session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
    coding: session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
    acceptance: session-cccccccc-cccc-4ccc-8ccc-cccccccccccc
```

如果使用 bus alias 文件，内容形如：

```json
{
  "planner": "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "coding": "session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "acceptance": "session-cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

`agentIds` 的优先级高于 alias 文件。找不到角色对应的 session 时，该 job 会跳过，
不会向未知窗口发送消息。

### 三个角色的 job 示例

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

字段说明：

- `agent`：角色名称；同一个角色只能对应一个 session
- `states`：控制面处于这些状态时，允许派发该角色
- `controlOnlyStates`：协调者需要等待 worker 事件的状态。planner 在这些状态下
  不会因普通轮询被唤醒，而是在 coding/acceptance 完成或外部文件变化后触发
- `promptFile`：该角色的提示文件；每个角色一份
- `retrySeconds`：状态没有变化时的兜底重试间隔
- `enabled`：设为 `false` 可停用该 job

角色对应的 session 必须处于 live 状态。窗口关闭或 session 离线时，gate 会跳过
该角色，不会自动恢复窗口。

### 状态条显示的角色

`uiShowIn` 使用角色名称：

```yaml
uiShowIn: [planner, coding]
```

留空 `[]` 表示在所有被 gate 管理的角色窗口中显示状态条。


## 并发控制

gate 默认只允许一个由它管理的窗口运行：

```yaml
maxConcurrentAgents: 1
```

当 coding 正在运行、等待，或收件箱里还有待处理消息时，即使 planner 收到了新的
同步事件，planner 也会进入 `peer_busy` 状态等待，直到 coding 完全空闲。这样可以
让本地角色串行执行，避免多个 session 同时向上游发起模型请求。

每次派发后还有 `dispatchCooldownMs` 全局冷却，防止 DSH 状态尚未更新时连续派发
下一个角色。

如果需要并行执行，可以调大该值，但不建议与同一个 provider 的高并发请求一起使用。

`syncWakeCooldownMs` 控制 `SYNC.md` 触发的 planner 唤醒冷却时间，默认 30 秒，
用于避免 planner 自己写 SYNC 后再次唤醒自己的循环。

## 控制面接口

gate 调用 `check.command`，读取标准输出中的 JSON。至少需要以下字段：

```json
{
  "state": "assigned_coding",
  "task": "T-1",
  "round": "r01",
  "sequence": 17
}
```

控制工具和状态机由项目提供。gate 不使用除 `state` 之外的字段做调度判断，但会将
`task`、`round` 和 `sequence` 写入派发头，便于角色确认当前上下文。

## 使用

1. 打开所有需要参与流程的 DSH 窗口，保持 session 处于 live 状态。
2. 启用插件并确认配置中的角色和 session id 正确。
3. 在任意窗口执行：

```text
/gate status
```

正常状态示例：

```text
gate: running · connected · scheduled
project=my-project · control=assigned_coding
planner=idle, coding=idle, acceptance=idle
```

4. 在 gate 管理的窗口中，输入框上方会显示 Composer 状态条，默认收起：

```text
▸ 调度闸门 · 运行中
```

展开后可查看各角色状态、刷新状态、暂停或恢复调度。

## 命令

| 命令 | 说明 |
|---|---|
| `/gate status` | 查看简要状态 |
| `/gate status json` | 查看完整状态 JSON |
| `/gate pause` | 暂停派发 |
| `/gate resume` | 按峰谷计划恢复 |
| `/gate force` | 忽略峰段强制运行 |
| `/gate auto` | 清除强制运行，恢复自动计划 |
| `/gate tick` | 立即执行一次检查 |

## 峰谷定时

启用 `peakScheduleEnabled` 后，默认按北京时间运行：

- 高峰：周一至周五 09:00–12:00、14:00–18:00，不含中国法定节假日
- 其余时间：谷段，正常派发

2026 年法定节假日已内置。下一份官方通知发布后，更新 `holidays` 配置。
该功能默认关闭。

## 运行文件

运行后会生成：

```text
<check.cwd>/logs/dispatch-gate/status.json
~/.dsh/storages/dispatch-gate/state.json
```

这些文件用于状态展示和重启恢复，不应提交到 git。

## 与 subagent 的区别

subagent 是父 Agent 创建的子执行，适合范围明确的一次性任务，结果返回父 Agent。

Dispatch Gate 管理多个独立的长期窗口。每个窗口有自己的上下文、工具和权限，
外部控制面决定何时切换角色。插件不创建子 Agent，也不汇总执行结果。

## 限制

- 目标窗口必须保持 live；插件不会自动恢复关闭的窗口
- 一个 gate 实例管理一个项目；并行项目需要多个实例
- 不负责架构、安全边界和提交授权决策
- `prompts/` 中的内容是示例，需要按项目调整
- 插件不直接读取或修改 `PAUSE` 文件；暂停逻辑由控制命令或 planner prompt 处理

## 开发

运行测试：

```bash
node --test test/*.test.js
```

## License

MIT
