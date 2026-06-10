'use strict'

const { describe, it } = require('node:test')
const assert    = require('node:assert/strict')
const Fastify   = require('fastify')
const multipart = require('@fastify/multipart')
const { createRoutes }         = require('../src/routes')
const { createSessionStore }   = require('../src/sessions')
const { createQueue }          = require('../src/queue')
const { createPersonaManager } = require('../src/personas')

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
    existsSync:    (p) => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
    mkdirSync:     ()  => {},
    writeFileSync: (p, d) => files.set(p, d),
    readFileSync:  (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p) },
    unlinkSync:    (p) => files.delete(p),
    readdirSync:   (p) => [...files.keys()].filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1)),
  }
}

// Persona filesystem: { personaName: { system?, options?, ... } }
function makePersonaFs(personas = {}) {
  const dir   = '/fake/personas'
  const files = new Map(
    Object.entries(personas).map(([name, data]) => [
      `${dir}/${name}.json`,
      JSON.stringify(data),
    ])
  )
  return {
    dir,
    fs: {
      existsSync:   (p) => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
      readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p) },
      readdirSync:  (p) => [...files.keys()].filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1)),
    },
  }
}

// ---------------------------------------------------------------------------
// App factory — fresh instance per test
// ---------------------------------------------------------------------------

let _uidSeq = 0

async function buildTestApp(ollamaOverride, personaOpts = {}) {
  const ollama       = ollamaOverride ?? makeOllama()
  const modelManager = makeModelManager()
  const queue        = createQueue({ concurrency: 1, maxSize: 20 })
  const sessionStore = createSessionStore({
    fs:     makeFakeFs(),
    uuidFn: () => `test-uid-${++_uidSeq}`,
    cacheDir: '/fake/sessions',
  })
  const { dir, fs: pFs } = makePersonaFs(personaOpts.personas ?? {})
  const personaManager   = createPersonaManager({ fs: pFs, personasDir: dir })
  const defaultPersona   = personaOpts.defaultPersona ?? ''

  const app = Fastify({ logger: false })
  app.register(multipart)
  app.register(createRoutes({
    ollamaClient: ollama, modelManager, sessionStore, queue, personaManager, defaultPersona,
  }))
  await app.ready()
  return { app, ollama, modelManager, sessionStore, personaManager }
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
      const fullQueue    = createQueue({ concurrency: 1, maxSize: 0 })
      const modelManager = makeModelManager()
      const sessionStore = createSessionStore({ fs: makeFakeFs(), cacheDir: '/fake' })
      const { dir, fs: pFs } = makePersonaFs({})
      const personaManager   = createPersonaManager({ fs: pFs, personasDir: dir })
      const app = Fastify({ logger: false })
      app.register(multipart)
      app.register(createRoutes({ ollamaClient: makeOllama(), modelManager, sessionStore, queue: fullQueue, personaManager }))
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

  describe('GET /personas', () => {
    it('lists available personas and default', async () => {
      const { app } = await buildTestApp(null, {
        personas:      { concise: { system: 'Be brief.' }, friendly: { system: 'Be warm.' } },
        defaultPersona: 'concise',
      })
      const res  = await app.inject({ method: 'GET', url: '/personas' })
      const body = JSON.parse(res.body)
      assert.equal(res.statusCode, 200)
      assert.ok(body.personas.includes('concise'))
      assert.ok(body.personas.includes('friendly'))
      assert.equal(body.default, 'concise')
      await app.close()
    })

    it('GET /status includes personas list', async () => {
      const { app } = await buildTestApp(null, {
        personas: { concise: { system: 'Be brief.' } },
      })
      const res  = await app.inject({ method: 'GET', url: '/status' })
      const body = JSON.parse(res.body)
      assert.ok(Array.isArray(body.personas))
      await app.close()
    })
  })

  describe('persona resolution', () => {
    it('POST /chat passes system prompt and options from named persona', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama, {
        personas: { concise: { system: 'Be brief.', options: { temperature: 0.3 } } },
      })
      await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', persona: 'concise' }),
      })
      assert.equal(ollama.calls[0].opts.system, 'Be brief.')
      assert.deepEqual(ollama.calls[0].opts.options, { temperature: 0.3 })
      await app.close()
    })

    it('POST /chat per-request options override persona options', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama, {
        personas: { concise: { system: 'Be brief.', options: { temperature: 0.3 } } },
      })
      await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', persona: 'concise', options: { temperature: 0.9 } }),
      })
      assert.deepEqual(ollama.calls[0].opts.options, { temperature: 0.9 })
      await app.close()
    })

    it('POST /chat applies default persona when none specified', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama, {
        personas:      { mydefault: { system: 'Default system.' } },
        defaultPersona: 'mydefault',
      })
      await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi' }),
      })
      assert.equal(ollama.calls[0].opts.system, 'Default system.')
      await app.close()
    })

    it('POST /chat returns 424 for unknown persona', async () => {
      const { app } = await buildTestApp()
      const res = await app.inject({
        method: 'POST', url: '/chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', persona: 'no-such-persona' }),
      })
      assert.equal(res.statusCode, 424)
      await app.close()
    })

    it('POST /context_chat uses persona system prompt', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama, {
        personas: { concise: { system: 'Be brief.' } },
      })
      await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hello', persona: 'concise' }),
      })
      assert.equal(ollama.calls[0].opts.system, 'Be brief.')
      await app.close()
    })

    it('POST /context_chat returns 424 for unknown persona', async () => {
      const { app } = await buildTestApp()
      const res = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hi', persona: 'ghost-persona' }),
      })
      assert.equal(res.statusCode, 424)
      await app.close()
    })

    it('POST /context_chat resumes with session persona when none re-specified', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama, {
        personas: { concise: { system: 'Be brief.' } },
      })

      const r1  = await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hello', persona: 'concise' }),
      })
      const { uid } = JSON.parse(r1.body)
      assert.equal(ollama.calls[0].opts.system, 'Be brief.')

      await app.inject({
        method: 'POST', url: '/context_chat',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Continue', uid }),
      })
      assert.equal(ollama.calls[1].opts.system, 'Be brief.')
      await app.close()
    })
  })

})
