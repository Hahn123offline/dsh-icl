# PATHS：一个根，所有可写目录都可整体迁移

> 需求（用户原话）：**"我们的所有目录都不应该写死且支持转移（整体迁移）"**。
> 本轮（`wt/paths`）只解决"路径可配置 / 可迁移"，不改插件业务语义，不动 desktop profile。
> 相册隐私、保留策略另轮处理；本文只说明路径与迁移。

以前的问题：相册根默认 `<cwd>/media`，QQ 入站默认 `.state/media/inbox/qq`，视频临时产物、
mc-body state、dsh-icl stateDir、lab 的 `sandbox-policy.workspaceRoot` 各写各的，其中还有
`C:/DSH/her`、`C:\Users\...` 这种带盘符/用户名的绝对路径。换机或换盘时必须改代码。

现在只有一处知道"东西放哪儿"：`packages/core/src/icl-paths.mjs` 的 `iclPaths()`。
dsh-icl 的 `src/paths.mjs` 再导出它，插件默认值也 import 同一份实现。

---

## 1. 单一根 `ICL_ROOT`

```
<ICL_ROOT>/
  state/        记忆库、time.json、focus.json、原文 JSONL、bili 凭证、mc-link 日志、mc-body 产物
  home/         她的"家"；sandbox workspaceRoot 的默认值
  media/        通用媒体；stickers/ 表情包库
  album/        相册（media.db + 原图/拼图）
  inbox/qq/     QQ 入站图片/视频/文件（按日期子目录 + index.jsonl）
  video-tmp/    分镜/取帧的临时产物（work/ 下按次 mkdtemp）
  locks/        跨 worktree 的锁（本地模型等）
```

默认根 = `<仓库根>/.state`（保持旧 `.state/lab`、`.state/locks`、`.state/mc-*` 原地可读）。

### 解析优先级

**显式 config > 环境变量 > 默认（根下的固定布局）。** 每一类路径独立判断；相对路径一律
锚到 `ICL_ROOT`（只读仓库资产 `personaFile` / `simulationFile` / `providersFile` 仍锚仓库根）。

| 目录 | 默认 | 环境变量 | preset/headless config |
|---|---|---|---|
| ICL 根 | `<仓库根>/.state` | `ICL_ROOT` | `iclRoot` |
| state | `<根>/state` | `ICL_STATE_DIR` | `stateDir` |
| home | `<根>/home` | `ICL_HOME_DIR` | `homeDir` |
| media | `<根>/media` | `ICL_MEDIA_DIR` | `mediaDir` |
| album | `<根>/album` | `ICL_ALBUM_DIR` | `albumDir` |
| QQ 入站 | `<根>/inbox/qq` | `ICL_QQ_INBOX_DIR` | `qqInboxDir` |
| 视频临时 | `<根>/video-tmp` | `ICL_VIDEO_TMP_DIR` | `videoTmpDir` |
| 表情包 | `<根>/media/stickers` | `ICL_STICKERS_DIR` | `stickersDir` |
| 锁 | `<根>/locks` | `ICL_LOCKS_DIR` | `locksDir` |
| sandbox workspaceRoot | `<根>/home` | `ICL_SANDBOX_WORKSPACE` | `sandboxWorkspaceRoot` |

`configFor()`（`packages/dsh-icl/src/bootstrap.mjs`）把解析结果传给插件：

| 插件 | 拿到的路径 |
|---|---|
| album | `root = albumDir` |
| qq | `mediaInboxDir = qqInboxDir`、`stickerDir = stickersDir` |
| video | `stateDir = videoTmpDir` |
| memory / editor / time / rhythm / loop-probe / bili | 都在 `stateDir` 下（行为不变） |
| mc-link | `logFile = <stateDir>/mc-link.jsonl`；body 的产物在 `dirname(logFile)` |
| mc-body CLI | 无 `--log/--state` 时 `<stateDir>/mc-body/` |

插件自己的默认值（不走 bootstrap 独立运行时）也调用同一个 `iclPaths()`，不再拼 `cwd`。
外部依赖位置也从 `DSH_HOME` 推：video/bili 的 storyboard CLI 默认
`<DSH_HOME>/profiles/desktop/node_modules/dsh-video-storyboard/bin/storyboard.mjs`
（`ICL_STORYBOARD_CLI` / `STORYBOARD_CLI` 仍可覆盖），不再写死用户名。

### lab 的 workspaceRoot

`packages/dsh-icl/presets/lab.patch.yml` 里 `sandbox-policy.workspaceRoot` 是占位符
`__LAB_WORKSPACE__`。`tools/lab.mjs` 物化 patch 时用**同一轮 `--workspace`** 的绝对路径替换
（默认 `<runDir>/workspace`，也可 `--workspace <ICL_ROOT>/home`），与会话 cwd 同源。
产品 preset 不启用 sandbox-policy，不受影响。

---

## 2. 向后兼容（旧路径仍能读）

兼容是**只读兜底**，不会自动搬数据：

| 旧位置 | 何时继续生效 | 新位置 |
|---|---|---|
| `$DSH_HOME/icl/state` | `<ICL_ROOT>/state` 还不存在、旧目录存在 | `<ICL_ROOT>/state` |
| `<旧 stateDir>/media` | `<ICL_ROOT>/album` 还不存在、旧相册目录存在 | `<ICL_ROOT>/album` |
| `<ICL_ROOT>/media/inbox/qq`（repo `.state` 时代） | `<ICL_ROOT>/inbox/qq` 还不存在 | `<ICL_ROOT>/inbox/qq` |
| 仓库根 `.state/locks`、`.state/lab`、`.state/mc-*` | 默认根就是 `.state`，原地不动 | 同位置 |

一旦新目录出现（例如迁移工具写入了 `<根>/state`），解析就切到新目录，旧的不会再被写。
想看当前实际用了哪些旧目录：

```powershell
node -e "import('./packages/core/src/icl-paths.mjs').then(m=>{const p=m.iclPaths();console.log(m.describePaths(p));console.log('legacy:',p.legacy.used)})"
```

---

## 3. 哪些目录由用户决定、迁移前必须停机

### 由用户决定（代码不替用户选）

- `ICL_ROOT` 放哪块盘/哪个目录（**不要**用盘符根，也**不要**放在旧根里面）；
- 每一类是否单独换位置（`ICL_STATE_DIR` 等 env 或 preset config）；
- 迁移是否保留旧目录（`--keep-source`）、旧备份什么时候删；
- desktop 场景下 `ICL_ROOT` 的注入方式（见 §4.5：Electron 不继承 PowerShell 会话的 env）。

### 迁移前必须停机（硬要求）

| 目录 | 谁在写 | 停机对象 |
|---|---|---|
| `state/` | memory（sqlite）、time、focus、原文 JSONL、bili 凭证 | **关闭正在跑的 ICL 会话**（desktop 的 ICL 会话 / headless / loop） |
| `album/` | album（sqlite WAL + 文件） | 同上；相册的 `-wal/-shm` 必须一起停 |
| `inbox/qq/` | qq 插件的入站媒体 | 停 QQ shadow / OneBot 连接（qq 断开后再迁） |
| `home/`、`video-tmp/` | sandbox 会话、video 分镜临时产物 | 停对应会话；临时产物可不清 |
| `locks/` | lab、本地模型 | `node tools/lab.mjs down`；确认锁文件没有活主 |
| `state/mc-body/`、`.state/lab/` | lab / mc-body 子进程 | `node tools/lab.mjs down`（它会收掉 body） |

**为什么必须停机**：SQLite 的 WAL 在运行中迁移会丢最近事务；JSONL 可能正在追加半行；
锁文件搬走后旧进程仍以为持有锁；视频临时文件正在被 ffprobe/rename。

停机检查（Windows）：

```powershell
# 1) 确认没有 ICL 会话在跑（desktop 侧关闭 ICL 会话；headless/lab 用 down）
node tools/lab.mjs status --json
# 2) 确认锁没有活主（pid 不在）
Get-Content <ICL_ROOT>/locks/*.lock -ErrorAction SilentlyContinue
# 3) mc-body / dsh web 进程按你自己的会话关闭；不要直接 Ctrl-C 正在写 memory.db 的进程
```

---

## 4. 换机 / 换盘 / 整体迁移

### 4.1 先备份

迁移工具是"复制 + 校验 + 删源"，但备份仍然要做：把整个旧根复制一份到另一个目录/盘
（相册和记忆库都不可再生）。**不要**只依赖迁移工具的自动回滚。

### 4.2 dry-run（不写盘）

```powershell
node tools/icl-move.mjs --from <旧根> --to <新根>
# 例：node tools/icl-move.mjs --from C:/DSH/icl/.state --to D:/icl-data
```

输出每一项的 `文件数 / 字节数`、目标是否已存在、源是否可读、新根是否可写、以及
"旧根 ↔ 新根 互相包含"这类错误。dry-run **不会**创建新根，也不会动源目录。

### 4.3 真正搬

```powershell
node tools/icl-move.mjs --from <旧根> --to <新根> --apply
```

执行顺序（任一步失败都会回滚）：

1. 校验：源可读、目标可写、源/目标不重叠、目标目录不存在（**不覆盖**）；
2. 复制到 `<新根>/.icl-move-staging-*`，逐个文件核对大小与文件数；
3. 全部核对通过后才 `rename` 到最终位置（同盘原子）；
4. 写 `<新根>/icl-move.json` 迁移记录；
5. 最后才删源目录（`--keep-source` 可保留；删一半失败只告警，新根数据已完整）。

旧安装（还没有 ICL_ROOT 时）的 state 在 `$DSH_HOME/icl/state`，用 `--legacy-state` 折叠进新根：

```powershell
node tools/icl-move.mjs --to D:/icl-data --legacy-state "$env:USERPROFILE/.dsh/icl/state" --apply
```

它会拆成：`memory.db/time.json/... → <新根>/state`、`media/media.db → <新根>/album`、
`media/inbox → <新根>/inbox`、`media/stickers → <新根>/media/stickers`（不会重复拷 `media`）。

只想搬某几类：`--kinds state,album,inbox`。

### 4.4 切换 `ICL_ROOT`

迁移记录写完后、确认之前，**不要删旧备份**。然后任选一种方式把新根告诉 ICL（**只改一处**，
多处同时设会让"到底用哪棵树"不可审计）：

1. **环境变量**（headless / lab / 自己启的进程）：
   ```powershell
   $env:ICL_ROOT = 'D:/icl-data'
   ```
2. **preset / headless config**（desktop 的 Plugin Manager 安装的 preset 最可靠）：
   ```yaml
   config:
     iclRoot: D:/icl-data
   ```
3. 每类单独指定时用 `ICL_STATE_DIR` / `ICL_ALBUM_DIR` / …（见 §1 表）。

> Windows desktop（Electron）不继承 PowerShell 会话里 `$env:ICL_ROOT`。desktop 场景请用
> 用户级环境变量（系统设置）或 preset config；改完**重启 ICL 会话**（不是只刷新页面）。

### 4.5 迁移后验证

1. 对照 `icl-move.json` 的 `totals` 与实际目录：`files` / `bytes` 应一致；
2. 启动一个 ICL 会话，看启动日志里的 `stateDir` 指向新根，`legacy:` 为空；
3. 依次打开：记忆（recall）、相册列表、QQ 入站、视频分镜各一次；
4. 确认旧根不再被写（mtime 不变）——如果有写入，说明还有进程/配置指向旧根；
5. 观察 1–2 天再删旧备份。

### 4.6 回滚 / 恢复

- **迁移失败**：工具自动回滚（记录 `rollback.performed=true`、`rollback.removed`），源目录
  在最后一步之前一直完整；把 `ICL_ROOT` 指回旧根即可继续用。
- **迁移成功但想回退**：把 `ICL_ROOT` 指回旧根（若源已删，从备份恢复整棵树）。**不要**把
  两棵树手工 merge：sqlite/JSONL 会分叉。
- **只删了一半源目录**：新根数据完整（复制校验已通过），用记录里的 `sourcesDeleted` 对照，
  旧根残留可以手工删或重跑一次 `--keep-source` 的迁移。
- **换机**：新机 clone 仓库 → 把旧机的 `<ICL_ROOT>` 整目录复制到新机同一路径（或新路径 +
  `ICL_ROOT`）→ 设 `ICL_ROOT` → 启动。Windows sandbox 试点还要重做 workspace 目录的 ACL
  （`icacls <workspace> /grant '<user>:(OI)(CI)F'`）。

### 4.7 迁移记录（`icl-move.json`）

```json
{
  "schemaVersion": 1,
  "tool": "tools/icl-move.mjs",
  "mode": "apply",
  "status": "ok",
  "startedAt": "2026-11-06T02:00:00.000Z",
  "finishedAt": "2026-11-06T02:00:03.120Z",
  "from": "C:/DSH/icl/.state",
  "to": "D:/icl-data",
  "kinds": ["state", "home", "media", "album", "inbox", "video-tmp"],
  "checks": { "sourceReadable": true, "targetWritable": { "ok": true, "method": "ancestor-access" } },
  "entries": [{ "kind": "state", "from": "...", "to": "...", "status": "ready", "files": 42, "bytes": 123456 }],
  "totals": { "files": 42, "bytes": 123456 },
  "committed": ["D:/icl-data/state"],
  "sourcesDeleted": ["C:/DSH/icl/.state/state"],
  "rollback": { "performed": false, "removed": [] },
  "warnings": [],
  "error": null,
  "next": "把 ICL_ROOT 指向新根…"
}
```

失败时 `status=failed`，`error` 写原因，`rollback` 记录删了哪些半成品目标。

---

## 5. 仍然写死的地方（开发工具，不是产品路径）

本轮范围是"插件默认路径 + 迁移工具 + 文档"，以下**开发/实验脚本**仍指向本机绝对路径，
换机后要按脚本头部注释改参数（不在 ICL 运行时默认值里）：

- `tools/lab.mjs`、`tools/lab-lib.mjs`：`STATE_ROOT` 仍是 `<仓库>/.state/lab`（worktree 内实验产物）；
- `tools/mc-*.mjs`、`tools/acc-*.mjs`、`tools/loop*.mjs`、`tools/cache-*.mjs`、
  `tools/time-night-check.mjs`：`C:/DSH/icl/.state/...`、`C:/DSH/icl-wt/mc-lab/...` 等实验目录/证据路径；
- `tools/recall-*.mjs`、`tools/replay.mjs`：`C:/DSH/qwenstuff/dsh-qq/state/memory.db`（外部数据来源）；
- `config/icl.example.json`：人格卡路径（数据来源，属于部署配置）；
- `docs/` 里的历史审计/实验报告：路径是当时的证据，不在本轮重写。

这些不是"她的目录"，不影响产品运行；要彻底去绝对路径，建议另开一轮把开发脚本也切到
`iclPaths()`（`--out`/`--events`/`--root` 都已有参数，改默认值即可）。

---

## 6. 测试与自查

`npm test` 新增：

- `packages/core/test/paths.test.mjs`
  - 默认根/布局；**config > env > 默认**；每类可单独覆盖；相对路径锚 `ICL_ROOT`；
  - 旧 `$DSH_HOME/icl/state`、旧相册、旧 QQ 入站目录的只读兼容与新目录优先级；
  - `normalizeConfig` / `configFor` 把同一个根传给各插件；
  - 扫描运行时源码与 preset，断言**没有** `C:/DSH`、`C:\Users\...`；
  - `lab.patch.yml` 的 `workspaceRoot` 是占位符、产品 preset 的 `stateDir` 是相对路径。
- `packages/core/test/icl-move.test.mjs`
  - dry-run 不建目录、不改源；
  - apply 逐字节一致、删源、写记录、迁移后 `iclPaths({root})` 直接指向新数据；
  - 旧 `$DSH_HOME/icl/state` 折叠；复制后大小不符 / 提交阶段失败两种回滚；
  - 目标已存在 / 新旧根互相包含 / 缺 `--to` 的预检拒绝。

手动自查：

```powershell
# 当前解析结果 + 用了哪些旧目录
node -e "import('./packages/core/src/icl-paths.mjs').then(m=>{const p=m.iclPaths();console.log(m.describePaths(p));console.log('legacy:',p.legacy.used)})"

# 迁移预演（不写盘）
node tools/icl-move.mjs --to D:/icl-data --legacy-state "$env:USERPROFILE/.dsh/icl/state"
```

## 7. 相关文件

- `packages/core/src/icl-paths.mjs` —— 唯一实现（`iclPaths()` / `iclRoot()` / `ICL_LAYOUT`）
- `packages/dsh-icl/src/paths.mjs` —— 再导出 + `resolvePath`（仓库资产）/ `resolveDataPath`（数据）
- `packages/dsh-icl/src/config.mjs` —— 解析一组路径并暴露给 bootstrap
- `packages/dsh-icl/src/bootstrap.mjs` —— `configFor()` 把路径分发给插件
- `packages/dsh-icl/presets/icl.patch.yml`、`lab.patch.yml`、`cordis.patch.yml` —— 相对数据路径 / 占位符
- `tools/icl-move.mjs` —— 迁移工具
- `packages/core/test/paths.test.mjs`、`packages/core/test/icl-move.test.mjs` —— 契约测试
