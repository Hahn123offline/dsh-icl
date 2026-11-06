# A1 live 复核（2026-11-07）

> 复核人：cache。对象：用户重启 desktop 后加载的 **A1 产品面**（产品 `icl` preset：首屏净化 4 段 + 去 mc-link）。
> 方式：只读 `~/.dsh/sessions` 事件流 + 只读检查 desktop 安装物（未起 lab、未改 desktop profile、未重启 desktop）。
> 结论：**A1 已部署，但 live ICL 会话当前不可用（P0）**——turn 在组装系统提示词阶段就报错，没有任何 `request/header`，因此本应记录的 live header/system/purify/facts 四组数字**全部拿不到**。根因已定位（桌面内置 DSH 不注册 `{{cwd}}` 变量，而 A1 preset 的 `tool-persona.suffix` 依赖它），修法见 §5。

- 复核时间：2026-11-07 02:20–02:40（Asia/Hong_Kong）
- desktop GUI：`127.0.0.1:55027`（重启后）
- A1 安装物：`~/.dsh/profiles/desktop/node_modules/dsh-icl` → junction → `C:/DSH/icl/packages/dsh-icl`（主仓库 HEAD `649c8dd`）；`packages/dsh-icl/presets/icl.patch.yml` 已含 A1（`purifySections` 4 段 + 16 插件白名单、无 `mc-link`）。

---

## 1. 红：live ICL turn 全部失败（0 次模型请求）

重启后唯一存在的 `icl` preset 会话是**被恢复的旧会话** `session-737ec994-8f48-445f-af65-30022525255f`
（工作区 `C:\DSH\icl\.state\loop\workspace`，**注意：这是 2026-11-05 的旧 MC 会话，不是 A1 新建会话**）。
重启之后该会话被自动恢复并尝试跑了 3 个 turn（93/94/95，来自投递 notice），**全部在请求组装前失败**：

| 时间（本地） | turn | 错误 |
|---|---|---|
| 02:22:13 | 93 | `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model` |
| 02:24:29 | 94 | 同上 |
| 02:26:43 | 95 | 同上 |

重启后事件统计（该会话）：`turn/start=3, step/start=3, step/end=3, turn/end=3`，
**`request/header = 0`、`system/message = 0`** → 没有任何请求到达模型，也没有新的系统提示词快照可审。

同时扫了全部 `~/.dsh/sessions`：**重启后没有新建任何 `agentPreset=icl` 的会话**（其他 preset 的 standard 会话正常活跃，说明 desktop 本体没坏）。

## 2. 根因（已确定）：桌面内置 DSH 不注册 `{{cwd}}` 变量

- A1 产品 preset（`presets/icl.patch.yml` L52–56 / L96–100 / L139–143）给 `tool-persona` 配了：
  `suffix: 'Your working directory is {{cwd}}.'`。
- **桌面 app 内置的 DSH（`resources/app.asar`）里，agent-loop 只注册了 `provider`、`model` 两个变量，没有 `cwd`**：
  - 扫描 app.asar：`systemPrompt.variable("provider"` / `"model"` 存在，**`variable("cwd"` 不存在**；
  - 其内置文档原文："Custom persona templates must not depend on a built-in `{{cwd}}` variable: **the loop does not register it**, so unresolved references fail prompt assembly before any model request. Remove the `Your working directory is {{cwd}}.` clause from home, profile, or invocation `personaSuffix` settings and **preset `suffix` fields**… The working-directory service supplies the required current-directory context."
- 而 `~/.dsh/profiles/node_modules` 里的 npm 版 dsh-agent-loop **有** `cwd`（`dsh-agent-loop/lib/index.js:1566`）——**桌面内置运行时与 profile npm 包存在版本差**。
  这解释了为什么：lab/web profile（npm 新版）跑带 `{{cwd}}` suffix 的 lab preset 正常；desktop（内置旧版）只要 ICL preset 一带上这个 suffix 就全灭。
- 其他 standard 会话正常，是因为它们不经过 ICL preset 的 `tool-persona.suffix`。

## 3. A1 部署核对（离线部分，已确认）

| 项 | 结果 |
|---|---|
| desktop profile 挂载 | `dsh-icl` junction → 主仓库 `C:/DSH/icl/packages/dsh-icl`；主仓库 HEAD `649c8dd` |
| 产品 preset 首屏净化 | `purifySections` 4 段齐全（`harness:identity` / `ui:deliverable-file-references` / `harness:source` / `app:web-surface`） |
| 产品 preset 插件面 | 16 个 ICL 插件（memory…album），**无 `mc-link`** |
| 离线 A1 工具面（前一轮已测） | ICL 面 **51 工具**；chars 两口径：**34,101**（cache 数组 JSON）/ **34,049**（Σ 每工具 JSON）；**0 个 `mcb_*`** |
| 离线 ICL system 段 | **2,899 字符**（静态 2,824 + facts 73） |
| live header / system / purify / facts | ❌ **无法验证**（0 次 request，见 §1） |

## 4. 对 cache 基线的影响

- **A1 的工具/字符指纹（51/34,101/34,049）仍是离线值**，`toolsHash` 需要 live header 才能算——本轮**没有新基准**；`CACHE-NIGHT §9` 的产品行继续标"离线"，不动。
- 这个故障发生在**任何模型请求之前**，不产生缓存问题；但它会让 A1 live 一直零请求，且夜间投递每次触发一个失败 turn（会刷错误日志）。
- 旧会话 737ec994 的 header（59 工具、含 mc-tools、pre-A1）和 15 次 system replace 都是 **2026-11-05 的旧布局**，不能当 A1 证据。

## 5. 修法（P0，需 lead/用户执行；cache 不改 desktop profile）

1. **最小修法**：把 `packages/dsh-icl/presets/icl.patch.yml` 里 3 处 `suffix: 'Your working directory is {{cwd}}.'` **删除或清空**（`icl` / `icl-loop` / `icl-mc` 三个 preset 的 `tool-persona` entry；按内置 DSH 文档，working-directory service 自己会提供 cwd 上下文，不需要 suffix）。保留 `purifySections` 与插件白名单不动。
   - lab presets（`lab.patch.yml`）同样有 3 处；它们在 web/npm DSH 上能跑，但为了跨运行时一致，建议一起清掉（会轻微改动 lab system 字符数，属静态体积变化，需要重记 lab 基线一次——可等下次 sanctioned run）。
2. 改完**重启 desktop**（preset 文件在启动时装载），打开 ICL 会话发一句话验证：
   - 不应再出现 `unknown prompt variable`；
   - 出现 `request/header` → 我按 §6 做 live 复核。
3. 若暂时不改 preset：不要在 desktop 用 A1 开 ICL 会话（会持续产生失败 turn）；standard 会话不受影响。

## 6. 修复后的 live 复核清单（cache 执行）

- `request/header`：工具总数（ICL 面应 =51 + DSH 原生工具，总数会更高）、`mcb_*` 应为 0、toolsChars 两口径（34,101 数组 / 34,049 Σ）、`toolsHash`（live 新值）；
- `system/message`：字符/字节；确认 **4 段净化生效**（无 `You are an AI agent powered by DeepSeek Harness`、无 harness source、无 deliverable、无 Web GUI 段）；`systemHasDynamicFacts=false`；
- runtime-context：`icl:facts` sections 仍在、facts 快照 ≤1 条/轮；
- `image/offload=0`；写入 `CACHE-NIGHT §9.1`（产品行从"离线"改"live"）+ §9.2。

---

**结论一句话**：A1 已在 desktop 部署（配置正确、离线指纹 = 51 工具/34,101/34,049/无 mcb），但 **desktop 内置 DSH 不注册 `{{cwd}}`，A1 preset 的 persona suffix 又依赖它 → ICL 会话每次 turn 在请求前报错（0 请求）**，live 校验被阻塞；按 §5 清掉 suffix 并重启 desktop 后即可完成 §6 复核。
