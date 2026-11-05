// 模糊匹配：把模型写歪的名字/op 收敛到最近的合法值，错误信息里才有"你是不是要 X？"。
// 规则：完全相等 → 唯一包含 → 编辑距离（长度差 + 同位置不同字符数），阈值 4。
export function closest(value, list = []) {
  const needle = String(value ?? '').trim().toLowerCase()
  if (!needle) return null
  const exact = list.find((item) => String(item).toLowerCase() === needle)
  if (exact) return exact
  const contains = list.filter((item) => {
    const text = String(item).toLowerCase()
    return text.includes(needle) || needle.includes(text)
  })
  if (contains.length === 1) return contains[0]
  let best = null
  let score = Infinity
  for (const item of list) {
    const text = String(item).toLowerCase()
    const gap = Math.abs(text.length - needle.length)
    let diff = 0
    for (let i = 0; i < Math.min(text.length, needle.length); i += 1) if (text[i] !== needle[i]) diff += 1
    const total = diff + gap
    if (total < score) { score = total; best = item }
  }
  return score <= 4 ? best : null
}
