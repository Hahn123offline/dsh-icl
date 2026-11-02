#!/usr/bin/env python3
"""调用 bili-duty 里现成的 MCP 工具（不复制它的代码，只做调用）。

用法：
  python tools/bili-run.py bili_search '{"keyword":"AI Agent","num":5}'
输出：一行 JSON（结果字符串或错误）。
"""
import asyncio
import importlib
import json
import os
import sys

BILI_DIR = os.environ.get("BILI_DIR") or os.path.expanduser(os.path.join("~", ".dsh", "bili-duty"))


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: bili-run.py <function> <json-args>"}))
        return 2
    fn_name = sys.argv[1]
    try:
        kwargs = json.loads(sys.argv[2] or "{}")
    except Exception:
        kwargs = {}
    sys.path.insert(0, BILI_DIR)
    try:
        mod = importlib.import_module("mcp_server")
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"import failed: {error}"}))
        return 1
    fn = getattr(mod, fn_name, None)
    if fn is None or not asyncio.iscoroutinefunction(fn):
        print(json.dumps({"ok": False, "error": f"no such tool: {fn_name}"}))
        return 1
    try:
        result = asyncio.run(fn(**kwargs))
        print(result if isinstance(result, str) else json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
