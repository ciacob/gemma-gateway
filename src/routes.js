'use strict'

const ollama       = require('./ollama')
const modelManager = require('./modelManager')
const { enqueue, stats } = require('./queue')

const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES ?? '52428800', 10)

// ---------------------------------------------------------------------------
// Helper: run a task through the queue + model lifecycle
// ---------------------------------------------------------------------------

async function run(task) {
  return enqueue(async () => {
    await modelManager.ensureLoaded()
    const result = await task()
    modelManager.touch()
    return result
  })
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

async function routes(app) {

  // ------------------------------------------------------------------
  // GET /status
  // ------------------------------------------------------------------
  app.get('/status', async () => ({
    model: modelManager.status(),
    queue: stats(),
  }))

  // ------------------------------------------------------------------
  // POST /unload   — admin: evict model immediately
  // ------------------------------------------------------------------
  app.post('/unload', async (req, reply) => {
    await modelManager.forceUnload()
    reply.send({ ok: true, state: modelManager.state })
  })

  // ------------------------------------------------------------------
  // POST /chat   — text-only prompt
  //
  // Body (JSON):
  //   { prompt: string, history?: [{role, content}] }
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
      ollama.chat({ text: prompt, history })
    )

    reply.send({ reply: reply_text })
  })

  // ------------------------------------------------------------------
  // POST /chat/stream   — same as /chat but SSE streaming
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
      for await (const token of ollama.chatStream({ text: prompt, history })) {
        reply.raw.write(`data: ${JSON.stringify({ token })}\n\n`)
      }
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
    })
  })

  // ------------------------------------------------------------------
  // POST /imagine   — image + optional text prompt
  //
  // Multipart form fields:
  //   image   (file, required)  PNG / JPEG / WEBP / GIF
  //   prompt  (field, optional) defaults to "Describe this image."
  //   history (field, optional) JSON string of prior turns
  // ------------------------------------------------------------------
  app.post('/imagine', async (req, reply) => {
    const parts = req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })

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
      ollama.chat({ text: prompt, image: imageBuffer, history })
    )

    reply.send({ reply: reply_text })
  })

  // ------------------------------------------------------------------
  // POST /transcribe   — audio file + optional prompt
  //
  // Multipart form fields:
  //   audio   (file, required)  WAV / MP3 / FLAC / OGG
  //   prompt  (field, optional) defaults to "Transcribe this audio."
  // ------------------------------------------------------------------
  app.post('/transcribe', async (req, reply) => {
    const parts = req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })

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
      ollama.chat({ text: prompt, audio: audioBuffer })
    )

    reply.send({ reply: reply_text })
  })

}

module.exports = routes
