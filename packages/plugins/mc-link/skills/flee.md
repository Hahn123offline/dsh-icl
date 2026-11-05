# 逃跑/战斗

## 默认

`autoDefense: "fleeOnly"`：先撤到安全距离/掩体，低血先吃。苦力怕贴脸先退，不对刀。

## 模型 override

在 `mcb_do` / 任务里显式：

```json
{"safety":{"autoDefense":"allow","allowFight":true}}
```

低血/死亡仍会硬停止；override 会留痕。

## 不要

- 为了任务硬顶；
- 在苦力怕旁边对刀；
- 不带食物/盾去打。
