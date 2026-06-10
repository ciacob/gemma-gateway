'use strict'

/**
 * Thin wrapper around the Ollama REST API.
 *
 * Responsibilities:
 *   - Send chat requests (text, image, audio) with correct payload shape
 *   - Manage model keep_alive so Ollama unloads on our schedule
 *   - Explicit load / unload calls for lifecycle management
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
const MODEL           = process.env.OLLAMA_MODEL          ?? 'gemma4:e4b'
const KEEP_ALIVE_SEC  = parseInt(process.env.MODEL_KEEP_ALIVE_SECONDS ?? '300', 10)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function post(path, body) {
  const res = await fetch(`${OLLAMA_BASE_URL}${path}`, {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ping Ollama to pre-load the model into memory without sending a real prompt.
 * Uses keep_alive so the model stays loaded for the full TTL window.
 */
async function loadModel() {
  await post('/api/chat', {
    model:      MODEL,
    keep_alive: `${KEEP_ALIVE_SEC}s`,
    messages:   [],  // empty messages = load only, no generation
  })
}

/**
 * Explicitly unload the model from memory.
 */
async function unloadModel() {
  await post('/api/chat', {
    model:      MODEL,
    keep_alive: '0s',
    messages:   [],
  })
}

/**
 * Send a chat request and return the full assistant reply as a string.
 *
 * @param {Object}   opts
 * @param {string}   opts.text        - User text prompt (required)
 * @param {Buffer}   [opts.image]     - Raw image bytes (PNG/JPEG/WEBP/GIF)
 * @param {Buffer}   [opts.audio]     - Raw audio bytes (WAV/MP3/FLAC)
 * @param {Array}    [opts.history]   - Prior turns: [{role, content}]
 */
async function chat({ text, image, audio, history = [] }) {
  // Build the user message content
  // Ollama multimodal: images are base64 strings in the `images` array.
  // Audio is embedded as a base64 data-URI in the text content (Gemma 4 E4B
  // accepts inline audio via the text field as a data URI when no dedicated
  // audio field is available in the Ollama API yet).
  const userMessage = { role: 'user', content: text }

  if (image) {
    userMessage.images = [bufferToBase64(image)]
  }

  if (audio) {
    // Gemma 4 native audio: pass as a data-URI appended to content.
    // When Ollama adds a dedicated audio field this can be updated.
    const mime    = detectAudioMime(audio)
    const dataUri = `data:${mime};base64,${bufferToBase64(audio)}`
    userMessage.content = `${text}\n\n[audio](${dataUri})`
  }

  const messages = [...history, userMessage]

  const res = await post('/api/chat', {
    model:      MODEL,
    keep_alive: `${KEEP_ALIVE_SEC}s`,
    stream:     false,
    messages,
  })

  const json = await res.json()
  return json.message?.content ?? ''
}

/**
 * Same as chat() but streams tokens back via an async generator.
 * Caller is responsible for writing chunks to the response stream.
 */
async function* chatStream({ text, image, audio, history = [] }) {
  const userMessage = { role: 'user', content: text }
  if (image) userMessage.images = [bufferToBase64(image)]
  if (audio) {
    const mime    = detectAudioMime(audio)
    const dataUri = `data:${mime};base64,${bufferToBase64(audio)}`
    userMessage.content = `${text}\n\n[audio](${dataUri})`
  }

  const messages = [...history, userMessage]

  const res = await post('/api/chat', {
    model:      MODEL,
    keep_alive: `${KEEP_ALIVE_SEC}s`,
    stream:     true,
    messages,
  })

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    // Each chunk may contain one or more newline-delimited JSON objects
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.message?.content) yield obj.message.content
      } catch { /* partial line, skip */ }
    }
  }
}

/** Minimal audio MIME sniff from magic bytes */
function detectAudioMime(buf) {
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg' // ID3 → mp3
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46) return 'audio/wav'  // RIFF → wav
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61) return 'audio/flac' // fLaC
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67) return 'audio/ogg'  // OggS
  return 'audio/mpeg' // fallback
}

module.exports = { loadModel, unloadModel, chat, chatStream }
