'use strict'

/**
 * Route factory.
 *
 * All dependencies are injected so integration tests can supply mocks and
 * use Fastify's app.inject() without any real I/O.
 *
 * @param {Object} deps
 * @param {Object} deps.ollamaClient     { chat, chatStream }
 * @param {Object} deps.modelManager    { ensureLoaded, touch, forceUnload, status }
 * @param {Object} deps.sessionStore    { create, resolve, appendAndMaybeCompress, remove, status }
 * @param {Object} deps.queue           { enqueue, stats }
 * @param {Object} deps.personaManager  { load, list }
 * @param {string} [deps.defaultPersona]
 * @param {number} [deps.maxUploadBytes]
 */

function createRoutes({
  ollamaClient,
  modelManager,
  sessionStore,
  queue,
  personaManager,
  defaultPersona  = process.env.DEFAULT_PERSONA ?? '',
  maxUploadBytes  = parseInt(process.env.MAX_UPLOAD_BYTES ?? '52428800', 10),
}) {

  // -------------------------------------------------------------------------
  // Helper: resolve a persona name → { system?, options? }
  // Returns {} when no persona is requested and no default is set.
  // Throws {statusCode:424} when a named persona file is missing or invalid.
  // -------------------------------------------------------------------------

  function resolvePersona(requestedName) {
    const name = requestedName || defaultPersona || null
    if (!name) return {}
    return personaManager.load(name)
  }

  // -------------------------------------------------------------------------
  // Helper: run a task through the queue + model lifecycle
  // -------------------------------------------------------------------------

  async function run(task) {
    return queue.enqueue(async () => {
      await modelManager.ensureLoaded()
      const result = await task()
      modelManager.touch()
      return result
    })
  }

  // -------------------------------------------------------------------------
  // Plugin function registered with Fastify
  // -------------------------------------------------------------------------

  async function routes(app) {

    // ------------------------------------------------------------------
    // GET /status
    // ------------------------------------------------------------------
    app.get('/status', async () => ({
      model:    modelManager.status(),
      queue:    queue.stats(),
      personas: personaManager.list(),
    }))

    // ------------------------------------------------------------------
    // POST /unload
    // ------------------------------------------------------------------
    app.post('/unload', async (req, reply) => {
      await modelManager.forceUnload()
      reply.send({ ok: true, state: modelManager.state })
    })

    // ------------------------------------------------------------------
    // POST /chat
    // ------------------------------------------------------------------
    app.post('/chat', {
      schema: {
        body: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string', minLength: 1 },
            history: { type: 'array' },
            persona: { type: 'string' },
            options: { type: 'object' },
          },
        },
      },
    }, async (req, reply) => {
      const { prompt, history, persona: personaName, options: reqOptions } = req.body

      let personaData
      try {
        personaData = resolvePersona(personaName)
      } catch (err) {
        return reply.status(err.statusCode ?? 424).send({ error: err.message })
      }

      // Per-request options override persona options
      const options = reqOptions ?? personaData.options

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, history, system: personaData.system, options })
      )

      reply.send({ reply: reply_text })
    })

    // ------------------------------------------------------------------
    // POST /chat/stream
    // ------------------------------------------------------------------
    app.post('/chat/stream', {
      schema: {
        body: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string' },
            history: { type: 'array' },
            persona: { type: 'string' },
            options: { type: 'object' },
          },
        },
      },
    }, async (req, reply) => {
      const { prompt, history, persona: personaName, options: reqOptions } = req.body

      let personaData
      try {
        personaData = resolvePersona(personaName)
      } catch (err) {
        return reply.status(err.statusCode ?? 424).send({ error: err.message })
      }

      const options = reqOptions ?? personaData.options

      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')

      await run(async () => {
        for await (const token of ollamaClient.chatStream({
          text: prompt, history, system: personaData.system, options
        })) {
          reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`)
        }
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
      })
    })

    // ------------------------------------------------------------------
    // POST /imagine
    // ------------------------------------------------------------------
    app.post('/imagine', async (req, reply) => {
      const parts = req.parts({ limits: { fileSize: maxUploadBytes } })

      let imageBuffer = null
      let prompt      = 'Describe this image.'
      let history     = []
      let personaName = null
      let reqOptions  = null

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'image') {
          const chunks = []
          for await (const chunk of part.file) chunks.push(chunk)
          imageBuffer = Buffer.concat(chunks)
        } else if (part.type === 'field') {
          if (part.fieldname === 'prompt')  prompt      = part.value
          if (part.fieldname === 'persona') personaName = part.value
          if (part.fieldname === 'options') {
            try { reqOptions = JSON.parse(part.value) } catch { /* ignore */ }
          }
          if (part.fieldname === 'history') {
            try { history = JSON.parse(part.value) } catch { /* ignore */ }
          }
        }
      }

      if (!imageBuffer) {
        return reply.status(400).send({ error: 'Missing image file (field: image)' })
      }

      let personaData
      try {
        personaData = resolvePersona(personaName)
      } catch (err) {
        return reply.status(err.statusCode ?? 424).send({ error: err.message })
      }

      const options = reqOptions ?? personaData.options

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, image: imageBuffer, history, system: personaData.system, options })
      )
      reply.send({ reply: reply_text })
    })

    // ------------------------------------------------------------------
    // POST /transcribe
    // ------------------------------------------------------------------
    app.post('/transcribe', async (req, reply) => {
      const parts = req.parts({ limits: { fileSize: maxUploadBytes } })

      let audioBuffer = null
      let prompt      = 'Transcribe this audio accurately.'
      let personaName = null
      let reqOptions  = null

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'audio') {
          const chunks = []
          for await (const chunk of part.file) chunks.push(chunk)
          audioBuffer = Buffer.concat(chunks)
        } else if (part.type === 'field') {
          if (part.fieldname === 'prompt')  prompt      = part.value
          if (part.fieldname === 'persona') personaName = part.value
          if (part.fieldname === 'options') {
            try { reqOptions = JSON.parse(part.value) } catch { /* ignore */ }
          }
        }
      }

      if (!audioBuffer) {
        return reply.status(400).send({ error: 'Missing audio file (field: audio)' })
      }

      let personaData
      try {
        personaData = resolvePersona(personaName)
      } catch (err) {
        return reply.status(err.statusCode ?? 424).send({ error: err.message })
      }

      const options = reqOptions ?? personaData.options

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, audio: audioBuffer, system: personaData.system, options })
      )
      reply.send({ reply: reply_text })
    })

    // ------------------------------------------------------------------
    // POST /context_chat
    // ------------------------------------------------------------------
    app.post('/context_chat', {
      schema: {
        body: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt:  { type: 'string', minLength: 1 },
            uid:     { type: 'string' },
            cache:   { type: 'boolean' },
            persona: { type: 'string' },
            options: { type: 'object' },
          },
        },
      },
    }, async (req, reply) => {
      const { prompt, uid: incomingUid, cache = true, persona: personaName, options: reqOptions } = req.body

      // Resolve persona before touching session state
      let personaData
      try {
        personaData = resolvePersona(personaName)
      } catch (err) {
        return reply.status(err.statusCode ?? 424).send({ error: err.message })
      }

      let session, uid, isNew = false, volatile = false

      if (incomingUid) {
        session = sessionStore.resolve(incomingUid)
        if (!session) {
          return reply.status(404).send({
            error: `Session '${incomingUid}' not found in memory or on disk.`,
          })
        }
        uid      = incomingUid
        volatile = !session.cached
      } else {
        // Store persona name in session so it survives resume
        const created = sessionStore.create(cache, personaName || defaultPersona || null)
        uid      = created.uid
        session  = created.session
        isNew    = true
        volatile = !cache
      }

      // On resume, use the persona the session was created with, unless overridden
      const effectivePersonaName = personaName
        || (incomingUid ? session.personaName : null)
        || defaultPersona
        || null

      let effectivePersona = personaData
      if (incomingUid && !personaName && effectivePersonaName) {
        try {
          effectivePersona = personaManager.load(effectivePersonaName)
        } catch {
          effectivePersona = {}
        }
      }

      const options = reqOptions ?? effectivePersona.options

      const replyText = await run(() =>
        ollamaClient.chat({
          text:    prompt,
          history: session.history,
          system:  effectivePersona.system,
          options,
        })
      )

      const contextUsage = await sessionStore.appendAndMaybeCompress(
        uid, prompt, replyText, (opts) => ollamaClient.chat({ ...opts, system: effectivePersona.system })
      )

      const response = { uid, reply: replyText, context_usage: contextUsage }

      if (isNew && volatile) {
        response.notice = 'This is a volatile session — history is held in memory only and will be lost on server restart.'
      }

      reply.send(response)
    })

    // ------------------------------------------------------------------
    // DELETE /context_chat/:uid
    // ------------------------------------------------------------------
    app.delete('/context_chat/:uid', async (req, reply) => {
      const { uid } = req.params
      const deleted = sessionStore.remove(uid)
      if (!deleted) {
        return reply.status(404).send({ error: `Session '${uid}' not found.` })
      }
      reply.send({ ok: true, uid, deleted: true })
    })

    // ------------------------------------------------------------------
    // GET /context_chat/:uid
    // ------------------------------------------------------------------
    app.get('/context_chat/:uid', async (req, reply) => {
      const { uid } = req.params
      const snap = sessionStore.status(uid)
      if (!snap) {
        return reply.status(404).send({ error: `Session '${uid}' not found.` })
      }
      reply.send(snap)
    })

    // ------------------------------------------------------------------
    // GET /personas — list available personas
    // ------------------------------------------------------------------
    app.get('/personas', async () => ({
      personas: personaManager.list(),
      default:  defaultPersona || null,
    }))

  }

  return routes
}

module.exports = { createRoutes }
