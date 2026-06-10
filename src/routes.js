'use strict'

/**
 * Route factory.
 *
 * All dependencies are injected so integration tests can supply mocks and
 * use Fastify's app.inject() without any real I/O.
 *
 * @param {Object} deps
 * @param {Object} deps.ollamaClient    { chat, chatStream }
 * @param {Object} deps.modelManager   { ensureLoaded, touch, forceUnload, status }
 * @param {Object} deps.sessionStore   { create, resolve, appendAndMaybeCompress, remove, status }
 * @param {Object} deps.queue          { enqueue, stats }
 * @param {number} [deps.maxUploadBytes]
 */

function createRoutes({
  ollamaClient,
  modelManager,
  sessionStore,
  queue,
  maxUploadBytes = parseInt(process.env.MAX_UPLOAD_BYTES ?? '52428800', 10),
}) {

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
      model: modelManager.status(),
      queue: queue.stats(),
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
          },
        },
      },
    }, async (req, reply) => {
      const { prompt, history } = req.body
      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, history })
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
          },
        },
      },
    }, async (req, reply) => {
      const { prompt, history } = req.body

      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')

      await run(async () => {
        for await (const token of ollamaClient.chatStream({ text: prompt, history })) {
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

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'image') {
          const chunks = []
          for await (const chunk of part.file) chunks.push(chunk)
          imageBuffer = Buffer.concat(chunks)
        } else if (part.type === 'field') {
          if (part.fieldname === 'prompt')  prompt  = part.value
          if (part.fieldname === 'history') {
            try { history = JSON.parse(part.value) } catch { /* ignore */ }
          }
        }
      }

      if (!imageBuffer) {
        return reply.status(400).send({ error: 'Missing image file (field: image)' })
      }

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, image: imageBuffer, history })
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

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'audio') {
          const chunks = []
          for await (const chunk of part.file) chunks.push(chunk)
          audioBuffer = Buffer.concat(chunks)
        } else if (part.type === 'field' && part.fieldname === 'prompt') {
          prompt = part.value
        }
      }

      if (!audioBuffer) {
        return reply.status(400).send({ error: 'Missing audio file (field: audio)' })
      }

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, audio: audioBuffer })
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
            prompt: { type: 'string', minLength: 1 },
            uid:    { type: 'string' },
            cache:  { type: 'boolean' },
          },
        },
      },
    }, async (req, reply) => {
      const { prompt, uid: incomingUid, cache = true } = req.body

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
        const created = sessionStore.create(cache)
        uid      = created.uid
        session  = created.session
        isNew    = true
        volatile = !cache
      }

      const replyText = await run(() =>
        ollamaClient.chat({ text: prompt, history: session.history })
      )

      const contextUsage = await sessionStore.appendAndMaybeCompress(
        uid, prompt, replyText, ollamaClient.chat.bind(ollamaClient)
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

  }

  return routes
}

module.exports = { createRoutes }
