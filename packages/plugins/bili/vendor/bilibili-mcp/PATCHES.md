# 本地补丁清单（重新 vendor 时逐条核对）

来源：`dsh-bili-scroll@2.0.0` 的 `vendor/bilibili-mcp/mcp_server.py`。
上游：AGI_Ananas/bilibili-mcp（MIT）。重新 vendor 时，下面每一条都要补回来。

| # | 补丁 | 位置 | 为什么 |
|---|---|---|---|
| ① | `_ALLOWED` + `tool()` 白名单替身 | `mcp_server.py:40-53` | 用 MCP 方式启动时按 `BILI_MCP_TOOLS` 注册工具；名单外的工具连名字都不出现 |
| ② | `load_credential` 读取容错 + UTF-8 + dict 校验 | `mcp_server.py:56-75` | 凭证文件写坏一次不能把所有工具一起炸掉；Windows 默认 GBK 会坏中文 |
| ③ | 登录成功后凭证**原子写** | `mcp_server.py` 的 login 分支 | 写一半断电不会留下坏 JSON |
| ④ | `bili_comments` 把抓取异常带进返回 | `mcp_server.py:313-383` | 风控 `-412` 不能伪装成"这条视频 0 条评论" |
| ⑤ | `bili_reply` 回执带 `rpid`/`rpid_str`/`root`/`parent` | `mcp_server.py:513-569` | 判重与评论复核要用（ICL 不调用写接口，但保留补丁） |
| ⑥ | `CRED_FILE` 支持 `BILI_CREDENTIAL` 环境变量 | `mcp_server.py:36` | ICL 接入后凭证归 ICL 的 `stateDir/bili/`，不写死进 vendor 目录 |
| ⑦ | 只读白名单在**调用侧**（不在本文件里） | `tools/bili-run.py` 的 `ALLOWED` | 即使有人改了参数，也调不到 `bili_reply`/`bili_upload_video` 等写函数 |

依赖（见 `requirements.txt`）：`bilibili-api-python>=17.4.1,<18`、`aiohttp>=3.9.0`、`mcp>=1.0.0,<2`、`qrcode[pil]>=8.0`。
`mcp` 必须锁 `<2`（2.x 的 server 没有 `list_tools`，起不来）。

## 已知行为（ICL 侧错误归一化要认）

- 无凭证：`bili_search` 仍能匿名工作；`bili_video_info`/`bili_subtitle`/`bili_comments` 会抛"未登录"。
- 凭证无效：`bili_check_credential` 可能**假阳性**（它查的是公开用户信息）；`bili_subtitle` 可能把鉴权失败
  报成"该视频没有字幕"。ICL 侧因此**不打印/不依赖** `logged_in`，并用 SESSDATA 到期 + 真实调用双重判断。
