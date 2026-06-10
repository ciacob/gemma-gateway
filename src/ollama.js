'use strict'

/**
 * Ollama HTTP client factory.
 *
 * Accepts an optional `httpClient` function with the same signature as the
 * global `fetch`. Defaults to the global fetch so production code needs no
 * changes. Tests inject a mock to avoid network calls entirely.
 */

function createOllamaClient({
  baseUrl    = process.env.OLLAMA_BASE_URL      ?? 'http://localhost:11434',
  model      = process.env.OLLAMA_MODEL         ?? 'gemma4:e4b',
  keepAlive  = parseInt(process.env.MODEL_KEEP_ALIVE_SECONDS ?? '300', 10),
  httpClient = fetch,
} = {}) {

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async function post(path, body) {
    const res = await httpClient(`${baseUrl}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)')
      throw new Error(`Ollama ${path} → HTTP ${res.status}: ${text}`)
    }

    return res
  }

  function bufferToBase64(buffer) {
    return buffer.toString('base64')
  }

  /** Minimal audio MIME sniff from magic bytes */
  function detectAudioMime(buf) {
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg' // ID3 → mp3
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46) return 'audio/wav'  // RIFF → wav
    if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61) return 'audio/flac' // fLaC
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67) return 'audio/ogg'  // OggS
    return 'audio/mpeg'
  }

  /**
   * Build the messages array, prepending a system turn when provided.
   * System turn always comes first, before any history.
   */
  function buildMessages({ text, image, audio, history, system }) {
    const messages = []

    if (system) {
      messages.push({ role: 'system', content: system })
    }

    for (const turn of history) {
      messages.push(turn)
    }

    const userMessage = { role: 'user', content: text }

    if (image) {
      userMessage.images = [bufferToBase64(image)]
    }

    if (audio) {
      const mime    = detectAudioMime(audio)
      const dataUri = `data:${mime};base64,${bufferToBase64(audio)}`
      userMessage.content = `${text}\n\n[audio](${dataUri})`
    }

    messages.push(userMessage)
    return messages
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async function loadModel() {
    await post('/api/chat', {
      model,
      keep_alive: `${keepAlive}s`,
      messages:   [],
    })
  }

  async function unloadModel() {
    await post('/api/chat', {
      model,
      keep_alive: '0s',
      messages:   [],
    })
  }

  /**
   * Send a chat request and return the full assistant reply as a string.
   *
   * @param {Object}  opts
   * @param {string}  opts.text          User text prompt
   * @param {Buffer}  [opts.image]       Raw image bytes
   * @param {Buffer}  [opts.audio]       Raw audio bytes
   * @param {Array}   [opts.history]     Prior turns: [{role, content}]
   * @param {string}  [opts.system]      System prompt (prepended before history)
   * @param {Object}  [opts.options]     Ollama inference parameters (temperature, etc.)
   */
  async function chat({ text, image, audio, history = [], system, options } = {}) {
    const messages = buildMessages({ text, image, audio, history, system })

    const body = {
      model,
      keep_alive: `${keepAlive}s`,
      stream:     false,
      messages,
    }

    if (options && typeof options === 'object') {
      body.options = options
    }

    const res  = await post('/api/chat', body)
    const json = await res.json()
    return json.message?.content ?? ''
  }

  /**
   * Same as chat() but streams tokens back via an async generator.
   */
  async function* chatStream({ text, image, audio, history = [], system, options } = {}) {
    const messages = buildMessages({ text, image, audio, history, system })

    const body = {
      model,
      keep_alive: `${keepAlive}s`,
      stream:     true,
      messages,
    }

    if (options && typeof options === 'object') {
      body.options = options
    }

    const res     = await post('/api/chat', body)
    const reader  = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj.message?.content) yield obj.message.content
        } catch { /* partial line */ }
      }
    }
  }

  return { loadModel, unloadModel, chat, chatStream }
}

// Singleton for production use
const defaultClient = createOllamaClient()

module.exports = { createOllamaClient, ...defaultClient }
