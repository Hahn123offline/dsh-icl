# 官方 DSH skills（vendored）

这些 skill 从 DeepSeek Harness 官方仓库取来，用于约束后续 agent 的工作方式。
**不是本项目的代码，不要改它们**；要改就重新取一次再覆盖。

## 来源

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/deepseek-harness |
| 提交 | `8bd073392eef6f54e921a093b95076248eb08cbb`（分支 `master`） |
| 取得日期 | 2026-11-03 |
| 许可 | MIT（见上游 `LICENSE`） |
| 取得方式 | 通过 `ghfast.top` 代理逐文件取 raw（本机直连 GitHub 被 hosts 指到 127.0.0.1，且 Watt Toolkit 未运行） |

## 收了哪些

**A. 官方 agent preset 自带的四个**（`packages/preset/agent-preset/skills/`，随 DSH 发行，每个会话都能用）

| skill | 用途 |
|---|---|
| `cordis-plugin-development` | 写 DSH 插件 / bundle / preset / 工具面 / UI 插件。**最相关的一个** |
| `cordis-composition-reference` | loader patch 方言与可安装包清单（含 `references/packages.md` 43 KB） |
| `editing-cordis-compositions` | 改 agent preset 与组合配置 |
| `agent-experience` | agent 自我体验调优的短条目 |

**B. 上游仓库的开发者 skill 里挑了四个**（`.agents/skills/`，原本给 DSH 仓库贡献者用）

| skill | 用途 |
|---|---|
| `dsh-code-review` | 代码审查的检查项与报告格式 |
| `dsh-prose-standard` | 文档与注释的写作标准（含"不要复述代码"这类硬规则） |
| `dsh-error-handling` | 结构化失败、上报与所有权 |
| `dsh-session-projection` | 会话状态的投影与读取 |

没取的（与本项目无关，需要时再取）：`dsh-cua-macos-signing`、`record-browser-gif`、
`dsh-ci-test-reliability`、`dsh-translate-docs`、`dsh-pr-description`、`dsh-official-plugin-artwork` 等。

## 怎么用（重要）

这些 skill 描述的是**上游的写法**：TypeScript、`@deepseek-ai/dsh-*` 包、pnpm workspace、`cordis.yml`。
**本仓库是纯 ESM `.mjs`、无构建、自有宿主（`createHost`）**，照搬形式会跑偏。

用法：**取原则，不取形式**。

| 可取的原则 | 不要照搬的形式 |
|---|---|
| 注册即 effect，必须可注销 | `ctx.effect()` / Cordis Service 类继承 |
| 错误要显式、结构化、有归属 | `Branded<B>` 类型、`assertNever` |
| 配置项要显式、可变、不要在插件里硬编码 tunable | Cordis Config JSDoc schema |
| 模型可见的输入必须可从日志重建 | `SessionEventMap` 声明合并 |
| 文档不复述代码、一个事实一个家 | 双语 i18n / VitePress 站点 |

具体到本项目，最有用的是 `cordis-plugin-development` 的**安装与排障**部分
（bundle patch、profile 依赖、重启后验证），因为它正是 `icl-live` 接线踩过的坑。

## 怎么更新

本机走代理时用 `ghfast.top` 前缀拉 raw：

```powershell
$sha = '<新的 commit>'
$base = "https://ghfast.top/https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/$sha/"
Invoke-WebRequest -Uri ($base + 'packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md') -OutFile ...
```

或者用只取树的浅克隆再 sparse checkout：

```powershell
git clone --filter=blob:none --depth 1 --no-checkout https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git dsh-upstream
cd dsh-upstream; git sparse-checkout init --cone
git sparse-checkout set packages/preset/agent-preset/skills .agents/skills
git checkout
```

更新后请把上面的"提交"一行改掉。

## 为什么放在 `.dsh/skills/`

DSH 会为工作区加载 `.dsh/skills/<name>/SKILL.md`。放在这里，打开这个工作区的 agent
就能直接加载它们，不需要额外配置。
