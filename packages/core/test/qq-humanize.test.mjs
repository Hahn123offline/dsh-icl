// 出站人类化纯函数：md→纯文本、长文切分、typing 估算、多气泡计划、频率闸门。
// 这些是从旧实现移植/改编的判定，用单测锁住边界（尤其代理对与 URL）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mdToPlain, splitForQQ, splitLongText, typingMs, planBurst, rateCheck, BURST, PACES } from '../../plugins/qq/src/humanize.mjs'

test('mdToPlain：代码块/行内代码/粗斜体/删除线/标题/引用/列表', () => {
  const input = [
    '## 标题',
    '> 引用一句',
    '**粗体** 和 *斜体* 和 ~~删除~~',
    '- 第一项',
    '- 第二项',
    '`inline code`',
    '```js',
    'const a = 1',
    '```',
  ].join('\n')
  const out = mdToPlain(input)
  assert.match(out, /标题/)
  assert.match(out, /引用一句/)
  assert.match(out, /粗体 和 斜体 和 删除/)
  assert.match(out, /• 第一项/)
  assert.match(out, /inline code/)
  assert.match(out, /const a = 1/)
  assert.doesNotMatch(out, /```/)
})

test('mdToPlain：链接/图片/表格；乘法式与列表标记不被误吃', () => {
  const out = mdToPlain('看[这个](https://example.com/a) ![图](https://x/y.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n2 * 3 * 4')
  assert.match(out, /这个 \(https:\/\/example\.com\/a\)/)
  assert.match(out, /图/)
  assert.match(out, /2 \* 3 \* 4/)
  assert.doesNotMatch(out, /---/)
})

test('splitForQQ：不超长、可拼回原文、emoji 不被切开', () => {
  const text = '第一行\n' + '😀'.repeat(1200)
  const parts = splitForQQ(text, 100)
  assert.equal(parts.join(''), text)
  for (const part of parts) {
    assert.ok(part.length <= 100, `part too long: ${part.length}`)
    const last = part.charCodeAt(part.length - 1)
    const first = part.charCodeAt(0)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), '不应以孤立高代理结尾')
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), '不应以孤立低代理开头')
  }
})

test('splitLongText：URL 整条保留、内容不丢', () => {
  const url = 'https://example.com/' + 'a'.repeat(80)
  const text = `看这个 ${url} 然后继续聊天`
  const parts = splitLongText(text, 30)
  assert.equal(parts.join(''), text)
  assert.ok(parts.some((p) => p.includes(url)), 'URL 不能被切断')
  for (const part of parts) {
    if (part.includes(url)) continue
    assert.ok(part.length <= 30, `非 URL 片段应 ≤30：${part.length}`)
  }
})

test('typingMs：1.4 字/秒、档位越慢越久、夹在 600–25000ms', () => {
  const normal = typingMs('一百个字'.repeat(25)) // 100 字
  assert.ok(normal >= 600 && normal <= 25_000)
  assert.ok(typingMs('一百个字'.repeat(25), { pace: 'thoughtful' }) >= normal)
  assert.ok(typingMs('一百个字'.repeat(25), { pace: 'blast' }) <= normal)
  assert.equal(typingMs(''), 0)
  assert.equal(typingMs('a', { minMs: 10, maxMs: 100 }), 100, '上限夹住')
})

test('planBurst：单条无延迟；auto 间隔 1–3s 或长停顿 5–10s', () => {
  assert.deepEqual(planBurst(['hi']), [{ text: 'hi', delayBeforeMs: 0 }])
  const seq = [0.1, 0.9, 0.2, 0.95]
  let i = 0
  const steps = planBurst(['a', 'b', 'c', 'd', 'e'], { random: () => seq[i++ % seq.length] })
  assert.equal(steps[0].delayBeforeMs, 0)
  for (const step of steps.slice(1)) {
    const gap = step.delayBeforeMs
    const normal = gap >= 1000 && gap <= 3000
    const long = gap >= 5000 && gap <= 10_000
    assert.ok(normal || long, `gap out of range: ${gap}`)
  }
})

test('planBurst：fixed/byLength/typing 模式与上限', () => {
  const fixed = planBurst(['a', 'b', 'c'], { gapMode: 'fixed', gapMs: 1500 })
  assert.deepEqual(fixed.map((s) => s.delayBeforeMs), [0, 1500, 1500])
  const clamped = planBurst(['a', 'b'], { gapMode: 'fixed', gapMs: 50_000 })
  assert.equal(clamped[1].delayBeforeMs, BURST.clampMaxMs)
  const byLength = planBurst(['abcd', 'x'], { gapMode: 'byLength' })
  assert.equal(byLength[1].delayBeforeMs, 800 + 20 * 4)
  const typing = planBurst(['你好'.repeat(10), 'x'], { gapMode: 'typing' })
  assert.equal(typing[1].delayBeforeMs, Math.min(typingMs('你好'.repeat(10)), BURST.clampMaxMs))
  const many = planBurst(Array.from({ length: 20 }, (_, i) => `m${i}`), {})
  assert.equal(many.length, BURST.maxMessages)
})

test('planBurst：单条超长时按 maxChars 拆开拼回（不丢内容）', () => {
  const text = '字'.repeat(1200)
  const steps = planBurst([text], { maxChars: 500 })
  assert.equal(steps.length, 1)
  assert.equal(steps[0].text, text)
})

test('rateCheck：8/min、60/h', () => {
  const now = 1_800_000_000_000
  const eight = Array.from({ length: 8 }, (_, i) => now - i * 100)
  assert.equal(rateCheck(eight, now).ok, false)
  assert.equal(rateCheck(eight.slice(0, 7), now).ok, true)
  const sixty = Array.from({ length: 60 }, (_, i) => now - i * 60_000)
  assert.equal(rateCheck(sixty, now, { perMinute: 0 }).reason, 'per_hour')
  assert.equal(PACES.thoughtful > PACES.blast, true)
})
