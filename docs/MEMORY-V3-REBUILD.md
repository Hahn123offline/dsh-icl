# v3 记忆重建 Runner 与 live 切换 Dry-run（2026-11-12）

> 目标 ④/⑤：从 raw 全量重建（逐天幂等、可中断、旧库归档、可回滚），先在 lab 三源跑通；
> live 切换前给出 dry-run 清单并停下等用户确认。**本文不执行任何 live 写入。**
>
> 用户决策（2026-11-12）：**live 重建等用户停 DSH 后执行**；recall 的 LLM rerank **默认关闭**。

## 1. Runner：`tools/memory-rebuild.mjs`

```bash
node tools/memory-rebuild.mjs --fixture <fixture目录> --out <重建目录> \
  [--schema v3] [--model cloud|echo] [--embed] [--archive] [--max-calls N]
```

- 输入：`memory-corpus` 工具产出的 raw fixture（focus-core / 旧 QQ / live raw 均可导入成 fixture）。
- 输出：`<out>/state/memory.db`（v3 episode 库）、`<out>/cache/`（LLM/Embedding 缓存）、
  `<out>/manifest.json`（来源、模型、计数、exportHash、semanticHash、git commit、逐日 job 结果）。
- **逐天 replay**：沿用 dream 的 attempts 账本，已完成的 day/job 自动 skip；
  中断后对同一 `--out` 再跑即续跑。
- **幂等**：manifest 带 `semanticHash`（episode/段/实体/关系/人物/typed 的文本哈希，不含运行时账本）。
  实测：第二次续跑后 semanticHash 不变（见 §2）。
- **归档**：`--archive` 时先复制已有 `memory.db` 到 `<out>/archive-<时间>.db`，不删除旧库。
- **回滚**：重建目录可整体替换；live 场景保留旧 DB 归档 + 旧 preset（schema v2）即可回退。

## 2. Lab 三源重建验证（2026-11-12，cloud + bge-m3，串行）

| 素材 | 天数 | episodes | 段 | entities | relations | person 块 | notes | semanticHash（续跑后） |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| focus-core | 5 | 28 | 60 | 10 | 1 | 3 | 159 | 稳定（第二次跑不变） |
| old-qq | 5 | 13 | 15 | 4 | 3 | 5 | 146 | — |
| live raw 快照 | 8 | 24 | 52 | 6 | 3 | 1 | 61 | — |

- 幂等实测（focus，全新目录）：run1 semanticHash `e6b84f…`，run2（--archive 续跑）semanticHash `e6b84f…`
  完全一致；exportHash 因补记 skip 账本行而变化（预期）。
- 目标目录：`.state/lab/lead/rebuild/{focus,qq,live}/`、`.state/lab/lead/rebuild/focus-idem/`。

### 2.1 合并三源 fixture（live 全量重建输入）

新增 corpus 子命令：

```bash
node tools/memory-corpus.mjs merge \
  --inputs .state/lab/memory-corpus/real-focuscore-2026-10,.state/lab/memory-corpus/real-qq-2026-10,.state/lab/memory-corpus/live-2026-11-12 \
  --out .state/lab/memory-corpus/live-rebuild-2026-11-12 --id live-rebuild-2026-11-12
```

- 合并结果：**19 天 / 1586 行 / 3 来源**（旧 focus-core 5 天 + 旧 QQ 5 天 + 当前 live 9 天；日期不重叠），
  行 id 加来源前缀、跨来源重复行按 at/role/text/speaker 去重；gold/probes 清空（重建不需要 gold，
  保留一个占位负例 probe 满足 schema）。
- 旧 focus-core / 旧 QQ 的原始 DB 仍可通过 `import-focus-core` / `import-old-qq` 重新导入；
  live 快照用 `tools/memory-fixture-export.mjs` 只读导出（本次已刷新到 2026-11-12，含 9 天 raw）。
- staging 重建（lab）：`.state/lab/lead/rebuild/live-v3-2026-11-12/`；
  **结果：19 天 / 67 episodes / 133 段 / 15 entities / 8 relations / 6 person 块 / 363 notes；
  DB 4.3 MB；续跑 semanticHash 不变（3916371b…）**。
- staging audit（只读）：entity 15 行（stub 10、alias 冲突 0）、关系边 8（悬空 0）、
  person→entity 覆盖 100%、event/typed 0（v3 预期）、lexicon 36（工具味 1）。
- 验证通过后，live 切换只需"备份旧库 + 拷 staging DB + 改 preset + 重启"。

## 3. Live 切换 dry-run（只读清点，未执行）

### 3.1 输入来源（read-only 清点）

| 来源 | 路径 | 体量 | 时间覆盖 | 备注 |
|---|---|---|---:|---|
| 旧 focus-core | `C:\DSH\qwenstuff\focus-core\state\focus.db` | 1.0 MB；642 条消息 + 118 条 QQ | ~2026-10-22..10-31 | corpus 导入后 701 行/5 天 |
| 旧 QQ 库 | `C:\DSH\qwenstuff\dsh-qq\state\memory.db` | 405 KB；170 条 | 2026-10-22..10-26 | corpus 导入 170 行/5 天 |
| 当前 live raw | `~/.dsh/icl/state/session-events.jsonl` | 731 行（459 KB） | 2026-11-03..11-12 | 另 `qq/record.jsonl` 211 行 |
| 当前 live DB（待归档） | `~/.dsh/icl/state/state/memory.db` | 819 KB | 至今 | v2 旧库；切换时整库备份 |

### 3.2 规模与成本估算（按已有同构跑批外推）

- 覆盖天数：约 **19 天**（旧 focus/QQ 10 天 + live 9 天，日期不重叠；合并 fixture 已生成 19 天/1586 行）。
- 模型调用：约 **12 次/天 × 16 ≈ 190 次**（episodes/people/lexicon/consume/cleanup，含重试余量）。
- Token：按现有 18 天实测（prompt 625k chars / output 168k chars）外推 → 约 **31 万 prompt tokens + 9 万 completion tokens**；
  成本按 cloud provider 当前价目结算（量级个位数人民币，以实际账单为准）。
- 时间：串行约 **15–25 分钟**（不含 embeddings；本地 bge-m3 嵌入约 1–2 分钟）。
- 存储：新 DB 预计 < 5 MB；旧库归档一份（819 KB）。

### 3.3 切换步骤（**需用户确认后执行；DSH Desktop 需用户自己停/启**）

1. **dry-run 复核**：确认 §3.1 来源、§3.2 规模、gold/评测无阻塞；
2. 用户停 DSH Desktop（否则 live DB 被占用，替换不安全）；
3. 备份：`state/state/memory.db` → `state/archive/memory-v2-<时间>.db`（保留至少一份）；
4. 在 **staging 目录**（如 `.state/lab/lead/rebuild/live-v3/`）用三个来源的 raw fixture 重建 v3 库并验证
   （episodes/audit/样本/检索抽查）；
5. 将 staging 的 `memory.db` 放到 live `state/state/memory.db`（旧库已备份）；
6. 更新 preset：`dream.memorySchema: 'v3'`；recall 默认（rerank 是否开启待用户决定）；
7. 用户启动 DSH Desktop；检查：memory.ready、entity/relation/episode 计数、一次 recall 样本、audit；
8. 观察 1–2 天；异常则回退：停 DSH → 恢复归档 DB + preset 改回 v2 → 启动。

### 3.4 风险与注意

- 旧 focus-core/QQ 库是**其它插件/旧版本**的数据格式：corpus 导入器已适配（三源 fixture 验证通过），
  但 live 重建要用同一导入器重新生成 raw fixture，确保 id/时间/说话人映射一致。
- 当前 live raw 与旧库日期不重叠（10 月 vs 11 月），合并后按天 replay，不会重复。
- 切换后 recall 只看到 v3 命名空间（新库不含 v2 块）；旧库归档仅作追溯。
- **滚动重建与 live 运行不能并行**（DSH 占用 DB）；重建期间不要开 DSH。
- 需要用户拍板的两件事：①是否把旧 focus-core/旧 QQ 全量并入 live 重建（用户已说"全部从原始回填"，默认并入）；
  ②recall 的 LLM rerank 是否默认开启（成本/延迟 vs focus r5 84→99）。

## 4. 状态

- lab 三源重建 + 幂等/归档/续跑已验证；live 未做任何写入。
- 下一步（等用户确认后）：按 §3.3 执行 live 重建与切换；并补 focus 内容完整性缺口抽审。


