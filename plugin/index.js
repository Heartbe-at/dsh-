/**
 * Host half of the session-delete bundle.
 *
 * Deletion cannot happen while DSH is running: the session log is live and the
 * sidebar still references it. A delete request therefore does two things:
 *   1. archives the session (the supported "hide" operation), and
 *   2. writes the id into a durable queue.
 * On the next Host start, before the app is usable, the queue is drained:
 * the session directory is removed and the projection cache entry is dropped.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const REQUEST_PATH = '/api/session-delete/request'
const QUEUE_VERSION = 1
const MAX_QUEUED_TITLE = 200
const MAX_BODY_BYTES = 16 * 1024

/**
 * A queue is drained only by a freshly started Host. Plugin activation also
 * happens for an in-process install/reload, so skip entries created during the
 * current process and ignore activations long after start-up; only sessions
 * queued before this process started are deleted. The flag prevents repeated
 * scans on later activations.
 */
const BOOT_PURGE_WINDOW_MS = 10 * 60 * 1000
const BOOT_PURGE_FLAG = '__dshSessionDeleteBootPurgeStarted'

/** A conservative single path segment. Session ids are opaque strings. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/**
 * Serialize queue read-modify-write operations. The request route and the
 * startup purge run concurrently; without this lock one can overwrite an
 * entry the other just added or removed.
 */
let queueTail = Promise.resolve()

function withQueueLock(operation) {
  const result = queueTail.then(operation, operation)
  queueTail = result.then(() => undefined, () => undefined)
  return result
}

/**
 * Remove one queue entry, optionally only if its timestamp still matches the
 * snapshot the caller purged. Returns whether an entry was removed.
 * @param {string} sessionId
 * @param {number | undefined} expectedQueuedAt
 */
async function dropQueuedSession(sessionId, expectedQueuedAt) {
  return withQueueLock(() => {
    const queue = readQueue()
    const entry = queue.sessions[sessionId]
    if (!entry) return false
    if (expectedQueuedAt !== undefined && entry.queuedAt !== expectedQueuedAt) return false
    delete queue.sessions[sessionId]
    writeQueue(queue)
    return true
  })
}

export const name = 'dsh-session-delete'
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/**
 * Register the delete route and drain any queue left by the previous run.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: REQUEST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleRequest(ctx, request),
    })
    return () => {
      void dispose()
    }
  }, 'dsh-session-delete: request route')

  // The queue was written by a previous process; no live session can hold a
  // write handle for an archived, never-restored id at this point.
  maybePurgeQueue(ctx)
}

/**
 * Drain the previous run's queue once per process.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function maybePurgeQueue(ctx) {
  if (globalThis[BOOT_PURGE_FLAG] === true) return
  if (process.uptime() * 1000 > BOOT_PURGE_WINDOW_MS) return
  globalThis[BOOT_PURGE_FLAG] = true
  void purgeQueue(ctx)
}

/**
 * POST /api/session-delete/request
 * Body: { sessionId: string, title?: string }
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleRequest(ctx, request) {
  if (request.method !== 'POST') {
    return json(405, { kind: 'error', message: 'method not allowed' })
  }

  let body
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      return json(413, { kind: 'error', message: 'request body too large' })
    }
    body = JSON.parse(text)
  } catch {
    return json(400, { kind: 'error', message: 'invalid JSON body' })
  }

  const sessionId = body?.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return json(400, { kind: 'error', message: 'invalid sessionId' })
  }

  let alreadyQueued
  try {
    alreadyQueued = await withQueueLock(() => {
      const queue = readQueue()
      if (Object.hasOwn(queue.sessions, sessionId)) return true
      queue.sessions[sessionId] = {
        queuedAt: Date.now(),
        ...(typeof body.title === 'string' && body.title.length > 0
          ? { title: body.title.slice(0, MAX_QUEUED_TITLE) }
          : {}),
      }
      writeQueue(queue)
      return false
    })
  } catch (error) {
    console.warn('[dsh-session-delete] could not write queue:', error)
    return json(500, {
      kind: 'error',
      message: '无法写入删除队列；会话没有被隐藏。',
    })
  }

  try {
    // stopActivity: hidden immediately even when a turn/subagent/job/schedule
    // is running. The durable archive set is written before stops are asked,
    // so a stop-induced wake cannot resurrect the conversation.
    await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  } catch (error) {
    // A session that already vanished is still worth cleaning up.
    if (error?.name === 'WorkspaceUnknownSessionError') {
      return json(200, {
        kind: 'queued',
        sessionId,
        hidden: false,
        message: '会话已经不存在；清理已排队。',
      })
    }

    if (!alreadyQueued) {
      try {
        await dropQueuedSession(sessionId)
      } catch (cleanupError) {
        console.warn('[dsh-session-delete] could not roll back queue entry:', cleanupError)
      }
    }
    console.warn('[dsh-session-delete] could not hide session:', error)
    return json(500, {
      kind: 'error',
      message: '无法隐藏该会话；请稍后重试。',
    })
  }

  return json(200, {
    kind: 'queued',
    sessionId,
    hidden: true,
    message: '会话已隐藏，将在下次启动 DSH 时删除。',
  })
}

/**
 * Remove every queued session that can be resolved. Entries that cannot be
 * removed stay queued for the next start; deleting a live handle is not
 * attempted while DSH is running.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function purgeQueue(ctx) {
  const ids = Object.keys(readQueue().sessions)
  if (ids.length === 0) return

  // Entries written by this process were queued while the app is running.
  // They must stay untouched until a later process starts.
  const bootTime = Date.now() - process.uptime() * 1000
  let removedCount = 0
  let invalidCount = 0

  for (const sessionId of ids) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      try {
        await dropQueuedSession(sessionId)
        invalidCount++
      } catch (error) {
        console.warn(`[dsh-session-delete] could not drop invalid queue entry ${sessionId}:`, error)
      }
      continue
    }

    // Re-read under the lock so a request that queued this id after the first
    // snapshot is still respected.
    const entry = await withQueueLock(() => readQueue().sessions[sessionId])
    if (!entry) continue
    if (typeof entry.queuedAt === 'number' && entry.queuedAt >= bootTime) {
      continue
    }

    try {
      const removed = await purgeOne(ctx, sessionId)
      if (!removed) continue
      await dropQueuedSession(sessionId, entry.queuedAt)
      removedCount++
    } catch (error) {
      console.warn(`[dsh-session-delete] could not purge ${sessionId}:`, error)
    }
  }

  if (removedCount > 0 || invalidCount > 0) {
    const remaining = Object.keys(readQueue().sessions).length
    console.info(
      remaining === 0
        ? '[dsh-session-delete] pending queue drained.'
        : `[dsh-session-delete] ${remaining} session(s) remain queued.`,
    )
  }
}

/**
 * Delete one session directory and its projection cache entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @returns {Promise<boolean>} whether the durable artifacts were cleaned
 */
async function purgeOne(ctx, sessionId) {
  let snapshot
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId)
  } catch (error) {
    if (error?.name === 'SessionPersistenceNotFoundError' || error?.code === 'ENOENT') {
      snapshot = undefined
    } else {
      throw error
    }
  }

  const artifact = snapshot?.location?.path
  if (artifact) {
    const directory = dirname(artifact)
    const base = basename(directory)
    // Never remove a shared parent if a backend ever reports a flat path.
    if (base !== sessionId && base !== `session-${sessionId}`) {
      console.warn(
        `[dsh-session-delete] refusing unexpected artifact directory for ${sessionId}: ${directory}`,
      )
      return false
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }

  removeProjectionCache(sessionId)
  await forgetInWorkspaces(ctx, sessionId)
  return true
}

/**
 * Drop the removed session from workspace accounting and the archive set, so
 * no ghost row survives the next launch. Both operations are idempotent; a
 * workspace that fails to detach keeps an id that the missing-header filter
 * already hides.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 */
async function forgetInWorkspaces(ctx, sessionId) {
  try {
    for (const workspace of ctx.workspaceRegistry.list()) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        console.warn(`[dsh-session-delete] could not detach ${sessionId} from ${workspace.id}:`, error)
      }
    }
    await ctx.workspaceRegistry.unarchiveSession(sessionId)
  } catch (error) {
    console.warn(`[dsh-session-delete] could not forget workspace references for ${sessionId}:`, error)
  }
}

/**
 * Drop the derived projection cache entry. The index is disposable and
 * reconciles the removed source on its next use.
 * @param {string} sessionId
 */
function removeProjectionCache(sessionId) {
  const directory = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const candidates = new Set([`${sessionId}.json`])
  if (sessionId.startsWith('session-')) {
    candidates.add(`${sessionId.slice('session-'.length)}.json`)
  } else {
    candidates.add(`session-${sessionId}.json`)
  }
  for (const name of candidates) {
    try {
      rmSync(join(directory, name), { force: true })
    } catch (error) {
      console.warn(`[dsh-session-delete] could not remove projection cache ${name}:`, error)
    }
  }
}

/**
 * Resolve the DSH home the same way the app does: `$DSH_HOME` first, then
 * `~/.dsh`. The Desktop launcher exports `DSH_HOME` for custom data roots.
 * @returns {string}
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  return configured && configured.trim().length > 0
    ? resolve(configured)
    : join(homedir(), '.dsh')
}

function queueFile() {
  return join(dshHome(), 'session-delete', 'pending.json')
}

function emptyQueue() {
  return { version: QUEUE_VERSION, sessions: {} }
}

/**
 * @returns {{ version: number, sessions: Record<string, { queuedAt?: number, title?: string }> }}
 */
function readQueue() {
  const file = queueFile()
  if (!existsSync(file)) return emptyQueue()

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') {
      return emptyQueue()
    }
    const sessions = {}
    for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
      if (!SESSION_ID_PATTERN.test(sessionId)) continue
      sessions[sessionId] = entry && typeof entry === 'object' ? entry : {}
    }
    return { version: QUEUE_VERSION, sessions }
  } catch (error) {
    // Preserve an unreadable queue for inspection instead of overwriting it.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Nothing else to do; the next successful write recreates the file.
    }
    console.warn('[dsh-session-delete] could not read queue:', error)
    return emptyQueue()
  }
}

/**
 * @param {{ version: number, sessions: Record<string, unknown> }} queue
 */
function writeQueue(queue) {
  const file = queueFile()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
