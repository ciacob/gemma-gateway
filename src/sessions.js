'use strict'

/**
 * Session store factory.
 *
 * Each session tracks:
 *   - history      {Array}   Conversation turns
 *   - cached       {boolean} Whether persisted to disk
 *   - personaName  {string|null}
 *   - images       {Array}   Verbalized images: [{ name, description }]
 *   - imageMode    {string}  'on' | 'off'  — controls image-awareness injection
 */

const nodefs         = require('fs')
const nodepath       = require('path')
const { randomUUID } = require('crypto')

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
  const store = new Map()

  // -------------------------------------------------------------------------
  // Token estimation
  // -------------------------------------------------------------------------

  function estimateTokens(history) {
    return history.reduce((acc, turn) => acc + Math.ceil(turn.content.length / CHARS_PER_TOKEN), 0)
  }

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
    const lines      = turnsToSummarise.map(t =>
      `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`
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
  // Image-awareness system prompt fragment
  // -------------------------------------------------------------------------

  /**
   * Build the injected fragment that makes the model aware of verbalized images.
   * Returns null when imageMode is 'off' or no images exist.
   */
  function buildImageFragment(session) {
    if (session.imageMode === 'off') return null
    if (!session.images || session.images.length === 0) return null

    const list = session.images.map(img => `  - ${img.name}`).join('\n')

    return (
      `This conversation includes verbalized descriptions of the following image(s):\n` +
      `${list}\n` +
      `Their descriptions are available in the conversation history.\n` +
      `If the user refers to an image but has not attached one to their current message, ` +
      `acknowledge that you have the description and can work from it, but gently let them know ` +
      `they can re-upload the image if they need you to examine it directly. ` +
      `Do not repeatedly suggest re-uploading if the user seems satisfied working from the description.`
    )
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function create(cached = true, personaName = null) {
    const uid     = uuidFn()
    const session = {
      uid,
      history:     [],
      cached,
      personaName,
      images:      [],
      imageMode:   'on',
      createdAt:   now(),
      updatedAt:   now(),
    }
    store.set(uid, session)
    if (cached) writeToDisk(uid, session)
    return { uid, session }
  }

  function resolve(uid) {
    if (store.has(uid)) return store.get(uid)
    const fromDisk = readFromDisk(uid)
    if (fromDisk) {
      // Hydrate with defaults for fields added after initial creation
      if (!fromDisk.images)    fromDisk.images    = []
      if (!fromDisk.imageMode) fromDisk.imageMode = 'on'
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

  /**
   * Register a verbalized image in the session.
   * Automatically sets imageMode to 'on'.
   *
   * @param {string} uid
   * @param {string} name         Original filename
   * @param {string} description  Model-generated verbal description
   */
  function addImage(uid, name, description) {
    const session = store.get(uid)
    if (!session) throw new Error(`Session ${uid} not in memory`)

    // Replace if same filename uploaded again
    const existing = session.images.findIndex(img => img.name === name)
    if (existing >= 0) {
      session.images[existing] = { name, description }
    } else {
      session.images.push({ name, description })
    }

    session.imageMode = 'on'
    session.updatedAt = now()

    if (session.cached) writeToDisk(uid, session)
  }

  /**
   * Set imageMode for a session ('on' or 'off').
   * Automatically turns 'on' whenever an image is added via addImage().
   */
  function setImageMode(uid, mode) {
    const session = store.get(uid)
    if (!session) throw new Error(`Session ${uid} not in memory`)
    if (mode !== 'on' && mode !== 'off') throw new Error(`imageMode must be 'on' or 'off'`)

    session.imageMode = mode
    session.updatedAt = now()

    if (session.cached) writeToDisk(uid, session)
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
      images:       (session.images ?? []).map(img => img.name),
      imageMode:    session.imageMode ?? 'on',
      createdAt:    session.createdAt,
      updatedAt:    session.updatedAt,
    }
  }

  return {
    create,
    resolve,
    appendAndMaybeCompress,
    addImage,
    setImageMode,
    remove,
    status,
    buildImageFragment,
    // Exposed for testing
    estimateTokens,
    contextUsagePct,
  }
}

// Singleton for production use
const defaultStore = createSessionStore()

module.exports = { createSessionStore, ...defaultStore }
