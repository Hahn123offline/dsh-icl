// 统一的子进程入口：超时、输出上限、错误归一化。
//
// 视频侧的子进程都不可信（ffmpeg/ffprobe/storyboard CLI 都可能卡住或吐几百 KB），
// 所以 timeout / maxBuffer 是硬约束，错误也要带稳定 code。
import { execFile } from 'node:child_process'

/**
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 * 非 0 退出抛错，error.code 是 E_* 机器码。
 */
export function runProcess(command, args, {
  timeoutMs = 120_000,
  maxBuffer = 32 * 1024 * 1024,
  env = process.env,
  code = 'E_PROCESS',
  label = command,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer, env, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`${label} 失败：${String(error?.message ?? error)}`)
        failure.code = error?.killed || error?.signal ? 'E_TIMEOUT' : code
        failure.stdout = String(stdout ?? '')
        failure.stderr = String(stderr ?? '')
        reject(failure)
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 })
    })
  })
}
