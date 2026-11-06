#!/usr/bin/env node
// 清理落入个人 DSH_HOME 的“测试 workspace / 会话”（lab 跑过的路径）。
//
// 背景：lab 进程用的是全局 $DSH_HOME（默认 ~/.dsh），sessions/workspace.json 与 desktop 共用，
// 长跑/探针/缓存审计会在 desktop 会话列表里堆大量测试会话。本脚本只清“测试路径”的 workspace：
//   - C:\DSH\icl-wt\*            （worktree lab）
//   - C:\DSH\icl\.state\lab\*    （lead/本仓 lab）
//   - C:\DSH\her-lab-workspace   （sandbox lab）
//   - C:\DSH\icl\.state\live2    （旧 live2 lab）
// 不碰用户真实工作区（C:\DSH\qwenstuff、C:\DSH\icl 等）。
//
// 默认 dry-run。--apply 才动手；动手前会把整个 sessions 匹配目录 + workspace.json 备份到
// <repo>/.state/archive/desktop-cleanup-<ts>/。
// 用法：node tools/dsh-clean-test-workspaces.mjs [--apply] [--keep-backup] [--json]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH = path.join(os.homedir(), '.dsh')
const SESSIONS = path.join(DSH, 'sessions')
const PROJCACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions')
const WORKSPACE_JSON = path.join(DSH, 'storages', 'workspace.json')

const TABLES = [
  /[\\/]icl-wt[\\/]/i,
  /[\\/]icl[\\/]\.state[\\/]lab[\\/]/i,
  /her-lab-workspace/i,
  /[\\/]icl[\\/]\.state[\\/]live2/i,
]
const DIRS = [/icl-wt-/i, /state-lab-/i, /her-lab-workspace/i, /state-live2/i]

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const JSON_OUT = args.has('--json')
// 只清指定 workspace（lab down 自动调用时用；仍要求它落在测试路径白名单内）
const ONLY = (() => {
  const i = process.argv.indexOf('--workspace')
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null
})()

function encodedName(workspacePath) {
  // lab 的 session 目录名：--C-DSH-icl-wt-...-workspace--（去掉盘符冒号、反斜杠变 -）
  return `--${String(workspacePath).replace(/:/g, '').replace(/\\/g, '-')}--`
}

function underTestPath(p) {
  return TABLES.some((re) => re.test(String(p || '')))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

if (!fs.existsSync(WORKSPACE_JSON)) {
  console.error(`找不到 workspace.json：${WORKSPACE_JSON}`)
  process.exit(1)
}

const store = readJson(WORKSPACE_JSON)
const ws = store?.tables?.workspaces ?? {}
const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase()
const matched = Object.entries(ws).filter(([, w]) => underTestPath(w.path) && (!ONLY || samePath(w.path, ONLY)))
const matchedIds = new Set(matched.map(([id]) => id))
const matchedSessionIds = new Set()
for (const [, w] of matched) for (const id of w.sessionIds ?? []) matchedSessionIds.add(id)

const sessionDirs = fs.existsSync(SESSIONS)
  ? fs.readdirSync(SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).filter((name) => (ONLY ? name === encodedName(ONLY) : DIRS.some((re) => re.test(name))))
  : []

const projFiles = fs.existsSync(PROJCACHE)
  ? fs.readdirSync(PROJCACHE).filter((name) => matchedSessionIds.has(name.replace(/^session-/, '').replace(/\.json$/, '')) || matchedSessionIds.has(name.replace(/\.json$/, '')))
  : []

const summary = {
  apply: APPLY,
  workspaceEntries: matched.length,
  workspaceIdsBefore: (store?.global?.workspaceIds ?? []).length,
  sessionDirs: sessionDirs.length,
  projectCacheFiles: projFiles.length,
  samplePaths: matched.slice(0, 8).map(([, w]) => w.path),
  sessionBytes: sessionDirs.reduce((sum, name) => {
    const dir = path.join(SESSIONS, name)
    return sum + fs.readdirSync(dir, { withFileTypes: true }).reduce((s, ent) => s + (ent.isFile() ? fs.statSync(path.join(dir, ent.name)).size : 0), 0)
  }, 0),
}

if (!JSON_OUT) {
  console.log(`# 测试 workspace 清理${APPLY ? '（apply）' : '（dry-run）'}`)
  console.log(`workspace 条目：${summary.workspaceEntries}`)
  console.log(`session 目录：${summary.sessionDirs}（约 ${(summary.sessionBytes / 1024 / 1024).toFixed(1)} MB）`)
  console.log(`project cache 文件：${summary.projectCacheFiles}`)
  console.log('样例路径：')
  for (const p of summary.samplePaths) console.log(`  - ${p}`)
}

if (!APPLY) {
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2))
  console.log('\n（dry-run，未改动；加 --apply 执行）')
  process.exit(0)
}

// ── 备份 ─────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupDir = path.join(REPO_ROOT, '.state', 'archive', `desktop-cleanup-${stamp}`)
fs.mkdirSync(path.join(backupDir, 'sessions'), { recursive: true })
fs.mkdirSync(path.join(backupDir, 'session_projcache'), { recursive: true })
fs.copyFileSync(WORKSPACE_JSON, path.join(backupDir, 'workspace.json'))
for (const name of sessionDirs) fs.cpSync(path.join(SESSIONS, name), path.join(backupDir, 'sessions', name), { recursive: true })
for (const name of projFiles) fs.copyFileSync(path.join(PROJCACHE, name), path.join(backupDir, 'session_projcache', name))
if (!JSON_OUT) console.log(`备份：${backupDir}`)

// ── 删除 workspace 条目 ───────────────────────────────
for (const id of matchedIds) delete ws[id]
store.global.workspaceIds = (store.global.workspaceIds ?? []).filter((id) => !matchedIds.has(id))
store.global.archivedSessionIds = (store.global.archivedSessionIds ?? []).filter((id) => !matchedSessionIds.has(id))
store.global.pinnedSessionIds = (store.global.pinnedSessionIds ?? []).filter((id) => !matchedSessionIds.has(id))
fs.writeFileSync(WORKSPACE_JSON, `${JSON.stringify(store, null, 2)}\n`)

// ── 删除 session 目录 / projcache ─────────────────────
let removedDirs = 0
for (const name of sessionDirs) {
  try { fs.rmSync(path.join(SESSIONS, name), { recursive: true, force: true }); removedDirs += 1 } catch (error) { console.error(`删除失败：${name}：${error.message}`) }
}
let removedCache = 0
for (const name of projFiles) {
  try { fs.rmSync(path.join(PROJCACHE, name), { force: true }); removedCache += 1 } catch (error) { console.error(`删除失败：${name}：${error.message}`) }
}

summary.removedDirs = removedDirs
summary.removedProjectCacheFiles = removedCache
summary.backupDir = backupDir
if (JSON_OUT) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`已删除 session 目录：${removedDirs}/${summary.sessionDirs}`)
  console.log(`已删除 project cache：${removedCache}/${summary.projectCacheFiles}`)
  console.log(`workspace 条目剩：${Object.keys(ws).length}；workspaceIds 剩：${store.global.workspaceIds.length}`)
  console.log('提醒：desktop 需要刷新/重启会话列表才能看到变化（本体不用重启）。')
}
