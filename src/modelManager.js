'use strict'

/**
 * ModelManager
 *
 * Owns the model's lifecycle:
 *   - UNLOADED  → LOADING → READY → UNLOADING → UNLOADED
 *
 * On the first request it boots the model, resets an idle timer on every
 * request, and unloads the model when the idle TTL expires with no activity.
 *
 * The Ollama keep_alive parameter acts as a safety net inside Ollama itself;
 * the idle timer here lets us unload proactively and emit events so the rest
 * of the app can react (e.g. log, metric, refuse queued work).
 */

const EventEmitter = require('events')
const ollama       = require('./ollama')

const IDLE_TTL_MS = parseInt(process.env.IDLE_TTL_SECONDS ?? '360', 10) * 1000

const STATE = Object.freeze({
  UNLOADED:  'unloaded',
  LOADING:   'loading',
  READY:     'ready',
  UNLOADING: 'unloading',
})

class ModelManager extends EventEmitter {
  constructor() {
    super()
    this._state     = STATE.UNLOADED
    this._idleTimer = null
    this._loadPromise = null
  }

  get state() { return this._state }
  get isReady() { return this._state === STATE.READY }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  /**
   * Ensure the model is loaded. Returns a promise that resolves when READY.
   * Safe to call concurrently — multiple callers share the same load promise.
   */
  async ensureLoaded() {
    if (this._state === STATE.READY) {
      this._resetIdleTimer()
      return
    }

    if (this._state === STATE.LOADING) {
      return this._loadPromise
    }

    if (this._state === STATE.UNLOADING) {
      // Wait for unload to finish, then reload
      await new Promise(resolve => this.once('unloaded', resolve))
    }

    this._state       = STATE.LOADING
    this._loadPromise = this._doLoad()
    return this._loadPromise
  }

  /**
   * Touch the idle timer — call this after every successful request.
   */
  touch() {
    if (this._state === STATE.READY) this._resetIdleTimer()
  }

  /**
   * Manually unload the model (e.g. admin endpoint or graceful shutdown).
   */
  async forceUnload() {
    if (this._state === STATE.UNLOADED || this._state === STATE.UNLOADING) return
    this._clearIdleTimer()
    await this._doUnload()
  }

  /** Human-readable status snapshot */
  status() {
    return {
      state:          this._state,
      model:          process.env.OLLAMA_MODEL ?? 'gemma4:e4b',
      idleTtlSeconds: IDLE_TTL_MS / 1000,
      idleTimerActive: this._idleTimer !== null,
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  async _doLoad() {
    this.emit('loading')
    console.log('[ModelManager] loading model…')
    try {
      await ollama.loadModel()
      this._state = STATE.READY
      this._resetIdleTimer()
      this.emit('ready')
      console.log('[ModelManager] model ready')
    } catch (err) {
      this._state = STATE.UNLOADED
      this.emit('error', err)
      console.error('[ModelManager] load failed:', err.message)
      throw err
    } finally {
      this._loadPromise = null
    }
  }

  async _doUnload() {
    this._state = STATE.UNLOADING
    this.emit('unloading')
    console.log('[ModelManager] unloading model…')
    try {
      await ollama.unloadModel()
    } catch (err) {
      console.warn('[ModelManager] unload warning:', err.message)
      // Non-fatal — model will time out on Ollama side anyway
    }
    this._state = STATE.UNLOADED
    this.emit('unloaded')
    console.log('[ModelManager] model unloaded')
  }

  _resetIdleTimer() {
    this._clearIdleTimer()
    this._idleTimer = setTimeout(async () => {
      this._idleTimer = null
      console.log('[ModelManager] idle TTL expired, unloading…')
      await this._doUnload()
    }, IDLE_TTL_MS)
    // Don't prevent process exit
    if (this._idleTimer.unref) this._idleTimer.unref()
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }
}

// Singleton — one manager per process
module.exports = new ModelManager()
