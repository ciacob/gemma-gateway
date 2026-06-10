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
      const { body: _b1, contentType: _ct1 } = buildMultipart({ prompt: 'Hi' })
      const res  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _ct1 }, body: _b1 })
      const body = JSON.parse(res.body)
      assert.equal(res.statusCode, 200)
      assert.ok(body.uid)
      assert.equal(body.reply, 'mock reply')
      assert.ok(typeof body.context_usage === 'number')
      await app.close()
    })

    it('includes volatile notice when cache=false', async () => {
      const { app } = await buildTestApp()
      const { body: _b2, contentType: _ct2 } = buildMultipart({ prompt: 'Hi', cache: 'false' })
      const res  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _ct2 }, body: _b2 })
      const body = JSON.parse(res.body)
      assert.ok(body.notice?.includes('volatile'))
      await app.close()
    })

    it('no volatile notice when cache=true', async () => {
      const { app } = await buildTestApp()
      const { body: _b3, contentType: _ct3 } = buildMultipart({ prompt: 'Hi', cache: 'true' })
      const res  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _ct3 }, body: _b3 })
      const body = JSON.parse(res.body)
      assert.equal(body.notice, undefined)
      await app.close()
    })

    it('resumes an existing session by uid', async () => {
      const { app } = await buildTestApp()
      const { body: _rb1, contentType: _rct1 } = buildMultipart({ prompt: 'First' })
      const r1   = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _rct1 }, body: _rb1 })
      const { uid } = JSON.parse(r1.body)

      const { body: _rb2, contentType: _rct2 } = buildMultipart({ prompt: 'Second', uid })
      const r2 = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _rct2 }, body: _rb2 })
      assert.equal(r2.statusCode, 200)
      assert.equal(JSON.parse(r2.body).uid, uid)
      await app.close()
    })

    it('returns 404 for unknown uid', async () => {
      const { app } = await buildTestApp()
      const { body: _404b, contentType: _404ct } = buildMultipart({ prompt: 'Hi', uid: 'no-such-session' })
      const res = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _404ct }, body: _404b })
      assert.equal(res.statusCode, 404)
      await app.close()
    })
  })

  describe('DELETE /context_chat/:uid', () => {
    it('deletes a known session and returns deleted:true', async () => {
      const { app } = await buildTestApp()
      const { body: _db1, contentType: _dct1 } = buildMultipart({ prompt: 'Hi' })
      const r1  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _dct1 }, body: _db1 })
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
      const { body: _gb1, contentType: _gct1 } = buildMultipart({ prompt: 'Hi' })
      const r1  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _gct1 }, body: _gb1 })
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
      const { body: _pb1, contentType: _pct1 } = buildMultipart({ prompt: 'Hello', persona: 'concise' })
      await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _pct1 }, body: _pb1 })
      assert.equal(ollama.calls[0].opts.system, 'Be brief.')
      await app.close()
    })

    it('POST /context_chat returns 424 for unknown persona', async () => {
      const { app } = await buildTestApp()
      const { body: _424b, contentType: _424ct } = buildMultipart({ prompt: 'Hi', persona: 'ghost-persona' })
      const res = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _424ct }, body: _424b })
      assert.equal(res.statusCode, 424)
      await app.close()
    })

    it('POST /context_chat resumes with session persona when none re-specified', async () => {
      const ollama = makeOllama()
      const { app } = await buildTestApp(ollama, {
        personas: { concise: { system: 'Be brief.' } },
      })

      const { body: _pr1b, contentType: _pr1ct } = buildMultipart({ prompt: 'Hello', persona: 'concise' })
      const r1  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _pr1ct }, body: _pr1b })
      const { uid } = JSON.parse(r1.body)
      assert.equal(ollama.calls[0].opts.system, 'Be brief.')

      const { body: _pr2b, contentType: _pr2ct } = buildMultipart({ prompt: 'Continue', uid })
      await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': _pr2ct }, body: _pr2b })
      assert.equal(ollama.calls[1].opts.system, 'Be brief.')
      await app.close()
    })
  })

})

// ---------------------------------------------------------------------------
// Multipart form builder — used by image context_chat tests
// ---------------------------------------------------------------------------

function buildMultipart(fields, file = null) {
  const boundary = '----TestBoundary123'
  const CRLF     = '\r\n'
  const parts    = []

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${name}"${CRLF}` +
      `${CRLF}` +
      `${value}`
    )
  }

  if (file) {
    const ct = file.contentType ?? 'image/jpeg'
    parts.push(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"${CRLF}` +
      `Content-Type: ${ct}${CRLF}` +
      `${CRLF}` +
      `${file.data}`
    )
  }

  const body = parts.join(CRLF) + `${CRLF}--${boundary}--`
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

// ---------------------------------------------------------------------------
// Image context chat tests
// ---------------------------------------------------------------------------

describe('image context chat (POST /context_chat with image)', () => {

  // Deterministic multi-call ollama mock
  function makeMultiOllama(replies) {
    let i = 0
    return {
      chat: async () => replies[i++] ?? 'fallback reply',
      chatStream: async function* () {},
      calls: [],
    }
  }

  it('verbalizes uploaded image and returns verbalized field', async () => {
    const ollama = makeMultiOllama(['A sunny beach with palm trees.', 'mock reply'])
    const { app } = await buildTestApp(ollama)

    const { body, contentType } = buildMultipart(
      { prompt: 'What do you see?' },
      { fieldname: 'image', filename: 'beach.jpg', data: 'fake-image-data' }
    )

    const res  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': contentType }, body })
    const json = JSON.parse(res.body)
    assert.equal(res.statusCode, 200)
    assert.equal(json.verbalized, 'beach.jpg')
    assert.ok(json.uid)
    await app.close()
  })

  it('image_context in response includes mode and image name', async () => {
    const ollama = makeMultiOllama(['A description.', 'reply'])
    const { app } = await buildTestApp(ollama)

    const { body, contentType } = buildMultipart(
      { prompt: 'Describe it' },
      { fieldname: 'image', filename: 'photo.png', data: 'fake' }
    )

    const res  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': contentType }, body })
    const json = JSON.parse(res.body)
    assert.ok(json.image_context)
    assert.equal(json.image_context.mode, 'on')
    assert.ok(json.image_context.images.includes('photo.png'))
    await app.close()
  })

  it('subsequent text-only turn carries image_context', async () => {
    const ollama = makeMultiOllama(['A description.', 'text reply', 'follow-up reply'])
    const { app } = await buildTestApp(ollama)

    const { body: b1, contentType: ct1 } = buildMultipart(
      { prompt: 'Describe' },
      { fieldname: 'image', filename: 'photo.jpg', data: 'fake' }
    )
    const r1  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': ct1 }, body: b1 })
    const uid = JSON.parse(r1.body).uid

    const { body: b2, contentType: ct2 } = buildMultipart({ prompt: 'What colour is it?', uid })
    const r2   = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': ct2 }, body: b2 })
    const json = JSON.parse(r2.body)
    assert.ok(json.image_context)
    assert.equal(json.image_context.mode, 'on')
    await app.close()
  })

  it('image_context absent when no images in session', async () => {
    const { app } = await buildTestApp()
    const { body, contentType } = buildMultipart({ prompt: 'Hello' })
    const res  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': contentType }, body })
    const json = JSON.parse(res.body)
    assert.equal(json.image_context, undefined)
    await app.close()
  })

  it('image_mode off changes mode in response', async () => {
    const ollama = makeMultiOllama(['A description.', 'reply', 'follow-up'])
    const { app } = await buildTestApp(ollama)

    const { body: b1, contentType: ct1 } = buildMultipart(
      { prompt: 'Describe' },
      { fieldname: 'image', filename: 'photo.jpg', data: 'fake' }
    )
    const r1  = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': ct1 }, body: b1 })
    const uid = JSON.parse(r1.body).uid

    const { body: b2, contentType: ct2 } = buildMultipart({ prompt: 'Never mind images', uid, image_mode: 'off' })
    const r2   = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': ct2 }, body: b2 })
    const json = JSON.parse(r2.body)
    assert.equal(json.image_context.mode, 'off')
    await app.close()
  })

  it('re-uploading same filename replaces the image entry', async () => {
    let callCount = 0
    const ollama = {
      chat: async (opts) => { callCount++; return opts.image ? `Desc ${callCount}` : 'reply' },
      chatStream: async function* () {},
      calls: [],
    }
    const { app, sessionStore } = await buildTestApp(ollama)

    const upload = async (prompt, uid) => {
      const fields = uid ? { prompt, uid } : { prompt }
      const { body, contentType } = buildMultipart(
        fields,
        { fieldname: 'image', filename: 'photo.jpg', data: 'fake' }
      )
      return app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': contentType }, body })
    }

    const r1  = await upload('First upload')
    const uid = JSON.parse(r1.body).uid
    await upload('Re-upload', uid)

    const session = sessionStore.resolve(uid)
    assert.equal(session.images.length, 1)   // replaced, not duplicated
    await app.close()
  })

  it('returns 400 when prompt field is missing', async () => {
    const { app } = await buildTestApp()
    const { body, contentType } = buildMultipart({ uid: 'some-uid' })  // no prompt
    const res = await app.inject({ method: 'POST', url: '/context_chat', headers: { 'content-type': contentType }, body })
    assert.equal(res.statusCode, 400)
    await app.close()
  })

})
