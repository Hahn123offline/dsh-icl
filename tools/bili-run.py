#!/usr/bin/env python3
"""ICL 的 B 站只读桥：调用仓库内 vendored MCP 的**只读函数**。

这是 ICL 接入层的一部分：
  · 代码从 <repo>/packages/plugins/bili/vendor/bilibili-mcp/ 导入（不再依赖旧插件的家目录）；
  · 凭证路径由 BILI_CREDENTIAL 指定（ICL 的 stateDir/bili/bili_credential.json）；
  · **白名单只读**：写函数（bili_reply / bili_send_message / bili_upload_video /
    bili_send_dynamic / bili_send_opus / bili_favorite_*）即使被点名也拒绝；
  · 失败统一成 {"ok": false, "code": "E_*", "error": ..., "next": ...}，调用侧据此给可操作错误。

用法：
  python tools/bili-run.py bili_search '{"keyword":"AI Agent","num":5}'
  python tools/bili-run.py --list
"""
import asyncio
import importlib
import json
import os
import sys

# ⭐ ICL 只读白名单：改这里必须同时改 docs/VIDEO-EYES.md / docs/PLUGINS.md 的 B 站节。
ALLOWED = {
    "bili_search",
    "bili_video_info",
    "bili_subtitle",
    "bili_comments",
    "bili_hot_videos",
    "bili_hot_buzzwords",
    "bili_weekly_hot",
    "bili_rank",
}

# 明确列出"存在但不给 ICL 用"的写函数，报错时告诉调用方为什么。
WRITE_FUNCS = {
    "bili_reply",
    "bili_send_message",
    "bili_upload_video",
    "bili_upload_video_multi",
    "bili_send_dynamic",
    "bili_send_opus",
    "bili_login",
    "bili_login_check",
    "bili_favorite_lists",
    "bili_favorite_content",
}

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_VENDOR = os.path.join(
    os.path.dirname(_HERE), "packages", "plugins", "bili", "vendor", "bilibili-mcp"
)
_LEGACY_HOME = os.environ.get("BILI_DIR") or os.path.expanduser(
    os.path.join("~", ".dsh", "bili-duty")
)


def emit(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else int(payload.get("_exit", 1))


def fail(code: str, error: str, next_step: str = "", exit_code: int = 1) -> int:
    return emit({
        "ok": False,
        "code": code,
        "error": error,
        "next": next_step,
        "_exit": exit_code,
    })


def classify(error: Exception) -> tuple:
    text = str(error)
    low = text.lower()
    if "未登录" in text or "credential" in low or "sessdata" in low or "-101" in text:
        return ("E_AUTH", "B 站凭证缺失或已失效。", "用 bili_login_start 扫码续期（凭证会写到 ICL 自己的 stateDir）。")
    if "-412" in text or "-509" in text or "请求过于频繁" in text or "风控" in text:
        return ("E_RATE_LIMIT", "被 B 站限流/风控了。", "等 30–60 秒再试；不要连续重试同一调用。")
    if "timeout" in low or "timed out" in low:
        return ("E_TIMEOUT", "B 站接口超时。", "稍后重试；连续失败就先停下，别把整轮预算烧在重试上。")
    if any(x in low for x in ("aiohttp", "connector", "connection", "ssl", "getaddrinfo", "network")):
        return ("E_NETWORK", "网络到 B 站不通。", "检查网络/代理；恢复后重试一次。")
    return ("E_TOOL", f"B 站接口调用失败：{text}", "把这条错误原文和调用参数一起报给维护者。")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if len(sys.argv) >= 2 and sys.argv[1] == "--list":
        return emit({"ok": True, "allowed": sorted(ALLOWED), "write_denied": sorted(WRITE_FUNCS)})

    if len(sys.argv) < 3:
        return fail("E_ARGS", "usage: bili-run.py <function> <json-args>", "调用方要传函数名与 JSON 参数。", 2)

    fn_name = sys.argv[1]
    try:
        kwargs = json.loads(sys.argv[2] or "{}")
    except Exception:
        return fail("E_ARGS", f"参数不是合法 JSON：{sys.argv[2][:200]}", "调用方拼参数时要用 json.dumps。", 2)

    if fn_name in WRITE_FUNCS:
        return fail(
            "E_READ_ONLY",
            f"ICL 只用只读接口，拒绝调用写函数：{fn_name}",
            "这是产品约束（她只读不互动）；要发评论/上传请用别的产品路径，不要从 ICL 开这个口子。",
        )
    if fn_name not in ALLOWED:
        return fail(
            "E_NOT_ALLOWED",
            f"不在 ICL 只读白名单里的函数：{fn_name}",
            f"可用：{', '.join(sorted(ALLOWED))}",
        )

    vendor = os.environ.get("BILI_VENDOR") or _DEFAULT_VENDOR
    if not os.path.isfile(os.path.join(vendor, "mcp_server.py")):
        vendor = _LEGACY_HOME  # 过渡期兜底：旧插件家目录里的那份（会记在错误里）
    if not os.path.isfile(os.path.join(vendor, "mcp_server.py")):
        return fail(
            "E_VENDOR",
            f"找不到 vendored mcp_server.py（试过 BILI_VENDOR 与 {_LEGACY_HOME}）",
            "确认仓库完整；不要指向不存在的目录。",
        )

    # 凭证路径必须在 import mcp_server 之前注入（它在 import 时算 CRED_FILE）。
    if os.environ.get("BILI_CREDENTIAL"):
        os.environ["BILI_CREDENTIAL"] = os.path.abspath(os.environ["BILI_CREDENTIAL"])
    sys.path.insert(0, vendor)
    try:
        mod = importlib.import_module("mcp_server")
    except Exception as error:  # noqa: BLE001
        return fail(
            "E_VENDOR",
            f"vendored mcp_server 导入失败：{error}",
            "检查 Python 依赖（bilibili-api-python<18 / mcp<2 / aiohttp / qrcode）是否装在这个解释器里。",
        )

    fn = getattr(mod, fn_name, None)
    if fn is None or not asyncio.iscoroutinefunction(fn):
        return fail("E_NOT_ALLOWED", f"vendored 里没有这个函数：{fn_name}", "检查 vendor 版本是否更新。")

    try:
        result = asyncio.run(fn(**kwargs))
    except Exception as error:  # noqa: BLE001
        code, message, next_step = classify(error)
        return fail(code, message, next_step)

    if isinstance(result, str):
        print(result)
        return 0
    return emit({"ok": True, "result": result})


if __name__ == "__main__":
    raise SystemExit(main())
