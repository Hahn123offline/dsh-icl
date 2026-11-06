// 路径：所有默认值都从 ICL_ROOT / 仓库根推出来，不写死盘符。
//
// 真正的实现在 packages/core/src/icl-paths.mjs（插件也直接 import 那一份，
// 保证"一个根"只有一处定义）；这里保留 dsh-icl 原有的导出名，
// 另外给 config.mjs 提供"数据路径相对 ICL_ROOT、仓库资产相对 REPO_ROOT"两个解析器。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ICL_ENV, ICL_LAYOUT, REPO_ROOT, dshHome, iclPaths, iclRoot, legacyStateCandidates, resolveFrom,
} from '../../core/src/icl-paths.mjs'

/** dsh-icl 包根（src/ 的上一级）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

export { ICL_ENV, ICL_LAYOUT, REPO_ROOT, dshHome, iclPaths, iclRoot, legacyStateCandidates, resolveFrom }

// 早先的调用点（config.mjs / 测试）只认这些名字；语义保持"从根推导"。
export function defaultStateDir(env = process.env) {
  return iclPaths({ env }).stateDir
}

/** 仓库内只读资产（prompts/、config/）相对仓库根解析。 */
export function resolvePath(value, fallback) {
  if (value == null || value === '') return fallback
  return path.isAbsolute(String(value)) ? String(value) : path.resolve(REPO_ROOT, String(value))
}

/** 可写数据路径相对 ICL_ROOT 解析（换盘/整体迁移时跟着根走）。 */
export function resolveDataPath(value, fallback, { root } = {}) {
  if (value == null || value === '') return fallback
  return resolveFrom(root ?? iclPaths().root, String(value))
}
