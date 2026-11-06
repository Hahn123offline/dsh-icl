# bilibili-mcp（vendored）

- **上游**：<https://github.com/adoresever/bilibili-mcp>，作者 AGI_Ananas，MIT。
  原始副本来自 `dsh-bili-scroll` 的 `vendor/bilibili-mcp/`（MIT，见同目录 `LICENSE`）。
- **为什么放进来**：ICL 的 B 站接入（C 路线）要**自持**运行面：代码、只读白名单、凭证目录、
  依赖版本都在本仓库里，不再依赖用户机器上旧插件 `~/.dsh/bili-duty/` 的那份安装。
- **我们只用的部分**：搜索 / 视频信息 / 字幕 / 评论 / 热门 / 排行榜 / 每周必看 / 热搜词。
  **写能力（发评论、私信、上传、动态、收藏）不在 ICL 的调用面里**——`tools/bili-run.py`
  有独立白名单，见 `PATCHES.md` 第 ⑦ 条。
- **不随包分发上游的 CLI/README**；许可与署名以本目录 `LICENSE` 与本文为准。
