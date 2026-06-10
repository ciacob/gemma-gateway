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
 * @param {Object} deps.sessionStore    { create, resolve, appendAndMaybeCompress,
 *                                        addImage, setImageMode, remove, status,
 *                                        buildImageFragment }
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
  defaultPersona = process.env.DEFAULT_PERSONA ?? '',
  maxUploadBytes = parseInt(process.env.MAX_UPLOAD_BYTES ?? '52428800', 10),
}) {

  // -------------------------------------------------------------------------
  // Helper: resolve persona name → { system?, options? }
  // -------------------------------------------------------------------------

  function resolvePersona(requestedName) {
    const name = requestedName || defaultPersona || null
    if (!name) return {}
    return personaManager.load(name)
  }

  // -------------------------------------------------------------------------
  // Helper: build composite system prompt from persona + image fragment
  // -------------------------------------------------------------------------

  function buildSystemPrompt(personaSystem, imageFragment) {
    const parts = [personaSystem, imageFragment].filter(Boolean)
    return parts.length ? parts.join('\n\n') : undefined
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
  // Helper: build image_context payload field from session
  // -------------------------------------------------------------------------

  function imageContext(session) {
    const images = (session.images ?? []).map(img => img.name)
    if (images.length === 0) return null
    return {
      mode:   session.imageMode ?? 'on',
      images,
    }
  }

  // -------------------------------------------------------------------------
  // Helper: parse multipart fields for context_chat
  // Returns { prompt, uid, cache, personaName, reqOptions, imageBuffer,
  //           imageName, imageMode }
  // -------------------------------------------------------------------------

  async function parseContextChatParts(req) {
    const parts      = req.parts({ limits: { fileSize: maxUploadBytes } })
    let prompt       = null
    let uid          = null
    let cache        = true
    let personaName  = null
    let reqOptions   = null
    let imageBuffer  = null
    let imageName    = null
    let imageMode    = null   // 'on' | 'off' | null (no change)

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'image') {
        imageName       = part.filename ?? 'image'
        const chunks    = []
        for await (const chunk of part.file) chunks.push(chunk)
        imageBuffer     = Buffer.concat(chunks)
      } else if (part.type === 'field') {
        if (part.fieldname === 'prompt')     prompt      = part.value
        if (part.fieldname === 'uid')        uid         = part.value
        if (part.fieldname === 'persona')    personaName = part.value
        if (part.fieldname === 'image_mode') imageMode   = part.value   // 'on' or 'off'
        if (part.fieldname === 'cache')      cache       = part.value !== 'false'
        if (part.fieldname === 'options') {
          try { reqOptions = JSON.parse(part.value) } catch { /* ignore */ }
        }
      }
    }

    return { prompt, uid, cache, personaName, reqOptions, imageBuffer, imageName, imageMode }
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
    // POST /chat  (stateless)
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
      try { personaData = resolvePersona(personaName) }
      catch (err) { return reply.status(err.statusCode ?? 424).send({ error: err.message }) }

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
      try { personaData = resolvePersona(personaName) }
      catch (err) { return reply.status(err.statusCode ?? 424).send({ error: err.message }) }

      const options = reqOptions ?? personaData.options

      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')

      await run(async () => {
        for await (const token of ollamaClient.chatStream({
          text: prompt, history, system: personaData.system, options,
        })) {
          reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`)
        }
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
      })
    })

    // ------------------------------------------------------------------
    // POST /imagine  (stateless)
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
      try { personaData = resolvePersona(personaName) }
      catch (err) { return reply.status(err.statusCode ?? 424).send({ error: err.message }) }

      const options = reqOptions ?? personaData.options

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, image: imageBuffer, history, system: personaData.system, options })
      )
      reply.send({ reply: reply_text })
    })

    // ------------------------------------------------------------------
    // POST /transcribe  (stateless)
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
      try { personaData = resolvePersona(personaName) }
      catch (err) { return reply.status(err.statusCode ?? 424).send({ error: err.message }) }

      const options = reqOptions ?? personaData.options

      const reply_text = await run(() =>
        ollamaClient.chat({ text: prompt, audio: audioBuffer, system: personaData.system, options })
      )
      reply.send({ reply: reply_text })
    })

    // ------------------------------------------------------------------
    // POST /context_chat  (stateful, multipart)
    //
    // Multipart fields:
    //   prompt      (required)  User message
    //   uid         (optional)  Resume existing session
    //   cache       (optional)  'true'|'false', default true
    //   persona     (optional)  Persona name
    //   options     (optional)  JSON object of inference params
    //   image       (file, optional)  Triggers verbalization pipeline
    //   image_mode  (optional)  'on'|'off' — toggle image-awareness
    // ------------------------------------------------------------------
    app.post('/context_chat', async (req, reply) => {
      // Parse multipart (image is optional — text-only turns also go through here)
      let fields
      try {
        fields = await parseContextChatParts(req)
      } catch (err) {
        return reply.status(400).send({ error: `Failed to parse request: ${err.message}` })
      }

      const { prompt, uid: incomingUid, cache, personaName, reqOptions,
              imageBuffer, imageName, imageMode } = fields

      if (!prompt) {
        return reply.status(400).send({ error: 'Missing required field: prompt' })
      }

      // Resolve persona
      let personaData
      try { personaData = resolvePersona(personaName) }
      catch (err) { return reply.status(err.statusCode ?? 424).send({ error: err.message }) }

      // Resolve session
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
        const created = sessionStore.create(cache, personaName || defaultPersona || null)
        uid      = created.uid
        session  = created.session
        isNew    = true
        volatile = !cache
      }

      // Apply explicit image_mode change if requested
      if (imageMode === 'on' || imageMode === 'off') {
        sessionStore.setImageMode(uid, imageMode)
      }

      // Resolve effective persona (session may carry one from creation)
      const effectivePersonaName = personaName
        || (incomingUid ? session.personaName : null)
        || defaultPersona
        || null

      let effectivePersona = personaData
      if (incomingUid && !personaName && effectivePersonaName) {
        try { effectivePersona = personaManager.load(effectivePersonaName) }
        catch { effectivePersona = {} }
      }

      const options = reqOptions ?? effectivePersona.options

      // ------------------------------------------------------------------
      // Image pipeline: verbalize on upload, then re-attach for direct vision
      // ------------------------------------------------------------------

      let imageAttachment  = null   // raw buffer for this turn (direct vision)
      let verbalizationNote = null  // surface to caller when image was verbalized

      if (imageBuffer) {
        // Verbalize the image: ask the model to describe it richly
        const verbPrompt = `Please describe this image in detail, as if explaining it to someone who cannot see it. Be thorough — note subjects, composition, colours, text if any, and any other notable elements.`

        const description = await run(() =>
          ollamaClient.chat({
            text:    verbPrompt,
            image:   imageBuffer,
            history: [],
            system:  effectivePersona.system,
            options,
          })
        )

        // Store description in session (also sets imageMode → 'on')
        sessionStore.addImage(uid, imageName, description)

        // Inject the description as an assistant turn so it's in history
        const descriptionTurn = `[image: ${imageName}]\n${description}`
        await sessionStore.appendAndMaybeCompress(
          uid,
          `[User uploaded image: ${imageName}]`,
          descriptionTurn,
          (opts) => ollamaClient.chat({ ...opts, system: effectivePersona.system })
        )

        // Also attach image to this turn so the model sees it directly
        imageAttachment   = imageBuffer
        verbalizationNote = imageName
      }

      // Build composite system prompt: persona + image-awareness fragment
      const imageFragment = sessionStore.buildImageFragment(session)
      const system        = buildSystemPrompt(effectivePersona.system, imageFragment)

      // Run the actual user prompt
      const replyText = await run(() =>
        ollamaClient.chat({
          text:    prompt,
          image:   imageAttachment,   // raw image attached only when uploaded this turn
          history: session.history,
          system,
          options,
        })
      )

      const contextUsage = await sessionStore.appendAndMaybeCompress(
        uid, prompt, replyText,
        (opts) => ollamaClient.chat({ ...opts, system })
      )

      // Build response
      const response = {
        uid,
        reply:         replyText,
        context_usage: contextUsage,
      }

      const imgCtx = imageContext(session)
      if (imgCtx) response.image_context = imgCtx

      if (verbalizationNote) {
        response.verbalized = verbalizationNote
      }

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
    // GET /personas
    // ------------------------------------------------------------------
    app.get('/personas', async () => ({
      personas: personaManager.list(),
      default:  defaultPersona || null,
    }))

  }

  return routes
}

module.exports = { createRoutes }
