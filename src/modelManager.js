'use strict'

/**
 * ModelManager class.
 *
 * Owns the model lifecycle: UNLOADED → LOADING → READY → UNLOADING → UNLOADED
 *
 * Dependencies are injected so tests can:
 *   - Supply a mock ollamaClient without network calls
 *   - Supply fake timer functions to control idle TTL without real waits
 *
 * The module exports a singleton instance for production use, and the class
 * itself for test instantiation.
 */

const EventEmitter = require('events')

const STATE = Object.freeze({
  UNLOADED:  'unloaded',
  LOADING:   'loading',
  READY:     'ready',
  UNLOADING: 'unloading',
})

class ModelManager extends EventEmitter {
  /**
   * @param {Object}   opts
   * @param {Object}   opts.ollamaClient        Must expose loadModel() and unloadModel()
   * @param {number}   [opts.idleTtlMs]         Idle timeout in milliseconds
   * @param {Function} [opts.setTimeoutFn]      Injected setTimeout (default: global)
   * @param {Function} [opts.clearTimeoutFn]    Injected clearTimeout (default: global)
   */
  constructor({
    ollamaClient,
    idleTtlMs      = parseInt(process.env.IDLE_TTL_SECONDS ?? '360', 10) * 1000,
    setTimeoutFn   = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    super()
    this._ollama        = ollamaClient
    this._idleTtlMs     = idleTtlMs
    this._setTimeout    = setTimeoutFn
    this._clearTimeout  = clearTimeoutFn
    this._state         = STATE.UNLOADED
    this._idleTimer     = null
    this._loadPromise   = null
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get state()   { return this._state }
  get isReady() { return this._state === STATE.READY }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  /**
   * Ensure the model is loaded. Safe to call concurrently — multiple callers
   * share the same load promise rather than triggering duplicate loads.
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
      await new Promise(resolve => this.once('unloaded', resolve))
    }

    this._state       = STATE.LOADING
    this._loadPromise = this._doLoad()
    return this._loadPromise
  }

  /** Reset the idle timer — call after every successful inference. */
  touch() {
    if (this._state === STATE.READY) this._resetIdleTimer()
  }

  /** Manually unload the model (admin endpoint or graceful shutdown). */
  async forceUnload() {
    if (this._state === STATE.UNLOADED || this._state === STATE.UNLOADING) return
    this._clearIdleTimer()
    await this._doUnload()
  }

  /** Lightweight status snapshot. */
  status() {
    return {
      state:           this._state,
      model:           process.env.OLLAMA_MODEL ?? 'gemma4:e4b',
      idleTtlSeconds:  this._idleTtlMs / 1000,
      idleTimerActive: this._idleTimer !== null,
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  async _doLoad() {
    this.emit('loading')
    try {
      await this._ollama.loadModel()
      this._state = STATE.READY
      this._resetIdleTimer()
      this.emit('ready')
    } catch (err) {
      this._state = STATE.UNLOADED
      this.emit('error', err)
      throw err
    } finally {
      this._loadPromise = null
    }
  }

  async _doUnload() {
    this._state = STATE.UNLOADING
    this.emit('unloading')
    try {
      await this._ollama.unloadModel()
    } catch (err) {
      // Non-fatal — Ollama will time out on its own
    }
    this._state = STATE.UNLOADED
    this.emit('unloaded')
  }

  _resetIdleTimer() {
    this._clearIdleTimer()
    this._idleTimer = this._setTimeout(async () => {
      this._idleTimer = null
      await this._doUnload()
    }, this._idleTtlMs)
    if (this._idleTimer?.unref) this._idleTimer.unref()
  }

  _clearIdleTimer() {
    if (this._idleTimer !== null) {
      this._clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton for production use
// ---------------------------------------------------------------------------

// Defer require to avoid circular dependency issues at module load time
let _defaultInstance = null
function getDefaultInstance() {
  if (!_defaultInstance) {
    const ollama = require('./ollama')
    _defaultInstance = new ModelManager({ ollamaClient: ollama })
  }
  return _defaultInstance
}

// Proxy object so callers can do `require('./modelManager').ensureLoaded()` etc.
module.exports = new Proxy({}, {
  get(_, prop) {
    if (prop === 'ModelManager') return ModelManager
    const instance = getDefaultInstance()
    const val = instance[prop]
    return typeof val === 'function' ? val.bind(instance) : val
  }
})

module.exports.ModelManager = ModelManager
