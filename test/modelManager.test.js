'use strict'

const { describe, it, mock } = require('node:test')
const assert = require('node:assert/strict')
const { ModelManager } = require('../src/modelManager')

// ---------------------------------------------------------------------------
// Fake timer — controllable without real waits
// ---------------------------------------------------------------------------

function makeFakeTimers() {
  const timers = new Map()
  let id = 0

  function setTimeout(fn, ms) {
    const timerId = ++id
    timers.set(timerId, fn)
    return timerId
  }

  function clearTimeout(timerId) {
    timers.delete(timerId)
  }

  function fire(timerId) {
    const fn = timers.get(timerId)
    if (fn) {
      timers.delete(timerId)
      return fn()
    }
  }

  function fireAll() {
    const ids = [...timers.keys()]
    return Promise.all(ids.map(fire))
  }

  function pendingCount() { return timers.size }

  return { setTimeout, clearTimeout, fire, fireAll, pendingCount }
}

// ---------------------------------------------------------------------------
// Fake Ollama client
// ---------------------------------------------------------------------------

function makeOllama({ failLoad = false, failUnload = false } = {}) {
  const calls = { load: 0, unload: 0 }
  return {
    calls,
    loadModel:   async () => { calls.load++;   if (failLoad)   throw new Error('load failed')   },
    unloadModel: async () => { calls.unload++; if (failUnload) throw new Error('unload failed') },
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeManager(ollamaOpts = {}, timerOverrides = {}) {
  const ollama = makeOllama(ollamaOpts)
  const timers = makeFakeTimers()
  const mgr    = new ModelManager({
    ollamaClient:    ollama,
    idleTtlMs:       5000,
    setTimeoutFn:    timerOverrides.setTimeout   ?? timers.setTimeout,
    clearTimeoutFn:  timerOverrides.clearTimeout ?? timers.clearTimeout,
  })
  return { mgr, ollama, timers }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelManager', () => {

  describe('initial state', () => {
    it('starts in UNLOADED state', () => {
      const { mgr } = makeManager()
      assert.equal(mgr.state, 'unloaded')
      assert.equal(mgr.isReady, false)
    })
  })

  describe('ensureLoaded', () => {
    it('transitions to READY after loading', async () => {
      const { mgr } = makeManager()
      await mgr.ensureLoaded()
      assert.equal(mgr.state, 'ready')
      assert.equal(mgr.isReady, true)
    })

    it('calls ollama.loadModel() exactly once', async () => {
      const { mgr, ollama } = makeManager()
      await mgr.ensureLoaded()
      assert.equal(ollama.calls.load, 1)
    })

    it('concurrent calls share the same load promise (loadModel called once)', async () => {
      const { mgr, ollama } = makeManager()
      await Promise.all([mgr.ensureLoaded(), mgr.ensureLoaded(), mgr.ensureLoaded()])
      assert.equal(ollama.calls.load, 1)
    })

    it('is a no-op when already READY', async () => {
      const { mgr, ollama } = makeManager()
      await mgr.ensureLoaded()
      await mgr.ensureLoaded()
      assert.equal(ollama.calls.load, 1)
    })

    it('emits "ready" event on successful load', async () => {
      const { mgr } = makeManager()
      let fired = false
      mgr.on('ready', () => { fired = true })
      await mgr.ensureLoaded()
      assert.equal(fired, true)
    })

    it('returns to UNLOADED and emits "error" when loadModel fails', async () => {
      const { mgr } = makeManager({ failLoad: true })
      let emittedErr = null
      mgr.on('error', e => { emittedErr = e })
      await assert.rejects(() => mgr.ensureLoaded(), /load failed/)
      assert.equal(mgr.state, 'unloaded')
      assert.ok(emittedErr)
    })
  })

  describe('forceUnload', () => {
    it('transitions from READY to UNLOADED', async () => {
      const { mgr } = makeManager()
      await mgr.ensureLoaded()
      await mgr.forceUnload()
      assert.equal(mgr.state, 'unloaded')
    })

    it('calls ollama.unloadModel()', async () => {
      const { mgr, ollama } = makeManager()
      await mgr.ensureLoaded()
      await mgr.forceUnload()
      assert.equal(ollama.calls.unload, 1)
    })

    it('is a no-op when already UNLOADED', async () => {
      const { mgr, ollama } = makeManager()
      await mgr.forceUnload()
      assert.equal(ollama.calls.unload, 0)
    })

    it('clears the idle timer', async () => {
      const { mgr, timers } = makeManager()
      await mgr.ensureLoaded()
      assert.equal(timers.pendingCount(), 1)
      await mgr.forceUnload()
      assert.equal(timers.pendingCount(), 0)
    })

    it('does not throw when unloadModel fails (non-fatal)', async () => {
      const { mgr } = makeManager({ failUnload: true })
      await mgr.ensureLoaded()
      await assert.doesNotReject(() => mgr.forceUnload())
      assert.equal(mgr.state, 'unloaded')
    })
  })

  describe('idle TTL timer', () => {
    it('starts an idle timer after loading', async () => {
      const { mgr, timers } = makeManager()
      await mgr.ensureLoaded()
      assert.equal(timers.pendingCount(), 1)
    })

    it('fires idle timer → model unloads', async () => {
      const { mgr, timers } = makeManager()
      await mgr.ensureLoaded()
      await timers.fireAll()
      assert.equal(mgr.state, 'unloaded')
    })

    it('touch() resets the idle timer', async () => {
      const { mgr, timers } = makeManager()
      await mgr.ensureLoaded()
      const firstTimerId = [...timers.pendingCount.toString()] // just to have a reference

      mgr.touch()
      // After touch there should still be exactly one pending timer
      assert.equal(timers.pendingCount(), 1)
    })

    it('touch() is a no-op when not READY', () => {
      const { mgr, timers } = makeManager()
      mgr.touch()
      assert.equal(timers.pendingCount(), 0)
    })

    it('status() reflects idleTimerActive correctly', async () => {
      const { mgr } = makeManager()
      assert.equal(mgr.status().idleTimerActive, false)
      await mgr.ensureLoaded()
      assert.equal(mgr.status().idleTimerActive, true)
      await mgr.forceUnload()
      assert.equal(mgr.status().idleTimerActive, false)
    })
  })

  describe('reload after unload', () => {
    it('can load again after idle timer fires', async () => {
      const { mgr, timers, ollama } = makeManager()
      await mgr.ensureLoaded()
      await timers.fireAll()
      assert.equal(mgr.state, 'unloaded')

      await mgr.ensureLoaded()
      assert.equal(mgr.state, 'ready')
      assert.equal(ollama.calls.load, 2)
    })

    it('can load again after forceUnload', async () => {
      const { mgr, ollama } = makeManager()
      await mgr.ensureLoaded()
      await mgr.forceUnload()
      await mgr.ensureLoaded()
      assert.equal(mgr.state, 'ready')
      assert.equal(ollama.calls.load, 2)
    })
  })

})
