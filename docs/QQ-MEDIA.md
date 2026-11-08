# QQ 媒体出站（G4）

`qq_send_media` 是 QQ 的出站媒体入口；文本仍用 `qq_send`，表情包仍用 `qq_send_sticker`。
私聊和群聊共用同一个 `to`，不按聊天类型分工具。

## 用法

```text
qq_send_media { to: "QQ号或群号", path: "本地绝对路径" }
qq_send_media { to: "QQ号或群号", albumId: 12 }
qq_send_media { to: "QQ号或群号", path: "...", kind: "image|video|voice|file", replyToMessageId: "..." }
```

- `kind:auto` 按扩展名判断：图片 png/jpg/jpeg/gif/webp；视频 mp4/mov/webm/mkv；语音 mp3/wav/ogg/amr/silk/m4a/flac；其余按文件。
- 群目标仍然要求 `allowGroupSend=true` 且群在 `allowGroups`；私聊沿用 owner/白名单。
- `albumId` 从 album 服务取路径；不下载网络 URL。
- 只接受本地普通文件；符号链接、URL、超过上限、可执行/脚本文件拒绝。
- 图片上限 `maxSendImageBytes`；视频 `maxSendVideoBytes`；文件 `maxSendFileBytes`；语音 `maxSendVoiceBytes`。
- 媒体发送有 `maxMediaPerTurn` / `maxMediaPerHour`，并与文本共享同会话最小间隔/每分钟/每小时限流。
- 结果三态：ok / rejected / unknown；unknown 不自动重试（OneBot 没有幂等键）。
- 审计只记录媒体类型、文件名、字节数和回执，不记录文件内容。

## 传输

| 类型 | OneBot 动作 |
|---|---|
| 图片 | `send_private_msg` / `send_group_msg`，`image` 段 `base64://` |
| 视频 | `send_*_msg`，`video` 段，本地路径 |
| 语音 | `send_*_msg`，`record` 段，本地路径（由网关转码） |
| 文件（群） | `upload_group_file` → `send_group_msg` 的 `file` 段 |
| 文件（私聊） | `upload_private_file` |

## 边界

- 不自动发送，不把入站媒体回显给发送者。
- 不下载远程图片/视频；网络内容先落到本地再显式发送。
- 不做 EXE/脚本/快捷方式；文件扩展名黑名单见 `send-tool.mjs`。
- 视频/语音实际支持格式最终由 OneBot 网关与 ffmpeg 决定。
