'use strict'

const { describe, it } = require('node:test')
const assert    = require('node:assert/strict')
const Fastify   = require('fastify')
const multipart = require('@fastify/multipart')
const { createRoutes }       = require('../src/routes')
const { createSessionStore } = require('../src/sessions')
const { createQueue }        = require('../src/queue')

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeOllama(replyText = 'mock reply') {
  const calls = []
  const chat = async (opts) => { calls.push({ type: 'chat', opts }); return replyText }
  async function* chatStream(opts) { calls.push({ type: 'stream', opts }); yield 'tok1'; yield 'tok2' }
  return { chat, chatStream, calls }
}

function makeModelManager() {
  return {
    _state:       'ready',
    get state()   { return this._state },
    ensureLoaded: async function () { this._state = 'ready' },
    touch:        function () {},
    forceUnload:  async function () { this._state = 'unloaded' },
    status:       function () { return { state: this._state, idleTimerActive: false } },
  }
}

function makeFakeFs() {
  const files = new Map()
  return {
    existsSync:    (p) => files.has(p),
    mkdirSync:     ()  => {},
    writeFileSync: (p, d) => files.set(p, d),
    readFileSync:  (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p) },
    unlinkSync:    (p) => files.delete(p),
  }
}

// ---------------------------------------------------------------------------
// App factory — fresh instance per test
// ---------------------------------------------------------------------------

let _uidSeq = 0

async function buildTestApp(ollamaOverride) {
  const ollama       = ollamaOverride ?? makeOllama()
  const modelManager = makeModelManager()
  const queue        = createQueue({ concurrency: 1, maxSize: 20 })
  const sessionStore = createSessionStore({
    fs:     makeFakeFs(),
    uuidFn: () => `test-uid-${++_uidSeq}`,
    cacheDir: '/fake/sessions',
  })

  const app = Fastify({ logger: false })
  app.register(multipart)
  app.register(createRoutes({ ollamaClient: ollama, modelManager, sessionStore, queue }))
  await app.ready()
  return { app, ollama, modelManager, sessionStore }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routes', () => {

  describe('GET /status', () => {
    it('returns model and queue status', async () => {
      const { app } = await buildTestApp()
      const res  = await app.inject({ method: 'GET', url: '/status' })
      const body = JSON.parse(res.body)
      assert.equal(res.statusCode, 200)
      assert.ok(body.model)
      assert.ok(body.queue)
      await app.close()
    })
  })

  describe('POST /unload', () => {
    it('returns ok:true after unloading', async () => {
      const { app } = await buildTestApp()
      const res  = await app.inject({ method: 'POST', url: '/unload' })
      const body = JSON.parse(res.body)
      assert.equal(res.statusCode, 200)
      assert.equal(body.ok, true)
      await app.close()
    })
  })

  describe('POST /chat', () => {
    it('returns a reply for a valid prompt', async () => {
      const { app } = await buildTestApp()
      const res  = await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hello' }),
      })
      assert.equal(res.statusCode, 200)
      assert.equal(JSON.parse(res.body).reply, 'mock reply')
      await app.close()
    })

    it('passes history to ollamaClient.chat', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama)
      const history = [{ role: 'user', content: 'prev' }]
      await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Next', history }),
      })
      assert.deepEqual(ollama.calls[0].opts.history, history)
      await app.close()
    })

    it('returns 400 when prompt is missing', async () => {
      const { app } = await buildTestApp()
      const res = await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(res.statusCode, 400)
      await app.close()
    })

    it('returns 429 when queue is full', async () => {
      // maxSize:0 means every enqueue throws synchronously — no async work,
      // no event-loop leak, and the route must translate the throw to HTTP 429.
      const fullQueue    = createQueue({ concurrency: 1, maxSize: 0 })
      const modelManager = makeModelManager()
      const sessionStore = createSessionStore({ fs: makeFakeFs(), cacheDir: '/fake' })
      const app = Fastify({ logger: false })
      app.register(multipart)
      app.register(createRoutes({ ollamaClient: makeOllama(), modelManager, sessionStore, queue: fullQueue }))
      await app.ready()

      const res = await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'X' }),
      })
      assert.equal(res.statusCode, 429)
      await app.close()
    })
  })

  describe('POST /context_chat', () => {
    it('creates a new session and returns uid + reply + context_usage', async () => {
      const { app } = await buildTestApp()
      const res  = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi' }),
      })
      const body = JSON.parse(res.body)
      assert.equal(res.statusCode, 200)
      assert.ok(body.uid)
      assert.equal(body.reply, 'mock reply')
      assert.ok(typeof body.context_usage === 'number')
      await app.close()
    })

    it('includes volatile notice when cache=false', async () => {
      const { app } = await buildTestApp()
      const res  = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', cache: false }),
      })
      const body = JSON.parse(res.body)
      assert.ok(body.notice?.includes('volatile'))
      await app.close()
    })

    it('no volatile notice when cache=true', async () => {
      const { app } = await buildTestApp()
      const res  = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', cache: true }),
      })
      const body = JSON.parse(res.body)
      assert.equal(body.notice, undefined)
      await app.close()
    })

    it('resumes an existing session by uid', async () => {
      const { app } = await buildTestApp()
      const r1   = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'First' }),
      })
      const { uid } = JSON.parse(r1.body)

      const r2 = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Second', uid }),
      })
      assert.equal(r2.statusCode, 200)
      assert.equal(JSON.parse(r2.body).uid, uid)
      await app.close()
    })

    it('returns 404 for unknown uid', async () => {
      const { app } = await buildTestApp()
      const res = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', uid: 'no-such-session' }),
      })
      assert.equal(res.statusCode, 404)
      await app.close()
    })
  })

  describe('DELETE /context_chat/:uid', () => {
    it('deletes a known session and returns deleted:true', async () => {
      const { app } = await buildTestApp()
      const r1  = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi' }),
      })
      const { uid } = JSON.parse(r1.body)

      const res = await app.inject({ method: 'DELETE', url: `/context_chat/${uid}` })
      assert.equal(res.statusCode, 200)
      assert.equal(JSON.parse(res.body).deleted, true)
      await app.close()
    })

    it('returns 404 for unknown uid', async () => {
      const { app } = await buildTestApp()
      const res = await app.inject({ method: 'DELETE', url: '/context_chat/ghost' })
      assert.equal(res.statusCode, 404)
      await app.close()
    })
  })

  describe('GET /context_chat/:uid', () => {
    it('returns session status for known uid', async () => {
      const { app } = await buildTestApp()
      const r1  = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi' }),
      })
      const { uid } = JSON.parse(r1.body)

      const res  = await app.inject({ method: 'GET', url: `/context_chat/${uid}` })
      const body = JSON.parse(res.body)
      assert.equal(res.statusCode, 200)
      assert.equal(body.uid, uid)
      await app.close()
    })

    it('returns 404 for unknown uid', async () => {
      const { app } = await buildTestApp()
      const res = await app.inject({ method: 'GET', url: '/context_chat/ghost' })
      assert.equal(res.statusCode, 404)
      await app.close()
    })
  })

})
