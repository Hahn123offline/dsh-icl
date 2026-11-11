// 评测工具的写路径护栏：绝不读写 live state（C:\Users\ai_admin\.dsh\icl\state）。
//
// 只做路径字符串判断，不 stat / 不读目录——"不写 live"也包括别去探活它。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** live 状态的根目录（DSH Desktop 正在用的那一份）。 */
export const LIVE_STATE_ROOT = path.join(os.homedir(), '.dsh', 'icl', 'state')

function normalize(target) {
  const resolved = path.resolve(String(target ?? ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** child 是否等于/位于 parent 内（大小写不敏感仅 Windows）。 */
export function isInside(child, parent) {
  const target = normalize(child)
  const root = normalize(parent)
  if (!target || !root) return false
  return target === root || target.startsWith(`${root}${path.sep}`)
}

/** 写/读路径护栏：命中 live state 直接抛错（由 CLI 转成 exit 2）。 */
export function assertNotLive(target, what = '路径') {
  if (isInside(target, LIVE_STATE_ROOT)) {
    throw new Error(`${what}落在 live state 下（${LIVE_STATE_ROOT}）：${path.resolve(String(target))}。评测工具绝不读写 live。`)
  }
  return path.resolve(String(target))
}

/** 建临时目录（os.tmpdir 下），并确认不可能是 live。 */
export function makeTempDir(prefix = 'icl-memory-eval-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return assertNotLive(dir, '临时目录')
}

/** 输出目录护栏：必须在非 live 路径下（默认 .state/lab/eval-harness/...）。 */
export function assertSafeOutDir(dir) {
  return assertNotLive(dir, '输出目录')
}
