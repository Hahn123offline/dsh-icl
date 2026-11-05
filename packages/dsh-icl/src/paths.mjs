// 路径：所有默认值都从仓库/DSH_HOME 推出来，不写死盘符。
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** dsh-icl 包根（src/ 的上一级）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 仓库根：packages/dsh-icl → ../.. */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..')

export function dshHome() {
  return String(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

export function defaultStateDir() {
  return path.join(dshHome(), 'icl', 'state')
}

export function resolvePath(value, fallback) {
  if (value == null || value === '') return fallback
  return path.isAbsolute(String(value)) ? String(value) : path.resolve(REPO_ROOT, String(value))
}
