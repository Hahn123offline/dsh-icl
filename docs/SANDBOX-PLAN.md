# SANDBOX-PLAN — 让她有自己的电脑（DSH 原生沙箱可行性 + 试点设计）

> 状态：研究稿，**未改任何产品代码**。本 worktree（`C:\DSH\icl-wt\sandbox`，分支 `wt/sandbox`，基线 `e3fd594`）的改动只有 `docs/SANDBOX-PLAN.md`；实验脚本与证据都在 gitignored 的 `.state/lab/sandbox-*`。
> 日期：2026-11-06（Asia/Hong_Kong）。环境：Windows 11（`DESKTOP-1OSPUAS`），Node v26.12.1，全局安装 `@deepseek-ai/dsh`，实验模型 `deepseek-account/deepseek-flash`（云端，未占 GPU）。
> 纪律：没有重启/修改 desktop、没有改 desktop profile、没有碰 57101/54838、没有修改用户既有文件。实验新建的临时目录（`C:\Users\ai_admin\ICL-lab`、`C:\DSH\her-lab`）已删除；DSH 自动写的实验会话日志仍留在 `~/.dsh/sessions`。

---

## 0. 结论先行

### 0.1 推荐

**Phase 1 用 DSH 原生方案，但把它定义为"写边界"，不是"隔离环境"：**

- 给她一个**专用 workspace 目录** `C:\DSH\her\`（或零 ACL 修复的 `C:\Users\ai_admin\ICL\`），把它作为新建 ICL 会话的 workspace；
- 会话默认 **`workspace-write` + approval `ask`**（不是 `danger-full-access`）；
- 工具面从 `editor`（`read_file`/`write_file`/`list_dir`）**收敛到 DSH 原生 `read`/`write`/`edit`/`glob`/`grep`/`pwsh`**，`editor` 下线；
- 她的 ICL 状态（`~/.dsh/icl/state`：memory/time/focus/原文）**留在 workspace 外**，与她的文件目录物理分开；
- 越界申请走 DSH 审批链；桌面在场时由 Web UI 审批卡片回答，**不在场时由 QQ 私聊应答器回答**（新增小模块，见 §5.4-6），超时回 `cancelled`，绝不静默挂起。

**为什么是它：** 这是唯一"今天就能落地、不需要迁移账号/环境、且已经在本机实测通过"的方案。实测覆盖：写自己成功、写外面被拒、命令受限、拒绝标记与升权提示、审批拒绝/放行一次、read-only 下 PowerShell 受限（§2.2）。代价是：**它只限制写；读、网络、进程可见性都不限制**——她能读你的一切文件（同 Windows 用户），能上网。这是本方案的第一风险，也是 Phase 2 的分水岭。

### 0.2 一句话风险

> `workspace-write` 给了她"不能弄坏你的东西"，但**没有**给她"看不到你的东西"。若这条不可接受，Phase 1 之后必须上**专用 Windows 用户**（Windows 上最省迁移）或 **WSL**（要 Linux 工具链/完整强制时）。

### 0.3 需要 lead 拍板的点（详见 §5.4）

1. **目录与 ACL**：批准 `C:\DSH\her` 作为她的电脑根，并执行一次性 `icacls ... /grant ai_admin:(OI)(CI)F`（实测没有这一步，`workspace-write` 的 ACL runner 会 `SetNamedSecurityInfoW failed (Win32 5)`）。
2. **产品改动**：ICL preset 加原生工具、去掉 `editor`；desktop profile 的 `permission.defaultPreset` 从 `danger-full-access` 改为 `workspace-write`（这属于用户 profile，我不改，需 lead/用户执行）。
3. **接不接受"读不限"**：接受 → Phase 1 即可；不接受 → Phase 2 直接排专用 Windows 用户或 WSL，Phase 1 只作为过渡。
4. **QQ 审批通道**：是否批准新增审批应答器（复用 `qq_send` 三把钥匙 + `ownerQQ`，每轮 1 条的限制会约束审批消息）。

---

## 1. "她的电脑"目标形态

### 1.1 可观察定义

不是"一个沙箱"，而是四条可验收的行为：

1. 她能在自己的目录里**自由读写、建子目录、跑命令**（`git`、`node`、`pwsh`、下载文件），不需要每次问；
2. 她**改不到**你的目录、她的 ICL 状态文件、DSH 配置、系统目录；
3. 越界时**不是 EACCES 让她猜**，而是带有"这是什么模式、怎么申请"的标准拒绝；
4. 申请能到**你**（桌面卡片或 QQ 私聊），你批准一次就放行一次；你不在/不答，就失败关闭，不会偷偷放行。

### 1.2 目录布局

```
C:\DSH\her\                      ← 她的电脑根 = 会话 workspace = workspace-write 根
├─ notes\                        ← 随手记（原 editor 的用途）
├─ projects\                     ← 代码/实验
├─ downloads\                    ← 从网上拿的东西
├─ bin\                          ← 她自己的脚本/工具
└─ .trash\                       ← 删除暂存（可选）

C:\Users\ai_admin\.dsh\icl\state\  ← 她的 ICL 状态（memory.db/time.json/focus/原文），**在 workspace 外**
C:\Users\ai_admin\.dsh\sessions\   ← DSH 会话日志，**在 workspace 外**
```

规则：

- **不要**把 workspace 放在仓库里（`C:\DSH\icl` 或任何 `.state` 下）。实测：`C:\DSH` 子树继承的 ACL 是 `Authenticated Users:(M)`，没有 `ai_admin` 完全控制，ACL runner 的 `grantWrite` 直接 Win32 5（§2.4）。
- **不要**把 `stateDir` 放进 workspace：Low 完整性标签是整棵 workspace 树常驻的，状态文件会被一起放宽；而且 `editor` 现在的根就是 `stateDir`，两边会打架（§4.1）。
- **不要**用 `C:\` 根、FAT/exFAT 卷、或包含 `%TEMP%` 的目录（ACL 授权是整树传播，宽目录会慢到几十秒；FAT 无安全描述符）。
- 如果不想动 `C:\DSH` 的 ACL：`C:\Users\ai_admin\ICL\` 默认继承当前用户完全控制，**零 ACL 修复即可用**（实测通过，§2.4）。两者选一，不要混用。

### 1.3 权限模型

| 旋钮 | 值 | 说明 |
|---|---|---|
| sandbox mode | `workspace-write` | 会话创建时的默认值；由 `permission` preset 固定 |
| workspace root | 会话的不可变 `cwd` = `C:\DSH\her` | 不是 `process.cwd()`；会话建好后不可迁移 |
| writable roots | workspace + 每会话私有临时目录 | `TMP`/`TEMP` 在 spawn 前被重写到私有目录（实测：`...\Temp\dsh-XXXX`） |
| approval policy | `ask` | 升权请求交给应答者；无应答者时 `unavailable` 失败关闭 |
| 可升权目标 | `workspace-write` → `danger-full-access`（一次调用） | 封闭阶梯；不可降到更窄 |
| 谁能切模式 | 用户：UI 的 `/permission`；会话创建时的 defaultPreset | 她的工具面里**没有**切模式的入口（这是刻意的） |

**为什么默认 `ask` 而不是 `never`：** `never` 会让所有升权确定性拒绝（模型侧还会收到"不要申请"的上下文），她永远申请不到；`ask` 至少在你在场时能放行。`ask` 的代价是：**任何连着的客户端如果收到审批却不回答，工具调用会一直等**（turn 被挂住）。所以上线 `ask` 的前提是：要么桌面 UI 在场，要么 QQ 应答器带超时（§2.6）。

### 1.4 能做什么 / 不能做什么

| 能 | 不能 |
|---|---|
| 在 `C:\DSH\her` 内读写、建目录、改文件 | 写 `C:\DSH\her` 外的任何文件（除非批准一次） |
| `pwsh` 跑 `git`/`node`/`pwsh`/下载/编译 | 写 `%USERPROFILE%`、`%APPDATA%`、注册表、系统目录 |
| 读任意文件（同用户权限） | — 读不受限（这是 DSH 在 Windows 的已知边界） |
| 访问网络（curl/Invoke-WebRequest） | 受限网络/进程隔离（不在 DSH 词汇里） |
| 读/写自己的 ICL 记忆（通过 ICL 工具） | 写 `~/.dsh/icl/state` 下的 memory/time/focus/原文（工具面不指向那里） |
| 在 workspace 内装依赖（配好缓存目录后） | `npm i -g`、写全局缓存、改全局 git config（默认会被拒） |

### 1.5 为什么必须专用目录

不是洁癖，是三个实测/文档事实：

1. **写边界就是会话 cwd**。`sandbox-policy` 解析 `SessionHeader.cwd`；没有第二个可写根。要让"她的东西"和"你的东西"分开，只能靠目录分开。
2. **Windows 的授权会改真实 ACL**：workspace 上会常驻一条能力 SID 允许 ACE + 一条对 world 的 `FILE_DELETE_CHILD` 拒绝 + Low 完整性标签；`dispose()` 只撤临时授权，工作区 ACE 是永久的。把仓库/状态目录当 workspace，等于把这些副作用留在产品目录上。
3. **`editor` 的教训**：它把根锚在 `stateDir`，在 `workspace-write` 下仍能写 `stateDir`（实测 I1 成功），而写会话 workspace 反而被它自己的根规则拒绝（实测 I2 返回"不在工作区里。"且 `error=false`）。两个"工作区"同时存在时，模型无法建立正确的空间感。

---

## 2. DSH 原生沙箱到底做了什么（实测）

### 2.1 组件与责任

| 组件 | 责任 | 本机状态 |
|---|---|---|
| `dsh-sandbox-policy` | 部署默认模式 + 逐会话 `sandbox/mode`；workspace root = 会话 cwd | base 已挂载；`mode` 默认 `workspace-write`，被 profile 的 preset 覆盖 |
| `dsh-fs-sandbox` | 围栏 `ctx.fs` 的 write/edit；read/list 不 fence | base 的 `ctx.fs`（不是 `fs-local`） |
| `dsh-sandbox-windows-acl` | Windows 写限制：WRITE_RESTRICTED 令牌 + 能力 SID ACE + Low IL + Job | `sandbox-local` 的 win32 runner；`enforcement: partial` |
| `dsh-bash-sandbox` / `dsh-pwsh-sandbox` | 受限 shell 执行器；`sandbox_permissions`/`justification` 升权面 | win32 上 bash 行被禁用，pwsh 行启用 |
| `dsh-permission-presets` | 把 sandbox mode + approval policy 捆成预设；`/permission` 命令 | base 三个预设；profile 只改 `defaultPreset` |
| `dsh-user-approval` | `ask`/`never`；`approval/request` waterfall；一次性结果 | base 已挂载；无内置应答者 |

### 2.2 实测矩阵

实验 run：`.state/lab/sandbox-1`（会话 workspace 在 `.state` 下，ACL 不满足 → 暴露前置条件）、`.state/lab/sandbox-2`（workspace 在 profile 下 / `C:\DSH\her-lab` + icacls）。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| E1 | `workspace-write`，原生 `write` 写 workspace 内 | 首次 `FS_NOT_OBSERVED`（先读后写策略），`read` 后重写成功，`Updated file` | `sandbox-1/probe-report.md` seq 24-37 |
| E2 | `workspace-write`，原生 `write` 写 workspace 外 | 拒绝，精确文本：`[sandbox: file access denied under workspace-write mode]` + 升权提示 | 同上 seq 51-52 |
| E3 | 带 `sandbox_permissions=danger-full-access` 重试，应答 `rejected` | 工具结果：`the user rejected escalating this operation ... stop and explain instead of working around it`；`approval/asked`+`decided(rejected)` 入日志 | 同上 seq 66-69；`approvals.jsonl` |
| E4 | 同上，应答 `allowed-once` | 文件在 workspace 外创建成功；`decided(allowed-once)` | 同上 seq 83-86 |
| E5 | `read-only` 下 `pwsh` 写 workspace 内 | 写被拒（`New-Item: Access to the path ... is denied.`）；`LANG=ConstrainedLanguage`；`TEMP` 仍是用户 temp | 同上 seq 106-107 |
| E6 | `workspace-write` 下 `pwsh` 写 workspace 内 | 成功；`TEMP=C:\Users\ai_admin\AppData\Local\Temp\dsh-XXXX`（私有临时目录） | `sandbox-2/evidence.md` E-A |
| E7 | `workspace-write` 下 `pwsh` 写 workspace 外（终止性错误） | 非零退出，`[sandbox: file access denied under workspace-write mode]` + 升权提示 + `[exit code: 1]` | 同上 E-B |
| E8 | `workspace-write` 下 `pwsh` 写 workspace 外（非终止错误） | 退出码 0 → **不分类**，只有原始 `Access to the path ... is denied.`，无标记/提示 | `sandbox-2/evidence.md` E-A（outside 的 `New-Item`）；`sandbox-1` S5（read-only 的 `New-Item`，同样无标记） |
| E9 | workspace 在 `C:\DSH` 子树、未修 ACL | `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`（第一次 workspace-write shell 调用） | `sandbox-1/probe-report.md` seq 126-131 |
| E10 | 同上 + `icacls /grant ai_admin:(OI)(CI)F` | 写 workspace 内成功，`TEMP` 私有 | `sandbox-2/evidence.md` E-C |
| E11 | ICL 会话（`workspace-write`），`write_file` 写 `stateDir` | **成功**（`写好了。`），文件落在 `state/icl-lab/her-note.md` | `sandbox-1/probe-report.md` I1 |
| E12 | 同一会话，`write_file` 写会话 workspace | 工具返回 `不在工作区里。`，且 `isError=false`（模型会以为成功） | 同上 I2；另有一次相对路径 `her-note.md` 被写进 `stateDir` |
| E13 | `/permission workspace-write` / `read-only` | `commands.execute` 成功；`permission/preset` + `sandbox/mode` 事件入会话日志 | `sandbox-1/probe-report.md` seq 95-96、115-116 |
| E14 | 工具面 | ICL 会话 34 个工具（18,910 字符 schema），**没有** DSH 原生 `read/write/edit/glob/grep/pwsh`；standard 会话 26 个（21,826 字符） | `.state/lab/sandbox-1/tools.mjs` 输出 |

未单独实测、但由实现/文档确定的边界：

- **读不受限**：`fs-sandbox` 只围栏 write/edit（read/list 与 `fs-local` 一致）；Windows runner 只交叉检查写访问。
- **`glob`/`grep` 不走沙箱**：它们用 `ctx.subprocess` 直接跑 ripgrep，不经过 `ctx.shell`/`ctx.fs`；只读，所以 Windows 上无影响，但在"未来要读策略"的方案里是缺口。
- **网络不受限、进程可见性不受限**：`dsh-sandbox` 的词汇只有文件影响，Windows ACL runner 也不碰网络/进程。
- **硬链接逃逸**：可继承的工作区 ACE 会传播到同文件对象的其他路径；pnpm 的硬链接会让工作区外 store 的同一文件被标记/授权。`enforcement` 因此报告 `partial`。
- **Low 标签常驻**：workspace 树被标 Low，会话结束后仍在；同用户的其它 Low-IL 进程可写她的目录。
- **WMI/CIM 不可用**：`Authenticated Users` 不在 restricting 列表里，`Get-CimInstance`/`Get-ComputerInfo` 在受限模式失败（实测未涉及，文档明确）。

### 2.3 Windows 上的"部分强制"意味着什么

- 写入/删除受 ACL 令牌约束；**读、网络、进程可见性不在范围内**。
- 文件对象别名（硬链接）可以绕过路径级授权；已被其他 AppContainer 工具用包 SID 标记过的目录树对 Low IL 子进程不可读（可能表现为"突然读不到"）。
- 控制台隔离不可用（`CREATE_NO_WINDOW` 下 DLL 初始化失败），子进程共享宿主控制台；管道 stdio 正常。
- workspace ACL 是**真实、常驻**的改动：授权 + 拒绝 `FILE_DELETE_CHILD` + Low 标签；`dispose()` 只回收临时目录授权。
- 需要 `WRITE_OWNER`：所有者只隐式拿到 `READ_CONTROL`/`WRITE_DAC`，标签在 SACL，所以目录必须给调用者完全控制。`C:\DSH` 的继承 ACL 恰好不满足 → E9。

### 2.4 ACL 前置条件（本方案最容易踩的坑）

实测结论：

1. `C:\DSH\...\.state\...`（继承 `Authenticated Users:(M)`）当 workspace → `grantWrite` Win32 5；
2. `C:\Users\ai_admin\ICL-lab\workspace`（继承当前用户完全控制）→ 直接可用；
3. `C:\DSH\her-lab` + `icacls 'C:\DSH\her-lab' /grant 'ai_admin:(OI)(CI)F'` → 直接可用。

所以试点前置检查（二选一）：

```powershell
# A. 零 ACL 修复：放在用户 profile 下
New-Item -ItemType Directory -Force C:\Users\ai_admin\ICL

# B. 放在 C:\DSH 下，但先补一条当前用户完全控制
New-Item -ItemType Directory -Force C:\DSH\her
icacls C:\DSH\her /grant 'ai_admin:(OI)(CI)F'
```

验收前读一次 `icacls <workspace>`：必须有 `ai_admin:(...(F))`，owner 是 `ai_admin`。若仍失败，用随包技能 `diagnose-windows-sandbox-acl`（`dsh-sandbox-windows-acl/assets/`）诊断+修复；它会给链路上缺 `WRITE_DAC`/`WRITE_OWNER` 的目录补完全控制，并备份 DACL。**它是改真实 ACL 的修复动作，只在批准后跑。**

### 2.5 拒绝与升权（审批链）

实测到的完整链路：

```text
tool call（write/edit/pwsh）
  └─ 有效模式解析（会话 sandbox/mode ?? 部署默认）
      ├─ 允许：直接执行
      └─ 拒绝：工具结果追加
           [sandbox: file access denied under <mode> mode]
           [sandbox: escalation available — retry this exact operation once with
            sandbox_permissions (the narrowest wider mode that suffices) + justification;
            the approval prompt asks the user]
模型重试：sandbox_permissions=danger-full-access + justification
  └─ approval/asked { id, toolName, callId, reason }
      └─ 应答者（UI / 我们的 QQ 桥）
          ├─ allowed-once → 该次调用用更宽模式执行；approval/decided
          ├─ rejected     → 工具结果 "the user rejected ..."
          ├─ cancelled    → 请求撤回（abort/超时）
          └─ unavailable  → 无应答者/应答者故障，失败关闭
```

要点（做 QQ 审批时必须知道）：

- `ApprovalRequestEvent` 只有 `agent / toolName / callId / reason / displayReason / signal`，**没有工具参数**。`reason` 是"escalate sandbox to danger-full-access: <justification>"，justification 是模型写的，不能当作可信事实。QQ 消息要展示**原始调用参数**（按 `callId` 从会话事件里取），不能只转述 reason。
- 结果词汇是封闭的：`allowed-once | rejected | cancelled | unavailable`；**没有 allow-always / 记住规则 / 撤销**。
- 审批只在**未结束的 turn 内**有效；请求在 turn 之间没有意义。
- **两种接法，别混：**
  - **进程内 answerer**（推荐给 QQ）：在 preset scope 里 `ctx.on('approval/request', handler)`，是 agent 作用域的 waterfall，直接 `return 'allowed-once'`（或 `rejected`/`cancelled`）即可；不需要 `$events`，也不需要 clientId/eventId。
  - **外部 client**（Web UI / 独立桥）：客户端在 `$events` 流收到 `event: 'approval/request'`，带 `eventId`、`agentId`、`request.toolName/callId/reason` 和 `clientId`；回答走 `POST /api/$events/result`，body 是 `{ clientId, eventId, outcome: { kind: 'result', value: 'allowed-once' } }`。**`outcome` 不是裸字符串**——我第一次传字符串，网关回 `invalid Remote event result`。
- 没有应答者时，`ask` 直接 `unavailable` 失败关闭；`never` 根本不发请求。

### 2.6 没有 UI 时怎么办（本次研究的核心问题）

三条路，按推荐顺序：

1. **QQ 私聊应答器（推荐，Phase 1 可选开启）** — 有两条实现路径，取舍不同：
   - **(a) 进程内 answerer（改动最小）**：在 `qq` 插件里 `ctx.on('approval/request', handler, { prepend: true })`（preset scope，agent 作用域），用 outbound（三把钥匙 + `ownerQQ`）发私聊，等 owner 回复（"同意"/"拒绝"）映射成 `allowed-once` / `rejected`，120s 超时回 `cancelled`。
     - **顺序问题**：网关的客户端转发器也是同一个 waterfall 的监听器。两者谁先拿到请求取决于 Cordis 作用域 waterfall 的合并顺序（本次未测）；如果网关先 claim，进程内 handler 就收不到，需要 `prepend` 才盖过它——而 `prepend` 之后**桌面 UI 的卡片就看不到了**。所以要么接受"QQ 模式"下 UI 不显示，要么加一个 `approvalChannel: qq | desktop` 配置，按用户是否在场切换。
     - **必须有界返回**：handler 不 return 就会挂住整个 waterfall；等回复必须带超时。
   - **(b) 外部 client（和 UI 共存）**：QQ 侧跑一个连 DSH API 的 client，开 `$events` 流，和 Web UI 同时收到 `approval/request`，谁先回答谁赢；代价是新增加一条 client 连接（端口/凭证），而当前的 `qq` 插件是进程内的，没有这条连接。协议见 §2.5 的"外部 client"。
   - 无论哪条，都只允许一个待审批，其余排队或直接 `rejected`。
2. **只靠桌面 UI（Phase 0 现状）**：你在电脑前时，DSH 的审批卡片就是应答者；你不在时，所有升权都会 `unavailable` 失败关闭。安全，但等于"她晚上不能申请"。（web-app 组合里有 `dsh-client-ui-approval`；本轮只验证了 client 线协议，没有实际点过 UI 卡片。）
3. **`never`**：直接禁用升权。最省事，但"申请"这条路就没了。

"时间消息"不适合当审批通道：`time` 的 delivery/signals 是**给她模型**的，不是给你的；把审批塞进去只会让她自己批准自己。

---

## 3. 方案对比：DSH 原生 / 专用 Windows 用户 / WSL

### 3.1 对比表

| 维度 | DSH native（`workspace-write`） | 专用 Windows 用户 | WSL |
|---|---|---|---|
| 写隔离 | 有（workspace + 私有 temp；Windows 部分强制） | 有（NTFS ACL + 同一沙箱兜底） | 有（Linux 内核级；bwrap/Landlock 可到 full） |
| 读隔离 | **无**（同用户，读全部） | **有**（标准用户看不到别人 profile；管理员可见） | 可配置：不 automount 时无 Windows 文件；automount 后 `/mnt/c` 默认可读 |
| 网络隔离 | 无 | 无（可加防火墙规则） | 有 NAT，可加 nftables/代理；默认仍可出网 |
| 进程/环境隔离 | 无 | 有（独立登录会话/令牌） | 有（独立 PID/mount/net namespace） |
| 账号/凭据隔离 | 无（共用你的 QQ/bili/API key） | **有**（她有自己的账号/凭据） | 有（Linux 用户；但 Windows 侧凭据若挂载仍可见） |
| 本机安装成本 | 0（已装好） | 中：建用户、装 DSH、迁移配置、处理 GUI/远程 | 中高：装 WSL/发行版、装 Node/DSH、迁移路径 |
| 迁移成本 | 低：只换 workspace + preset | 中：新 `DSH_HOME`、模型凭据、QQ/OneBot、bili 配置 | 高：绝对路径（bili python/venv、storyboard）、QQ 跨边界、文件交换 |
| 与现有 GPU/MC/bili | 不变 | 不变（但 GUI/桌面宠物要另起） | MC/bili 可走跨边界；GPU 不需要（她用云端模型） |
| 可回滚 | 高（改回 preset/切 full access） | 中（停掉她的账号进程） | 中（停 WSL；Windows 侧不受影响） |
| 主要风险 | 读/网络全开；ACL 残留；硬链接；审批悬挂 | 双账号运维、GUI 体验、凭据/端口重复 | 路径迁移、跨边界调试、WSL 生命周期 |
| 什么时候必须 | 只要"别弄坏我的文件" | **要读隐私、要账号隔离、要她"是另一个人"** | 要 Linux 工具链、要完整强制、要一次性/可重置环境、要网络策略 |

### 3.2 结论

- **只要写边界** → DSH native 就够，而且今天就能上线。
- **要"她看不到我的东西/用她自己的账号"** → 专用 Windows 用户是 Windows 上性价比最高的下一步：不用换 OS、路径还是 `C:\Users\icl\...`、DSH 还是同一套；代价是 GUI/凭据/端口的双份运维。
- **要 Linux 工具链、完整强制、可丢弃环境或网络策略** → 才上 WSL。如果只是为了"隔离"，专用 Windows 用户比 WSL 便宜；如果为了"完整强制 + 读隔离 + 可重置"，WSL 更彻底。注意：WSL **默认**会把 `C:` 挂进来（`/mnt/c` 可读），不配置的话读隔离并不比 native 强多少；要么关闭 automount，要么只挂只读。
- 三者不互斥：Phase 1 native → Phase 2 专用用户（把 workspace 搬到 `C:\Users\icl\her`）→ 需要时 Phase 3 WSL。会话 workspace 不可变，**每次升级都要新建会话**。

---

## 4. `editor` 去留与工具面收敛

### 4.1 现状问题（全部实测）

| 问题 | 证据 |
|---|---|
| 写路径绕过沙箱：`editor` 用 `node:fs` 直写，根是 `stateDir`，`workspace-write` 下照样成功 | E11 |
| 两个工作区：会话 workspace 是 `.../workspace`，editor 的根是 `.../state/icl-lab`；写会话 workspace 反而失败 | E11/E12 |
| 失败是"软成功"：`write_file` 返回 `不在工作区里。`，`isError=false`，模型会以为写成了 | E12 |
| 写保护是 denylist：只挡 `memory.db/time.json/focus.json/...` 几个文件名，新增状态文件就漏；且 `stateDir` 整棵树仍可写 | `packages/plugins/editor/src/index.mjs` |
| 能力缺口：没有 `edit`（改一行要整文件覆盖）、没有 `glob/grep`（找文件只能 `list_dir` 逐层）、没有 shell | 工具面 E14 |

`editor` 是"临时救急件"这个判断成立：它解决的是"没有文件工具"，代价是"另一套边界"。

### 4.2 目标工具面

| 现在（editor） | 目标（DSH 原生） | 说明 |
|---|---|---|
| `read_file` | `read` | 带行号/分页/上限；读不限（同用户） |
| `write_file` | `write` | 原子写；有 `fs-observation-policy`（先读后写） |
| — | `edit` | 字面量替换，改一行不用整文件覆盖 |
| `list_dir` | `glob` | `*` 匹配整棵树；含隐藏/忽略文件 |
| — | `grep` | ripgrep，按文件分组 |
| — | `pwsh` | **"能跑命令"的关键**；受 `pwsh-sandbox` 约束 |
| — | `read_image`（可选） | 她需要看 `bili_frames` 生成的 storyboard 图；需要附件服务 + 模型声明 image 输入 |

成本：6 个原生工具 schema 合计 ~7.2KB，替换 editor 的 3 个（~1.1KB），**净增 ~6.1KB/请求（约 1.5k tokens）**；工具数 34 → 37。standard preset 的对照是 26 个工具 / 21.8KB，所以 37 个仍在正常范围。

注意：preset 的工具面**只来自 preset 自己列出的插件**（实测 ICL 会话 34 个工具里没有任何 host 级原生工具）。所以"host 已经挂了 `tool-fs`"不等于"她能用"；必须在 ICL preset 的 `plugins:` 里显式加。

### 4.3 迁移顺序与回滚

**顺序（lab 先行，生产一次切换）：**

1. **Lab 基线**（不改产品）：用 `--patch` 覆盖层把默认模式改成 `workspace-write`（见 §5.4-5），新建两个会话：一个 `standard`（原生工具面）跑验收 A1-A9，一个 `icl-lab`（她的工具面）跑 A10-A12。
2. **Lab 工具面**：只在 lab preset 里加原生工具、去掉 `editor`，重跑 A1-A12，记录 `toolsHash`、schema 字符数、首轮 TTFT（缓存会被工具面变更打断一次）。
3. **生产 preset**：`icl.patch.yml` / `lab.patch.yml` 加同样的工具行；`config.mjs` 的 `DEFAULT_PLUGINS` 去掉 `editor`。**preset 改动按保守假设要新进程/新会话生效**（`docs/PROMPT-CONTRACT.md` §7 的实测结论），提前约好窗口。
4. **生产 profile**：`permission.defaultPreset: workspace-write`（只对新会话生效）；`sandbox-policy.workspaceRoot` 指向她的目录（只影响没有会话 cwd 的调用）。
5. **用户操作**：用"她的目录"新建 ICL 会话；确认日志里 `permission/preset=workspace-write`、`sandbox/mode=workspace-write`。
6. **观察一周**：再删 `editor` 包与其测试（或先保留包、只从 preset 移除）。

**回滚：**

- 单会话：`/permission danger-full-access`（立刻回到旧行为；不需要重启）。
- 工具面：把 preset 的 `editor` 加回、移除原生工具行，**新进程/新会话**生效；旧会话保持原工具面。
- 默认值：`defaultPreset` 改回 `danger-full-access`。
- 数据：无需迁移；她的旧笔记仍在 `~/.dsh/icl/state`，原生 `read` 读得到（只是不能写）。

### 4.4 兼容性清单（切换前必须确认）

| 依赖 | 影响 | 处置 |
|---|---|---|
| `bili_frames` | 用 `os.tmpdir()` 写 storyboard；host 进程 raw fs，不经沙箱 | 不受影响；但 `read`/`read_file` 都只处理 UTF-8 文本，她看不到图 → 建议加 `read_image` |
| MC / mc-link / memory / time / dream | 都是 host 进程 raw fs 写 `stateDir`，不经 DSH 工具 | 不受沙箱影响；**这也意味着沙箱只约束"模型发起的工具调用"，不约束 ICL 插件代码** |
| `prompts/live.md`、`prompts/marathon.md` | 提到 `write_file`（遗留/马拉松） | 活跃的 persona/sim 不点名工具；这两个文件如仍启用需改词 |
| 包管理器 | 默认缓存写在 `%LOCALAPPDATA%` → 被拒 | 在 workspace 放 `.npmrc`（`cache=./.npm-cache`）、命令里设 `PIP_CACHE_DIR`/`XDG_CACHE_HOME`；或接受失败并申请 |
| `git` | 全局 config/凭据在用户目录 → 读没问题，写被拒 | 在 workspace 内 `git config --local`；凭据用 workspace 内配置 |
| 系统提示词/缓存 | 加原生工具会新增工具指导段、改变 `toolsHash` | 切换后第一次请求会全量失效一次；之后稳定 |
| 诊断技能 | ACL 修复需要写安全描述符，受限会话里做不了 | 在 **danger-full-access 会话或普通 PowerShell** 里跑 `diagnose-windows-sandbox-acl`，不在她的会话里修 |

---

## 5. 试点步骤与验收清单

### 5.1 前置（P0，~30 分钟）

```powershell
# 1) 选 A（profile，零修复）或 B（C:\DSH + 一次性 icacls）
New-Item -ItemType Directory -Force C:\Users\ai_admin\ICL   # A
# 或
New-Item -ItemType Directory -Force C:\DSH\her
icacls C:\DSH\her /grant 'ai_admin:(OI)(CI)F'                          # B

# 2) 验证
icacls C:\DSH\her        # 必须看到 ai_admin:(...(F))，owner=ai_admin
whoami                    # 确认运行 DSH 的账号就是这个用户

# 3) 记录基线
#    当前默认 preset = danger-full-access；当前 ICL 工具面 34 个（见 §2.2 E14）
```

### 5.2 步骤

**P1 — Lab 原生验收（不改产品，2-3 小时）**

1. 把实验覆盖层写到 `.state/lab/<run>/sandbox.patch.yml`（内容见 §5.4-5），用 `--patch` 叠加在物化后的 `lab.patch.yml` 之后；端口用 57113（**不碰 57101/54838**）。`lab.mjs` 目前只物化一个 patch，所以要么把覆盖层**追加**到物化后的 `lab.patch.yml` 再手工起 `dsh --profile web --patch ...`，要么给 lab.mjs 加 `--sandbox`（§5.4-7）；本次实验就是手工起 + 两个 patch 做的。
2. 起 lab，建 `standard` 会话（workspace = 她的目录），跑 A1-A9。
3. 建 `icl-lab` 会话，跑 A10-A12。
4. 证据落 `.state/lab/<run>/`：`probe-events.jsonl`、`probe-report.md`、`approvals.jsonl`、`file-checks.txt`、`transcript.md`。

**P2 — 审批通道（2-4 小时，可与 P1 并行）**

5. 写一个**测试用**应答器（独立进程，连 `$events`，收到 `approval/request` 后按计划回 `{kind:'result', value:'allowed-once'|'rejected'}`），验证 A13-A14。协议见 §2.5。
6. 在 QQ 侧实现应答器，先用假 OneBot（`packages/plugins/qq/tools/lab-shadow.mjs`）跑 A15-A16；真实 SnowLuma 只在 lead 批准后跑。

**P3 — 生产演练（1 小时，需要用户在场）**

7. 用她的目录新建一个 ICL 会话；`/permission workspace-write`；让她跑 A17-A18（写自己/写外面）。
8. 确认 `~/.dsh/icl/state` 的 mtime/哈希未变；`icacls` 确认 state 目录没有新增 capability ACE / Low 标签。

**P4 — 默认值切换（1 小时，需要重启进程）**

9. 改 desktop profile 的 `permission.defaultPreset`（lead/用户执行），重启 desktop；新会话确认 `permission/preset=workspace-write`。
10. 切换工具面 preset；新会话确认工具列表；观察 3 天，再删 `editor` 包。

### 5.3 验收清单

| # | 验收项 | 期望 | 证据 |
|---|---|---|---|
| A1 | 写自己的文件 | 成功；`Created file`/`Updated file`；文件存在 | lab `probe-report.md`；`file-checks.txt` |
| A2 | 写 workspace 外 | 拒绝 + `[sandbox: file access denied under workspace-write mode]` + 升权提示；文件不存在 | E2 |
| A3 | 审批拒绝 | 工具结果 `the user rejected escalating ...`；`approval/decided=rejected` | E3 |
| A4 | 审批放行一次 | 文件在 workspace 外创建；`approval/decided=allowed-once`；下一次同路径仍被拒 | E4 + 追加一次重试 |
| A5 | `pwsh` 写自己 | 成功；`TEMP` 是私有 `...\Temp\dsh-XXXX` | E6 |
| A6 | `pwsh` 写外面（终止性） | 非零退出 + 拒绝标记 + 升权提示；文件不存在 | E7 |
| A7 | `read-only` | 写自己也被拒；`LANG=ConstrainedLanguage`；无私有 temp | E5 |
| A8 | 无应答者 | 审批结果 `unavailable`，工具失败关闭，不执行 | 断开应答器/不回答，读 `approval/decided` |
| A9 | 工具面 | ICL 会话有 `read/write/edit/glob/grep/pwsh`，没有 `read_file/write_file/list_dir`；`toolsHash` 已记录 | `request/header` |
| A10 | 她写自己的目录 | 用她的工具写 `C:\DSH\her\notes\...` 成功 | ICL 会话工具结果 |
| A11 | 她写 workspace 外 | 拒绝 + 标记；不再出现"不在工作区里。"这种软失败 | ICL 会话工具结果 |
| A12 | 她写 `stateDir` | 被拒（应在 workspace 外）；state 文件哈希不变 | 工具结果 + 文件哈希 |
| A13 | 审批 Wire 形状 | `$events/result` 接受 `{kind:'result', value}`；`invalid Remote event result` 不再出现 | `approvals.jsonl` |
| A14 | 审批超时 | 120s 无回答 → `cancelled`，turn 继续，不悬挂 | 测试应答器 |
| A15 | QQ 审批（假上游） | 私聊收到工具名+参数+理由；回"同意"→ 执行；回"拒绝"→ 拒绝 | qq lab-shadow 记录 |
| A16 | QQ 断线 | 审批 `cancelled`/`unavailable`，不执行 | 状态文件 |
| A17 | 生产会话 workspace | 新会话 `cwd` = 她的目录；`permission/preset=workspace-write`；`sandbox/mode=workspace-write` | 会话日志 |
| A18 | 生产越界 | 写 `C:\Users\ai_admin\...` 被拒；写 `C:\DSH\her` 成功 | 会话日志 |

### 5.4 需要 lead 批准的改动清单（我没有改）

> 下面都是**提案**，按优先级排列；1-3 是"她有自己的电脑"的最小集，4-5 是生产默认值，6-7 是审批通道。

**1. `packages/dsh-icl/presets/icl.patch.yml`（以及 `lab.patch.yml` 的 `icl-lab`/`icl-mc-lab`）**

在 `plugins:` 列表里加（放在 `editor` 原来的位置附近）：

```yaml
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
          # read_image 不是独立插件：它随 dsh-tool-fs 自动注册（需要 ctx.attachments）
```

并把 `- editor` 从 `plugins:` 移除（保留包文件以便回滚）。`read_image` 无需额外行；若她的模型不声明 image 输入，执行时会被拒。

**2. `packages/dsh-icl/src/config.mjs`**

`DEFAULT_PLUGINS` 去掉 `'editor'`；`bootstrap.mjs` 的 `case 'editor'` 可留（不再命中）或一并删。

**3. `packages/dsh-icl/presets/lab.patch.yml`**

与 1 相同（这是测试夹具，不是生产默认；改它让 lab 直接长成目标形态）。

**4. `C:\Users\ai_admin\.dsh\profiles\desktop\cordis.patch.yml`（用户 profile，lead/用户执行）**

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: workspace-write
# 只影响没有会话 cwd 的调用（有会话时 workspace = 会话 cwd）；写全更稳
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: C:/DSH/her
```

（base 的三个预设已在；只需改默认值。**不要**删 `danger-full-access`，它是回滚路径。注意：`permission` 设置命名空间里也可能存了 `defaultPreset` 的持久值，它会覆盖 config；改完先新开一个会话看 `permissionPresets.catalog()` 的 `defaultPreset` 与 `permission/preset` 事件。）

**5. Lab 覆盖层（试点专用，不进 profile）**

```yaml
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: C:/DSH/her
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
    defaultPreset: workspace-write
```

（`sandbox-policy` 的 `config` 是整体替换，必须同时写 `mode` 和 `workspaceRoot`；`permission` 的 `presets` 实测是深合并，但显式写全更稳。见 §5.4 下面的"实测补充"。）

**6. QQ 审批应答器（新增模块；`packages/plugins/qq` + `dsh-icl` 配置）**

- 进程内 answerer（推荐先做）：`ctx.on('approval/request', handler, { prepend: true })`，`return 'allowed-once' | 'rejected' | 'cancelled'`；`prepend` 会挡住 Web UI 的卡片，所以需要 `approvalChannel: qq | desktop` 开关（默认 desktop）；
- 或者外部 client：跑一个连 DSH API 的进程，按 §2.5 的 `$events/result` 回答（和 UI 共存，谁先答谁赢）；
- 用 outbound 发私聊给 `ownerQQ`（三把钥匙 + 每轮 1 条的限制；审批消息要单独计数或放宽，需产品决定）；
- 待审批时，owner 的下一条私聊优先当审批回答，不再进 signals；
- 120s 超时 → `cancelled`；
- 单个待审批队列；
- 展示：工具名 + 模式 + **原始参数**（按 `callId` 从 `session/event` 的 `tool/call` 里取）+ reason + 短 id。

**7. `tools/lab.mjs`（测试夹具，可选）**

加 `--sandbox workspace-write`，把 5 的覆盖层写进 runDir（避免每次手写 patch）。

**实测补充（给改 profile 的人）：** profile patch 的 `permission.config` **不是**整体替换——web profile 只写了 `danger-full-access` 一个 preset，`--dump-config` 仍显示三个 preset 都在，`defaultPreset` 被覆盖。所以第 4 条只需一行；但 `sandbox-policy.config` 是整体替换（`mode`+`workspaceRoot` 都要写）。

### 5.5 成本与时间（粗估）

| 项 | 时间 | 备注 |
|---|---|---|
| P0 目录/ACL | 0.5h | 一次性 |
| P1 lab 原生验收 | 2-3h | 含两次 model 驱动的探测 |
| P2 审批通道 | 2-4h | 假 OneBot 先行；真实 QQ 窗口另算 |
| P3 生产演练 | 1h | 需要用户在场 |
| P4 默认值+工具面切换 | 1h + 观察 3 天 | 需要重启 desktop |
| 合计 | **1-2 人日 + 观察期** | 不含专用用户/WSL |

---

## 6. 未解问题

1. **读隐私**：同用户 = 她能读 `~/.dsh/.credentials.yaml`、浏览器数据、你的文档。DSH 没有读策略。要么接受，要么专用用户/WSL。这是 Phase 2 的**唯一硬分水岭**。
2. **网络**：她能出网；QQ 的敏感信息拦截只在 `qq_send`，`curl` 不过它。若担心外泄，需要网络策略（WSL/防火墙），DSH 没有。
3. **审批没有参数**：`approval/request` 只给 toolName/justification。QQ 侧必须自己按 `callId` 查原始参数；如果 `callId` 缺失（某些调用），就只能显示 reason。需要确认所有沙箱消费方都带 `callId`（实测 `write` 带）。
4. **审批悬挂**：连着 `$events` 但不回答的客户端会让工具调用一直等；代码里没看到超时。QQ 应答器必须自带超时；桌面 UI 关闭时是否自动 `unavailable` 需实测（本次没测"连着但不答"的时长）。
5. **非终止错误不分类**：PowerShell 的 `New-Item`/`Set-Content` 默认非终止，退出码 0 → 没有拒绝标记/升权提示（E8）。要不要在 pwsh 执行器里预置 `$ErrorActionPreference='Stop'`？这会改变所有命令语义，需产品决策。
6. **硬链接**：pnpm/`node_modules` 的硬链接会让 workspace 授权传播到 workspace 外的 store 文件，`enforcement` 只报 `partial`。需要实测一次"在 her 目录里 pnpm install"对外部 store 的影响；可能要把 store 也放在 workspace 内，或禁止在 her 目录装包。
7. **ACL 残留**：workspace ACE 常驻、Low 标签常驻；改名/删除会留失效 ACE（文档说未来的清理命令才能回收）。`C:\DSH` 的授权是否会影响仓库其他目录？本次只授权了 `C:\DSH\her` 子目录，没有扩散；但需要一次 `icacls` 审计。
8. **包管理器缓存**：npm/pip 默认写用户目录，会被拒。需要试点确认 `.npmrc`/`PIP_CACHE_DIR` 方案是否够用，还是要在 shell 层预置环境变量（`shell-env` 只管 `DSH_*`，不能设任意 env）。
9. **append 语义**：editor 的 `write_file(append:true)` 没了；原生 `write` 覆盖、`edit` 需要 old_string。她"记一两句"的习惯可能需要一个受围栏的 `append_file`，或改用 `memo_append`。
10. **工具面变更的缓存代价**：新增 6 个工具会改变 `toolsHash` 和系统提示词里的工具指导段，首轮全量失效一次；长期是否值得（尤其 `glob/grep`，shell 也能搜）需要观察。
11. **模式切换的 QQ 入口**：`/permission` 目前只有 UI/命令注册表有；QQ 入站文本变成 signals，不是命令。若要让用户在 QQ 里切模式，需要额外实现（并加权限校验）。
12. **`read_image` 的路由**：需要模型声明 image 输入；`deepseek-flash` 是否声明需确认（`read_image` 执行时会拒绝不声明 image 的路由）。
13. **专用 Windows 用户/WSL 未实测**：本文对二者的结论来自 DSH 文档与 Windows/WSL 的通用边界，不是本机实验；真要走 Phase 2，先做 0.5-1 天的可行性验证（尤其是 GUI/凭据/QQ 端口）。

---

## 附录 A：复现与证据路径

```powershell
# 实验一：workspace 在 .state 下（暴露 ACL 前置条件 + fs/pwsh/审批）
node .state/lab/sandbox-1/probe.mjs
# 证据：.state/lab/sandbox-1/{probe.log,probe-events.jsonl,probe-report.md,approvals.jsonl,file-checks.txt,sandbox.patch.yml}

# 实验二/三/四：workspace 在 profile 下 / C:\DSH + icacls
node .state/lab/sandbox-2/probe2.mjs   # 写自己/写外面/TEMP
node .state/lab/sandbox-2/probe3.mjs   # 终止性越界 → 拒绝标记
node .state/lab/sandbox-2/probe4.mjs   # C:\DSH + icacls 后可授权
# 证据：.state/lab/sandbox-2/{evidence.md,probe2.log,dsh*,denial-marker.txt,c-dsh-acl.txt}

# 工具面/会话日志（实验一）
node .state/lab/sandbox-1/tools.mjs    # 34 vs 26，schema 字符数
```

会话日志（DSH 自己的权威源）：

- 实验一：`C:\Users\ai_admin\.dsh\sessions\--C-DSH-icl-wt-sandbox-.state-lab-sandbox-1-workspace--\<session>\session.v4.jsonl.zstd`
- 实验二/三/四：`C:\Users\ai_admin\.dsh\sessions\--C-Users-ai_admin-ICL-lab-workspace--\...`、`--C-DSH-her-lab-workspace--\...`

## 附录 B：关键原文摘录

**拒绝标记（write，workspace 外）**

```text
Error: [sandbox: file access denied under workspace-write mode]
[sandbox: escalation available — retry this exact operation once with sandbox_permissions
(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
```

**审批拒绝**

```text
Error: the user rejected escalating this operation to "danger-full-access";
it stays denied, so stop and explain instead of working around it
```

**审批放行**

```text
<path>C:\DSH\icl-wt\sandbox\.state\lab\sandbox-1\outside\oops-allowed.txt</path>
<type>file</type>
<content>
Created file
</content>
```

**ACL runner 授权失败**

```text
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\DSH\icl-wt\sandbox\.state\lab\sandbox-1\workspace)
```

**pwsh 拒绝（终止性）**

```text
[stderr]
Set-Content: Access to the path '...' is denied.
[sandbox: file access denied under workspace-write mode]
[sandbox: escalation available — retry this exact command once with sandbox_permissions ...]
[exit code: 1]
```

**editor 的软失败**

```text
write_file(path=".../workspace/her-note.md", text="写到会话工作区")
→ "不在工作区里。"   (isError=false)
```
