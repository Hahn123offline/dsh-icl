
# MC 眼睛（快照 / 截图）

日常看场景先用 **`mcb_snapshot`**（结构化快照，毫秒级、零成本）；**不要一上来截图**。
只有在里程碑、告警取证、或用户/你明确想看画面时，才用 `mcb_eyes {mode:"screenshot"}`。

## mcb_snapshot

- 参数：`radius`（3–16，默认 8）——脚下方块图/附近统计的范围。
- 返回：位置/维度/血/食物/背包/快捷栏/手持/脚下方块图/附近方块/实体坐标/任务/安全（reflex/alarms）/`playable`。
- 用途：规划下一步、判断能不能挖/走/睡、写 checkpoint、异常取证。
- 成本：毫秒级；随时可用（暂停/离线也能出基础快照）。

## mcb_eyes {mode:"screenshot"}

- 参数：`kind`（milestone/alert/manual…）、`frames`（1–8，默认 1）、`width/height`、`waitMs`（3–10s）。
- 返回：PNG（模型真看图；旧宿主给路径）+ 同名 JSON meta（位置/视口/耗时/任务/安全状态）。
- **成本与限制**：约 7–8s/张、Edge headless 峰值约 1.3GB 内存（软件渲染，不占 GPU 模型锁）；两次截图至少间隔 15s、同时只允许一个；**没有 HUD/皮肤/粒子**，第三人称镜头，远处有摩尔纹；不能替代结构化快照做精确判断。
- 失败：429=太频繁/正在进行；501=body 没配置 viewer/Edge（用结构化快照）；500=本次截图失败（可重试一次或改用 snapshot）。
- **已知限制（body 在修）**：超平坦/负 Y 世界（如 lab 的 y≈-60）可能只截到天空（viewer 相机初始化问题）——**不要用截图做结构/方块验收**（shelter/战斗等验收由 body 的结构校验负责）；body 修好后会通知。
- 帧序列：`frames>1` 时返回多张 `-f001.png…`，给 album/video 复用；默认不开。
