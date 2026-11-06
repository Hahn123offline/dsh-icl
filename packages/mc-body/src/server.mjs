// mc-body/v1 本地 HTTP 契约。只监听回环。
// 事件台账带 seq；任务支持幂等创建、取消、显式 resume（身体/单任务两级）。
import http from 'node:http'
import { URL } from 'node:url'

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 64 * 1024) throw Object.assign(new Error('body too large'), { statusCode: 413 })
  }
  if (!body.trim()) return {}
  try { return JSON.parse(body) } catch { throw Object.assign(new Error('invalid json'), { statusCode: 400 }) }
}

export function createHttpServer(body, { host = '127.0.0.1', port = 54836 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    try {
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/v1/status') return json(res, 200, body.status())
      if (req.method === 'GET' && url.pathname === '/v1/events') return json(res, 200, body.eventsSince(url.searchParams.get('since')))
      if (req.method === 'GET' && url.pathname === '/v1/tasks') return json(res, 200, { ok: true, tasks: body.listTasks(url.searchParams.get('state')) })
      if (req.method === 'GET' && url.pathname.startsWith('/v1/tasks/')) {
        const task = body.getTask(url.pathname.slice('/v1/tasks/'.length))
        return task ? json(res, 200, { ok: true, task }) : json(res, 404, { ok: false, error: 'no task' })
      }
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const input = await readJson(req)
        return json(res, 200, { ok: true, task: body.createTask(input) })
      }
      if (req.method === 'POST' && url.pathname.endsWith('/cancel') && url.pathname.startsWith('/v1/tasks/')) {
        const id = url.pathname.slice('/v1/tasks/'.length, -'/cancel'.length)
        const input = await readJson(req).catch(() => ({}))
        return json(res, 200, { ok: true, task: body.cancelTask(id, input.reason ?? 'cancelled') })
      }
      // 显式 resume 一个 paused 任务（断线/超时后复核完再继续）；不自动续跑。
      if (req.method === 'POST' && url.pathname.endsWith('/resume') && url.pathname.startsWith('/v1/tasks/')) {
        const id = url.pathname.slice('/v1/tasks/'.length, -'/resume'.length)
        return json(res, 200, { ok: true, task: body.resumeTask(id) })
      }
      if (req.method === 'POST' && url.pathname === '/v1/do') {
        const input = await readJson(req)
        return json(res, 200, { ok: true, ...(await body.doPlan(input.steps, input.params ?? {})) })
      }
      if (req.method === 'POST' && url.pathname === '/v1/inspect') {
        const input = await readJson(req)
        return json(res, 200, { ok: true, result: await body.inspect(input.kind, input.params ?? {}) })
      }
      if (req.method === 'POST' && url.pathname === '/v1/shutdown') {
        const input = await readJson(req).catch(() => ({}))
        return json(res, 200, { ok: true, ...(await body.shutdownRequest(input.reason ?? 'api')) })
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat') {
        const input = await readJson(req)
        await body.chat(input.text)
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/v1/safety/stop') {
        // mcb_stop 对应的 body 行为：cancel+反射+报告；暂停中也可调用，不需要先 resume。
        const input = await readJson(req).catch(() => ({}))
        return json(res, 200, body.stopAll(input.reason ?? 'manual'))
      }
      if (req.method === 'POST' && url.pathname === '/v1/safety/resume') {
        const input = await readJson(req).catch(() => ({}))
        return json(res, 200, { ok: true, ...body.resume({ force: Boolean(input.force) }) })
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return json(res, Number(error?.statusCode) || 500, { ok: false, error: String(error?.message ?? error) })
    }
  })
  return {
    server,
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
