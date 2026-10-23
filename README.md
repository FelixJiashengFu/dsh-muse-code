# Muse Code for DeepSeek Harness

在 DeepSeek Harness 里直接使用 Meta 的 [Muse Code](https://muse.meta.ai)：输入框左侧的 **Muse** 开关打开后，右侧边栏出现 Muse Code 面板；聊天里的工具与面板共享**同一个会话**。

## 工作方式

```
DSH 浏览器 (lib/client.js)
  ├─ 输入框左侧开关  conversation.input.left
  └─ 右侧边栏标签  sidebar.right.pane.tab  (key/kind: muse-code)
        ▲ SSE /plugins/dsh-muse-code/events
        │
DSH Host (lib/index.js)
  └─ MuseController (lib/controller.js) ── NDJSON JSON-RPC ──> muse serve  (MSP schema v1)
        ▲
        └─ 聊天工具: muse_open / muse_prompt / muse_read / muse_status / muse_interrupt
```

- Host 侧只启动**一个** `muse serve` 子进程、一个 MSP 会话；面板、开关、聊天工具读写的都是这份状态。
- 面板使用原生右侧边栏（`ctx.sidebarRightTabs.register` 注册 tab 类型 + `sidebar.right.pane.tab` 注册内容槽），不是 iframe。
- 审批与提问只能在面板里由**用户**决定：`approval/decide`、`userInput/answer` 只有面板的 HTTP 路由会调用，聊天工具只能读取待办。
- 聊天工具把结果画进当前对话的同时，`muse_open` 还会触发 `open-panel` 事件，让面板自动出现在右侧边栏——所以从聊天里打开和从开关打开看到的是同一个视图。

## 开关

- **关闭**：`session/leave` + 结束 `muse serve` 子进程；聊天工具随后会提示先打开开关。关闭不会删除 Muse 自己的会话日志。
- **开启**：读取 `%LOCALAPPDATA%\Programs\muse\.muse-version`，定位 `muse-bin-<version>.exe`（绕过 launcher 的在线更新检查），以
  `serve --provider meta --trust-workspace` 启动；然后在工作区根目录执行 `session/start`（审批模式 `onRequest`）。
  用户开启「无沙箱模式」时，spawn 追加 `--disable-sandbox`（见下节）。
- **工作区**：优先取发起操作的 DSH 会话的项目目录（聊天工具用当前 agent 的目录；面板开关用 slot 提供的 `sessionId`，
  取不到时退回当前工作目录），并记进状态文件；重启插件后按记住的目录恢复。第一个打开 Muse 的 DSH 会话决定工作区，
  之后的会话沿用（见「已知限制」）。
- **状态文件**：`~/.dsh/muse-code.json`，内容 `{ enabled, disableSandbox, workspace }`。插件重载后按它恢复开关与无沙箱选项。

## 花费上限（默认 $10，硬停止）

每次 Muse 会话都受一个**本地花费护栏**（`lib/budget.js`）约束：上限默认 **$10**，达到后自动强制停止，之后不再发起任何模型调用。护栏保证的是「最坏情况」，不是账单读数：

- **计价来源**：Muse CLI 自带的模型价格目录（`~/.local/share/muse/model-catalog/*.json`，按 `mtimeMs` 取最新一份），每个模型有 `input` / `output` / `cached` 单价（USD / 1M tokens）、`context_limit`、`output_limit`。
- **最坏成本预留**：一次调用最多花
  `R = context_limit × input单价 / 1e6 + output_limit × output单价 / 1e6`
  （上下文窗口和输出上限是硬上限，所以单次调用不可能超过 R）。**每次调用完成后**（MSP `session/tokenUsage`）记录花费；只要 `已花费 + R > 上限` 就立即锁定，而不是等真的花满 $10。**不使用平均/历史成本**做预留。
- **未知模型**：目录里查不到、或该行没有 `cost` 时，用目录中**最贵**的价格计算本地成本与预留，宁可多留余量。
- 面板顶部的花费栏实时显示 `花费 / 上限`、`剩余`、进度条（剩余不足 20% 变琥珀色）、当前安全预留 `R`，以及锁定原因与解锁表单；`muse_status` 也会输出同样的花费行。

实测最坏单次成本（本机目录）：

| 模型 | input / output / cached（USD/1M） | context_limit / output_limit | 最坏单次 |
| --- | --- | --- | --- |
| `muse-spark-1.3-contributor`（默认） | 0.10 / 0.20 / 0.002 | 1,007,997 / 128,000 | **$0.1264** |
| `muse-spark-1.3` | 1.25 / 4.25 / 0.15 | 同上 | **$1.804** |
| `muse-wonder-1.0` | 4 / 20 / 0.2 | 同上 | **$6.592** |

### 锁定与解锁

锁定后（`locked=true` 已同步落盘）：

1. 尽力 `turn/interrupt`，再 `session/leave` 并结束 `muse serve` 子进程；
2. 面板开关自动关闭；`prompt`、打开开关、聊天工具（`muse_prompt` / `muse_open`）与插件启动时的开关恢复全部拒绝（重启 DSH 不会把会话拉起来）；
3. 面板出现「已触发花费上限」提示，输入框与发送按钮禁用。

解锁只有两条路，入口是面板花费栏（**没有对应的聊天工具，模型不能自己解锁**）：

- **提高上限**：输入新的美元上限（`0 < cap ≤ 100000`）。只有 `已花费 + 当前预留 ≤ 新上限` 才会真正解锁，否则保持锁定（避免解锁后下一次调用立刻越界）。
- **重置花费记录**：清空本地账本并解锁，**保留当前上限**。面板要求输入 `RESET` 二次确认（HTTP 侧对应 `confirm: true`）。

HTTP 侧：`GET /budget` 只读，`POST /budget` 接受 `{ action: 'set-cap', capUsd }` 或 `{ action: 'reset', confirm: true }`；成功后广播 `budget` + `snapshot`。

### 账本

`~/.dsh/muse-code-spend.json`（`version: 1`）。记录上限、锁定状态与每个 Muse 会话的花费估计：

```json
{
  "version": 1,
  "capUsd": 10,
  "locked": false,
  "lockedCode": null,
  "lockedReason": null,
  "lockedAt": null,
  "spentUsdAtLock": null,
  "lastModelId": null,
  "catalogPath": null,
  "sessions": {
    "<sessionId>": { "serverUsd": 0, "localUsd": 0, "turnUsd": 0, "partial": false, "lastModelId": "muse-spark-1.3-contributor", "updatedAt": 0 }
  }
}
```

- 会话花费 = `max(serverUsd, localUsd, turnUsd)`：服务端上报的 `cumulative.cost.usd`、按模型目录重算的累计估计、逐回合累计的估计，三者取最大以避免重复计数。
- **账本损坏 → 锁定（fail-closed）**：JSON 解析失败或 `version` 不认识时，坏文件改名为 `muse-code-spend.json.corrupt-<时间戳>` 保留，插件进入锁定态（`ledger-corrupt`），绝不静默清零。
- **目录不可用 → 只拒绝、不锁定**：读不到模型目录时无法计算预留，护栏以 `catalog-missing` 拒绝新的调用（fail-closed），但保持未锁定；目录恢复后重新读取即可继续。
- 锁定原因（`lockedCode`）：`cap-reached`（已花到上限）、`safety-margin`（剩余不足以覆盖下一次最坏成本）、`ledger-corrupt`、`manual`；`catalog-missing` 只是暂停，不写锁定。

### 边界

- 护栏只管**本插件启动的** `muse serve`。你自己在终端里跑的 `muse` / `muse serve`、以及其它工具启动的 Muse 都不受这个上限约束。
- 花费是按**模型目录价格估算**的；Muse 服务端实际计费若与目录不同，估算会偏保守或偏松。服务端上报 `cost.usd` 时会一并记录（取三者最大），但不保证等于真实账单。
- 上限累计在**本机账本**里，不是 Muse 账户余额：换机器或删除账本后从零开始。

## 沙箱限制（本机实测）

`muse serve` 在本机 `initialize` 始终返回 `sandboxAvailability: "unavailable"`，因此 **Muse 的 shell 工具会直接失败**：

```
tool failed: environment failure: sandbox enforcement unavailable:
windows_elevated setup_required: windows elevated sandbox setup has not run
```

`muse sandbox windows check` 显示各项 ready，`muse exec --yolo` 能正常执行命令——故障只出现在 serve 模式，
且 `serve --disable-sandbox` 时**不会产生任何 `approval/requested`**（已实测）：
沙箱是唯一阻断层，禁用它等于完全放行、不逐条审批。

因此插件默认 fail-closed，并在面板顶部显示琥珀色告警与补救命令：

```
muse sandbox windows check
muse sandbox windows setup
```

面板里还有一个**仅用户可点**的「允许无沙箱运行（危险）」开关：开启后 spawn 追加 `--disable-sandbox`，
面板常驻红色告警，且不会再有审批卡。该开关没有对应的聊天工具，模型无法翻转它；值持久化在状态文件里。

## 工具

| 工具 | 作用 |
| --- | --- |
| `muse_open` | 打开开关并启动/复用会话（与点击开关等价），并让面板出现在右侧边栏 |
| `muse_prompt` | 给 Muse 发任务（`steer: true` 插入当前回合） |
| `muse_read` | 读取最近对话（用户、Muse 回复、工具调用、终端输出） |
| `muse_status` | 会话、回合、上下文用量、花费与安全预留、沙箱状态、待审批/待回答 |
| `muse_interrupt` | 打断当前回合 |

工具只读或驱动执行；`approval/decide`、`userInput/answer`、无沙箱开关都不暴露成工具。

## HTTP 路由

所有路由都挂在 `/plugins/dsh-muse-code` 下，且**只接受回环地址**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`，否则 403）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/state` | 当前快照 `{ ok, loading, busy, snapshot }` |
| GET | `/events` | SSE 推送（见下） |
| POST | `/enable` | `{ enabled, sessionId? }` 开关 |
| POST | `/prompt` | `{ text, steer?, sessionId? }` 发送任务 |
| POST | `/interrupt` | `{}` 停止当前回合 |
| POST | `/approval` | `{ approvalId, choiceId, requirementId, feedback? }`（用户） |
| POST | `/answer` | `{ userInputId, answers }`（用户，一次回答全部问题） |
| POST | `/mode` | `{ mode }` 会话内审批模式 |
| POST | `/options` | `{ disableSandbox }` **仅用户**（无工具对应） |
| GET | `/budget` | 花费护栏快照 `{ ok, budget }`（只读） |
| POST | `/budget` | `{ action: 'set-cap', capUsd }` 或 `{ action: 'reset', confirm: true }` **仅用户** |

SSE 事件（`data: {"type": ...}`）：

`snapshot` · `enabled` · `status` · `load` · `usage` · `budget` · `turn` · `item` · `delta` · `approval` · `approval-resolved` · `question` · `question-settled` · `prompt-ack` · `open-panel`

（`load` 是会话加载态 `session/statusChanged` 的转发；`item`/`delta` 是流式正文。未知事件类型会被面板忽略。）

### 安全要求

- 所有 **POST 必须同时带** `content-type: application/json`（缺失或不是 JSON → 415）和请求头 `x-muse-code: 1`（缺失 → 403）。
  面板是唯一的调用方，普通 HTML 表单或跨站 `fetch` 无法伪造这两个头。
- 请求带 `Origin` 头且不等于宿主自身 origin → 403。
- 请求带 `sec-fetch-site: cross-site` → 403。
- 请求体上限 64 KiB，超过 → 413。

## 已知限制

1. **不续接旧会话**：插件重载或 DSH 重启后，开关恢复为开时会**新建**一个 Muse 会话，而不是 `session/resume`；
   面板里的历史因此清空。Muse 自己的会话日志仍在磁盘上（`museHome`，默认 `~/.local/share/muse`），
   可以用 `muse resume` 在 DSH 之外找回。
2. **一个 Muse 会话被所有 DSH 会话共享**：工作区在第一次打开时固定，其它 DSH 会话拿到的仍是同一个会话、同一个工作区；
   要换工作区只能关闭再在目标会话里打开（会开始新会话，旧 transcript 不保留）。
3. **Windows 上 serve 沙箱不可用**：Muse 的 shell 工具会失败，除非用户开启无沙箱模式（等于放弃逐条审批）。
4. **无沙箱模式没有审批**：`--disable-sandbox` 下 Muse 不会发出 `approval/requested`，命令直接执行；
   插件仍把开关限制在面板里，但这是用户显式承担的风险。
5. **审批/回答只能由用户操作**：面板是唯一入口；聊天工具只能读取 `muse_status` 里的待办列表。
6. **transcript 只是本进程的内存投影**：SSE 重连或刷新页面会收到当前快照，但不会重放更早的历史；
   插件也不做 Muse 会话列表/分页浏览。
7. **关闭面板标签 ≠ 关闭 Muse**：关掉右侧标签只是收起视图，`muse serve` 仍在运行；开关才是唯一的启停入口。
8. **花费上限只管本插件**：插件只约束自己启动的 `muse serve`；用户在终端手动运行的 `muse`、其它工具启动的 Muse、
   以及 Muse 账户在别处产生的费用都不受影响。花费是按 Muse 模型目录价格估算的（服务端 `cost.usd` 也参与取最大值），
   与真实账单可能有偏差，详见「花费上限」。
9. **锁定后必须手动解锁**：`cap-reached` / `safety-margin` / `ledger-corrupt` 会持久化锁定，重启 DSH 也不会自动恢复；
   只有面板里的「提高上限」或「重置花费记录」能解除（重置需要输入 `RESET`），这是有意的 fail-closed 设计。

## 安装

```powershell
# 在 DSH 里（agent 工具）
plugin_manager install_bundle K:\Redshift\plugins\dsh-muse-code
```

改 host 半后需要重载插件（让 DSH 重新加载 `dsh-muse-code`；最稳妥是重启 DSH Web），改 client 半则刷新页面一次。

## 自检

三个脚本都不需要联网、不会启动 Muse，只用本机 node 跑：

| 脚本 | 覆盖 | 断言数 |
| --- | --- | --- |
| `test/verify-client.mjs` | 用 stub 的 `window.__ModuleLoader__` 与假 Client ctx 加载 `lib/client.js`：输入框开关、右侧栏 tab 注册与 tab 类型 `{ id: 'muse-code', kind: 'muse-code' }`、POST 带 `content-type: application/json` + `x-muse-code: 1`、面板含 `BudgetBar`、`lib/index.js` 接入了 `SpendGuard`／账本／`/budget` | 19 |
| `test/panel-render.test.mjs` | 用 mini hook runtime 真实渲染 `Panel`／`Toggle`／`ApprovalCard`／`QuestionCard`／`BudgetBar`／`SandboxNotice`：沙箱三段状态、花费锁定的解锁表单、审批备注只在 `acceptsFeedback` 时提交、多问题一次性 `/answer`、各类 item 渲染与 `reminderChild` 过滤、徽标与 `aria-pressed` | 10 |
| `test/budget.test.mjs` + `test/enforcement.test.mjs` | `SpendGuard` 计价与预留、锁定／解锁、超限后拒绝发起调用 | node:test |

```powershell
$node = C:\Users\fujia\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
& $node K:\Redshift\plugins\dsh-muse-code\test\verify-client.mjs
& $node K:\Redshift\plugins\dsh-muse-code\test\panel-render.test.mjs
& $node --test K:\Redshift\plugins\dsh-muse-code\test\budget.test.mjs K:\Redshift\plugins\dsh-muse-code\test\enforcement.test.mjs
```

另外还有一个**需要 DSH 正在运行**的端到端脚本（走面板自己的 GET `/state`、SSE `/events`、POST `/prompt` 三条通道，
发出一个真实回合并核对流式增量与最终文本）：`test/panel-transport.mjs`。它会真实调用 Muse（产生费用），只应在验收时手动跑。

```powershell
& $node K:\Redshift\plugins\dsh-muse-code\test\panel-transport.mjs
```

## 依赖

- 本机已安装 Muse Code CLI（`muse --version` 可用）且已登录。
- Muse Code 1.4.11 及以上（MSP **schema v1**）。插件只依赖 schema v1 的方法名与字段（`initialize` / `session/start` /
  `turn/start` / `approval/decide` / `userInput/answer` / 视图通知），**不校验**二进制或 schema 的 fingerprint；
  Muse 升级只要仍提供 schema v1，插件无需跟着改。
- Muse 自带的模型价格目录 `~/.local/share/muse/model-catalog/*.json`（Muse CLI 安装后即有）。目录缺失时插件仍可运行，
  但花费护栏会以 `catalog-missing` 拒绝发起新调用（fail-closed）；提供目录并重载插件后恢复。
- 花费账本 `~/.dsh/muse-code-spend.json` 由插件自动创建；损坏时会被改名为 `*.corrupt-<时间戳>` 并进入锁定态，
  需要用户在面板里重置。
