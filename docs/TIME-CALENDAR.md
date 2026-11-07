# Time 日历层设计（v2 已实现）

状态：**v2 已实现（2026-11-07）**。原则：**在现有 `schedules` 上扩展，不新开日历库、不重复已有天粒度节律**。

已落地：`date / endDate / allDay / wake / repeat(every,until,count) / skipDates`；`repeat.every` 支持 `Nd / Nw / Nmo / Ny`；`time_view.calendar`（today/tomorrow/week）；`time_status` 的 `【今天】【明天】【本周】` 区块。
monthly/yearly 采用标准日历语义：遇到不存在的日期（31 号遇到小月、2/29 遇平年）**跳过该次 occurrence**，不压到月末。
未做：复杂 RRULE、逐事件时区、GUI；`skipDates` 是唯一例外形式，改某天先取消再建。

## 0. 事实基线

- 当前 `schedules` 已支持：单次 ISO、每天 HH:mm、每周 weekday+HH:mm、倒计时 `in`、span 时长/睡眠
- `time_view()` 已经是结构化时间数据（phase/next/spans/goals/heartbeat/backlog/stats），保留给模型和未来 UI
- `time_status` 是它的文本渲染；`world_status` 只放 compact 日程一行 + detail，不重复完整文本
- 已有"天粒度节律"= daily/weekly；日历层只补日期、跨天、例外和区间，不重做 recurrence 基本盘

## 1. 事件模型 = 现有 schedule + 少量可选字段

不新增 `calendar_events` 表；**一条日历事件就是一条 schedule**。

扩展字段（全部可选，旧数据不变）：

| 字段 | 含义 |
|---|---|
| `date` | `YYYY-MM-DD`，具体日期（单次/重复的起点） |
| `endDate` | `YYYY-MM-DD`，跨天事件结束日期（含当天） |
| `allDay` | 无具体时刻的事件；默认 true（date 有、at 没有时） |
| `wake` | 是否在事件开始产生唤醒；`allDay` 默认 false，timed 默认 true |
| `repeat` | `{ every: "2d" / "1w" / "1mo" / "1y", until?: "YYYY-MM-DD", count?: N }` |
| `skipDates` | `["YYYY-MM-DD", ...]`，跳过某些天的 occurrence（不改事件本身） |

已有 `at`/`weekdays`/`in`/`duration`/`sleep`/`silent`/`focus`/`turnLimit` 保留：

- `at:"2026-11-08"` → 当天 all-day 单次
- `at:"2026-11-08 07:30"` → 当天 timed 单次
- `duration:"3d"` 或 `endDate` → 跨天 span
- `at:"HH:mm"` / `weekdays` → 现有每天/每周；加 `repeat.every` 只是把"每 1 天/周"扩展成"每 N 天/周"
- `silent:true` 仍然是"只发事件不唤醒"；`wake:false` 是日历级"只展示不叫醒"

## 2. 标准日历语义（第一版）

- **timed 事件**：到开始时刻产生 wake（可 `silent`/`wake:false` 关掉）；span 持续到 end/ duration
- **all-day 事件**：默认只进日历视图，不产生 wake；需要叫醒时显式 `wake:true`
- **跨天事件**：从 start 到 endDate 整天；`span` 语义，期间可暂停心跳（与现有 span 一致）
- **重复**：每天/每周沿用现有解析；`repeat.every` 支持 2d/2w/1mo/1y，`until`/`count` 截断；`skipDates` 跳过指定日期
- **例外**：第一版只做跳过；"改某一天"先取消再建一条，不做复杂 RRULE EXDATE 编辑器

## 3. 视图（模型 + 未来 UI 共用）

`time_view()` 增加：

```json
{
  "calendar": {
    "today": [{"id":"a","start":..., "end":..., "allDay":false, "title":"...", "mode":"wake", "kind":"single", "sleep":false, "silent":false}],
    "tomorrow": [...],
    "week": [...]
  }
}
```

`time_status` 文本增加固定区块（有内容才出现）：

```
【今天】
· 07:30 早课（wake，25m）
· 全天 生日（all-day，只展示）
【明天】
...
【本周】
...
```

`time_list` 保持"全部安排平铺"作为详细清单；日历视图只负责按天分组，不重复事件内容。

## 4. 工具扩展（仍用 `time_arrange`）

```json
{"mode":"wake","date":"2026-11-08","at":"07:30","message":"早课"}
{"mode":"wake","date":"2026-11-08","allDay":true,"message":"生日"}   // 默认只展示
{"mode":"wake","date":"2026-11-08","endDate":"2026-11-10","sleep":false,"message":"出差"}
{"mode":"wake","at":"07:30","weekdays":[1,3,5],"repeat":{"every":"2w","until":"2026-12-31"},"message":"隔周"}
{"mode":"wake","at":"07:30","repeat":{"every":"1d"},"skipDates":["2026-11-10"],"message":"每天但跳过一天"}
```

不新增 `time_calendar` 工具；`time_view` 只作为结构化数据出口保留。

## 5. 非目标（第一版不做）

- CalDAV / Google Calendar / 外部同步
- 每事件独立时区（先用全局 `timeZone`）
- 复杂 RRULE（BYDAY 组合、月末规则、EXDATE 改写）
- GUI（等后端稳定后，直接消费 `time_view.calendar`）

## 6. 需要确认

1. all-day 事件默认**只展示不叫醒**，需要时 `wake:true`——同意吗？
2. 第一版是否包含 `monthly/yearly`，还是先 date/跨天/interval/until，monthly/yearly 放第二版？
3. 例外只做 `skipDates`（跳过），"改某一天"先取消再建——可以吗？
