'use strict'

/**
 * Session store factory.
 *
 * Accepts injected dependencies for filesystem access and clock so that
 * tests can run without touching disk or real time.
 *
 * @param {Object}   deps
 * @param {Object}   [deps.fs]        fs-compatible interface (readFileSync etc.)
 * @param {Function} [deps.now]       Returns current timestamp ms (default: Date.now)
 * @param {Function} [deps.uuidFn]    Returns a new unique ID string
 * @param {string}   [deps.cacheDir]  Directory for session JSON files
 * @param {number}   [deps.modelContextTokens]
 * @param {number}   [deps.summarizeThresholdPct]
 * @param {number}   [deps.keepRecentTurns]
 */

const nodefs          = require('fs')
const nodepath        = require('path')
const { randomUUID }  = require('crypto')

const CHARS_PER_TOKEN = 4

function createSessionStore({
  fs                    = nodefs,
  now                   = () => Date.now(),
  uuidFn                = randomUUID,
  cacheDir              = process.env.SESSION_CACHE_DIR
                          ? nodepath.resolve(process.env.SESSION_CACHE_DIR)
                          : nodepath.join(process.cwd(), 'sessions'),
  modelContextTokens    = parseInt(process.env.MODEL_CONTEXT_TOKENS         ?? '131072', 10),
  summarizeThresholdPct = parseInt(process.env.CONTEXT_SUMMARIZE_THRESHOLD  ?? '70',     10),
  keepRecentTurns       = parseInt(process.env.CONTEXT_SUMMARY_KEEP_RECENT  ?? '10',     10),
} = {}) {

  const summarizeThresholdTokens = Math.floor(modelContextTokens * summarizeThresholdPct / 100)

  // In-memory store: uid → session object
  const store = new Map()

  // -------------------------------------------------------------------------
  // Token estimation
  // -------------------------------------------------------------------------

  function estimateTokens(history) {
    return history.reduce((acc, turn) => acc + Math.ceil(turn.content.length / CHARS_PER_TOKEN), 0)
  }

  /**
   * Returns 0–100: percentage of the summarize threshold currently consumed.
   * Resets to a lower value after summarisation fires.
   */
  function contextUsagePct(history) {
    return Math.min(100, Math.round(estimateTokens(history) / summarizeThresholdTokens * 100))
  }

  // -------------------------------------------------------------------------
  // Disk helpers
  // -------------------------------------------------------------------------

  function ensureCacheDir() {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
  }

  function sessionPath(uid) {
    return nodepath.join(cacheDir, `${uid}.json`)
  }

  function writeToDisk(uid, session) {
    ensureCacheDir()
    fs.writeFileSync(sessionPath(uid), JSON.stringify(session, null, 2), 'utf8')
  }

  function readFromDisk(uid) {
    const file = sessionPath(uid)
    if (!fs.existsSync(file)) return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  function deleteFromDisk(uid) {
    const file = sessionPath(uid)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  // -------------------------------------------------------------------------
  // Summarisation
  // -------------------------------------------------------------------------

  function buildSummaryPrompt(turnsToSummarise, existingSummary) {
    const lines = turnsToSummarise.map(
      t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`
    )
    const transcript = lines.join('\n')

    if (existingSummary) {
      return (
        `You are summarising a conversation for context compression.\n` +
        `There is an existing summary of earlier exchanges:\n"${existingSummary}"\n\n` +
        `Now incorporate the following additional exchanges into an updated, concise summary.\n` +
        `Preserve all names, decisions, facts, and requirements. Be brief but complete.\n\n` +
        `New exchanges to incorporate:\n${transcript}\n\nUpdated summary:`
      )
    }

    return (
      `You are summarising a conversation for context compression.\n` +
      `Produce a concise summary of the following exchanges.\n` +
      `Preserve all names, decisions, facts, and requirements. Be brief but complete.\n\n` +
      `${transcript}\n\nSummary:`
    )
  }

  /**
   * Run tail summarisation on a history array.
   *
   * - role:'summary' turns are NEVER eligible for re-summarisation.
   * - The most recent `keepRecentTurns` raw turns are kept verbatim.
   * - Everything older is sent to the model and replaced by a single
   *   role:'summary' turn at the head of the history.
   *
   * @param {Array}    history  Current full history
   * @param {Function} chatFn   ollama.chat compatible function
   * @returns {Array}  New history
   */
  async function summarise(history, chatFn) {
    const existingSummary = history[0]?.role === 'summary' ? history[0] : null
    const rawTurns        = existingSummary ? history.slice(1) : history

    const keepFrom    = Math.max(0, rawTurns.length - keepRecentTurns)
    const toSummarise = rawTurns.slice(0, keepFrom)
    const toKeep      = rawTurns.slice(keepFrom)

    if (toSummarise.length === 0) return history

    const prompt      = buildSummaryPrompt(toSummarise, existingSummary?.content ?? null)
    const summaryText = await chatFn({ text: prompt, history: [] })

    return [{ role: 'summary', content: summaryText.trim() }, ...toKeep]
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function create(cached = true) {
    const uid     = uuidFn()
    const session = { uid, history: [], cached, createdAt: now(), updatedAt: now() }
    store.set(uid, session)
    if (cached) writeToDisk(uid, session)
    return { uid, session }
  }

  function resolve(uid) {
    if (store.has(uid)) return store.get(uid)
    const fromDisk = readFromDisk(uid)
    if (fromDisk) {
      store.set(uid, fromDisk)
      return fromDisk
    }
    return null
  }

  async function appendAndMaybeCompress(uid, userContent, assistantContent, chatFn) {
    const session = store.get(uid)
    if (!session) throw new Error(`Session ${uid} not in memory`)

    session.history.push({ role: 'user',      content: userContent      })
    session.history.push({ role: 'assistant', content: assistantContent })
    session.updatedAt = now()

    if (estimateTokens(session.history) >= summarizeThresholdTokens) {
      session.history   = await summarise(session.history, chatFn)
      session.updatedAt = now()
    }

    if (session.cached) writeToDisk(uid, session)

    return contextUsagePct(session.history)
  }

  function remove(uid) {
    const inMemory = store.has(uid)
    const onDisk   = fs.existsSync(sessionPath(uid))

    if (!inMemory && !onDisk) return false

    store.delete(uid)
    deleteFromDisk(uid)
    return true
  }

  function status(uid) {
    const session = resolve(uid)
    if (!session) return null
    return {
      uid,
      cached:       session.cached,
      turns:        session.history.filter(t => t.role !== 'summary').length,
      hasSummary:   session.history[0]?.role === 'summary',
      contextUsage: contextUsagePct(session.history),
      createdAt:    session.createdAt,
      updatedAt:    session.updatedAt,
    }
  }

  return {
    create,
    resolve,
    appendAndMaybeCompress,
    remove,
    status,
    // Exposed for testing
    estimateTokens,
    contextUsagePct,
  }
}

// Singleton for production use
const defaultStore = createSessionStore()

module.exports = { createSessionStore, ...defaultStore }
