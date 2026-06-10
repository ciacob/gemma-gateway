'use strict'

/**
 * SessionStore
 *
 * Manages context_chat sessions: creation, resumption, persistence, and
 * history compression via tail summarisation.
 *
 * History shape (array of turns):
 *   { role: 'user' | 'assistant', content: string }
 *   { role: 'summary',            content: string }   ← at most one, always first
 *
 * Invariant: a turn with role === 'summary' is NEVER re-summarised.
 * Only raw user/assistant turns outside the "keep recent" window are eligible.
 */

const fs   = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CACHE_DIR = process.env.SESSION_CACHE_DIR
  ? path.resolve(process.env.SESSION_CACHE_DIR)
  : path.join(process.cwd(), 'sessions')

// Model context window in tokens (gemma4:e4b = 128K)
const MODEL_CONTEXT_TOKENS = parseInt(process.env.MODEL_CONTEXT_TOKENS ?? '131072', 10)

// Summarise when estimated token usage of history crosses this % of context window
const SUMMARIZE_THRESHOLD_PCT = parseInt(process.env.CONTEXT_SUMMARIZE_THRESHOLD ?? '70', 10)
const SUMMARIZE_THRESHOLD_TOKENS = Math.floor(MODEL_CONTEXT_TOKENS * SUMMARIZE_THRESHOLD_PCT / 100)

// How many recent raw turns to keep verbatim (not eligible for summarisation)
const KEEP_RECENT_TURNS = parseInt(process.env.CONTEXT_SUMMARY_KEEP_RECENT ?? '10', 10)

// Characters-per-token estimate for Gemma family
const CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// In-memory store:  uid → { history, cached, createdAt, updatedAt }
// ---------------------------------------------------------------------------

const store = new Map()

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(history) {
  return history.reduce((acc, turn) => acc + Math.ceil(turn.content.length / CHARS_PER_TOKEN), 0)
}

/**
 * Returns a 0–100 percentage of SUMMARIZE_THRESHOLD_TOKENS consumed.
 * Capped at 100 — summarisation should have fired before it ever exceeds that.
 */
function contextUsagePct(history) {
  const tokens = estimateTokens(history)
  return Math.min(100, Math.round(tokens / SUMMARIZE_THRESHOLD_TOKENS * 100))
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
}

function sessionPath(uid) {
  return path.join(CACHE_DIR, `${uid}.json`)
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

// ---------------------------------------------------------------------------
// Summarisation
// ---------------------------------------------------------------------------

/**
 * Build a summarisation prompt from the eligible turns.
 * Called inline — result is awaited before the user's actual request proceeds.
 */
function buildSummaryPrompt(turnsToSummarise, existingSummary) {
  const lines = turnsToSummarise.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
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
 * - Splits into: existing summary turn (if any) + eligible tail + recent kept turns
 * - Sends eligible turns to the model for summarisation
 * - Returns the new compressed history
 *
 * @param {Array}    history  Current full history
 * @param {Function} chatFn   ollama.chat — injected to avoid circular require
 * @returns {Array}  New history with at most one summary turn at head
 */
async function summarise(history, chatFn) {
  // Separate existing summary from raw turns
  const existingSummary = history[0]?.role === 'summary' ? history[0] : null
  const rawTurns        = existingSummary ? history.slice(1) : history

  // Keep the most recent N raw turns verbatim
  const keepFrom     = Math.max(0, rawTurns.length - KEEP_RECENT_TURNS)
  const toSummarise  = rawTurns.slice(0, keepFrom)
  const toKeep       = rawTurns.slice(keepFrom)

  // Nothing eligible to summarise (history is shorter than KEEP_RECENT_TURNS)
  if (toSummarise.length === 0) return history

  const prompt = buildSummaryPrompt(toSummarise, existingSummary?.content ?? null)

  const summaryText = await chatFn({ text: prompt, history: [] })

  const summaryTurn = {
    role:    'summary',
    content: summaryText.trim(),
  }

  return [summaryTurn, ...toKeep]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session.
 * @param {boolean} cached  Whether to persist to disk (default true)
 * @returns {{ uid, session }}
 */
function create(cached = true) {
  const uid     = randomUUID()
  const session = { uid, history: [], cached, createdAt: Date.now(), updatedAt: Date.now() }
  store.set(uid, session)
  if (cached) writeToDisk(uid, session)
  return { uid, session }
}

/**
 * Resolve a session by uid.
 * - Checks memory first, then disk.
 * - Returns null if not found anywhere.
 */
function resolve(uid) {
  if (store.has(uid)) return store.get(uid)

  const fromDisk = readFromDisk(uid)
  if (fromDisk) {
    store.set(uid, fromDisk)   // hydrate into memory
    return fromDisk
  }

  return null
}

/**
 * Append a user prompt + assistant reply to a session's history.
 * Runs summarisation inline if the threshold is crossed.
 * Returns updated context_usage percentage.
 *
 * @param {string}   uid
 * @param {string}   userContent
 * @param {string}   assistantContent
 * @param {Function} chatFn   ollama.chat
 * @returns {number} context_usage (0–100)
 */
async function appendAndMaybeCompress(uid, userContent, assistantContent, chatFn) {
  const session = store.get(uid)
  if (!session) throw new Error(`Session ${uid} not in memory`)

  // Append the new exchange
  session.history.push({ role: 'user',      content: userContent      })
  session.history.push({ role: 'assistant', content: assistantContent })
  session.updatedAt = Date.now()

  // Check if we need to summarise
  if (estimateTokens(session.history) >= SUMMARIZE_THRESHOLD_TOKENS) {
    session.history = await summarise(session.history, chatFn)
    session.updatedAt = Date.now()
  }

  // Persist if cached
  if (session.cached) writeToDisk(uid, session)

  return contextUsagePct(session.history)
}

/**
 * Delete a session from memory and disk.
 * Returns true if something was actually deleted, false if uid was unknown.
 */
function remove(uid) {
  const inMemory = store.has(uid)
  const onDisk   = fs.existsSync(sessionPath(uid))

  if (!inMemory && !onDisk) return false

  store.delete(uid)
  deleteFromDisk(uid)
  return true
}

/**
 * Return a lightweight status snapshot for a session (no history content).
 */
function status(uid) {
  const session = resolve(uid)
  if (!session) return null
  return {
    uid,
    cached:        session.cached,
    turns:         session.history.filter(t => t.role !== 'summary').length,
    hasSummary:    session.history[0]?.role === 'summary',
    contextUsage:  contextUsagePct(session.history),
    createdAt:     session.createdAt,
    updatedAt:     session.updatedAt,
  }
}

module.exports = {
  create,
  resolve,
  appendAndMaybeCompress,
  remove,
  status,
  // Exposed for testing / curiosity
  estimateTokens,
  contextUsagePct,
}
