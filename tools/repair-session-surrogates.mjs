#!/usr/bin/env node
// 修复 DSH session.v4.jsonl.zstd 里的孤立 UTF-16 surrogate。
//
// 触发场景：QQ/插件摘要按 UTF-16 长度截断 emoji，可能留下 lone surrogate；
// DSH 把这种字符串带进后续请求时，DeepSeek Messages 可能返回 400 INVALID_REQUEST。
// 本脚本只替换孤立 surrogate（U+FFFD），不动正常文本、消息顺序和附件引用。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      const prev = value.charCodeAt(i - 1)
      if (!(prev >= 0xD800 && prev <= 0xDBFF)) return true
    }
  }
  return false
}

function sanitize(value) {
  if (typeof value === 'string') {
    return hasLoneSurrogate(value) ? value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') : value
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = sanitize(child)
    return out
  }
  return value
}

export function repairSessionFile(file, { backup = true, dryRun = false } = {}) {
  const original = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  const lines = original.split(/\r?\n/)
  let bad = 0
  const repaired = lines.map((line) => {
    if (!line.trim()) return line
    let row
    try { row = JSON.parse(line) } catch { return line }
    const clean = sanitize(row)
    if (JSON.stringify(clean) !== JSON.stringify(row)) bad += 1
    return JSON.stringify(clean)
  })
  if (!bad || dryRun) return { changed: bad > 0, bad, dryRun }
  if (backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(file, `${file}.bak-${stamp}`)
  }
  // DSH session persistence expects a concatenation of complete checksummed
  // Zstandard frames: one header frame, then one or more frames per durable batch.
  // Keep the header alone and put each event in its own valid frame.
  const checksum = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
  const frame = (text) => zlib.zstdCompressSync(Buffer.from(`${text}\n`, 'utf8'), checksum)
  const frames = []
  const body = repaired.filter((line) => line !== '')
  if (body.length) frames.push(frame(body[0]))
  for (const line of body.slice(1)) frames.push(frame(line))
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, Buffer.concat(frames))
  fs.renameSync(temp, file)
  return { changed: true, bad, frames: frames.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) {
    console.error('用法: node tools/repair-session-surrogates.mjs <session.v4.jsonl.zstd> [--dry-run]')
    process.exit(2)
  }
  const result = repairSessionFile(file, { dryRun: process.argv.includes('--dry-run') })
  console.log(JSON.stringify(result))
}
