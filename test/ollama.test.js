'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createOllamaClient } = require('../src/ollama')

// ---------------------------------------------------------------------------
// Mock HTTP client builder
// ---------------------------------------------------------------------------

/**
 * Returns a mock httpClient that responds with `body` and status `status`.
 * Also records every call so tests can inspect what was sent.
 */
function mockHttp(body, { status = 200 } = {}) {
  const calls = []
  const client = async (url, init) => {
    const sent = { url, body: JSON.parse(init.body) }
    calls.push(sent)
    const responseBody = JSON.stringify(body)
    return {
      ok:   status >= 200 && status < 300,
      status,
      text: async () => responseBody,
      json: async () => body,
      body: null, // not used in non-stream tests
    }
  }
  client.calls = calls
  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ollama client', () => {

  describe('loadModel', () => {
    it('posts to /api/chat with empty messages and keep_alive', async () => {
      const http = mockHttp({})
      const client = createOllamaClient({ httpClient: http, keepAlive: 60 })
      await client.loadModel()

      assert.equal(http.calls.length, 1)
      assert.ok(http.calls[0].url.endsWith('/api/chat'))
      assert.deepEqual(http.calls[0].body.messages, [])
      assert.equal(http.calls[0].body.keep_alive, '60s')
    })
  })

  describe('unloadModel', () => {
    it('posts with keep_alive 0s', async () => {
      const http = mockHttp({})
      const client = createOllamaClient({ httpClient: http })
      await client.unloadModel()

      assert.equal(http.calls[0].body.keep_alive, '0s')
    })
  })

  describe('chat', () => {
    it('returns the assistant content string', async () => {
      const http = mockHttp({ message: { content: 'Hello there!' } })
      const client = createOllamaClient({ httpClient: http })
      const reply = await client.chat({ text: 'Hi' })
      assert.equal(reply, 'Hello there!')
    })

    it('sends history as prior messages', async () => {
      const http = mockHttp({ message: { content: 'ok' } })
      const client = createOllamaClient({ httpClient: http })
      const history = [
        { role: 'user',      content: 'First message' },
        { role: 'assistant', content: 'First reply'   },
      ]
      await client.chat({ text: 'Second message', history })

      const messages = http.calls[0].body.messages
      assert.equal(messages.length, 3)
      assert.equal(messages[0].content, 'First message')
      assert.equal(messages[2].content, 'Second message')
    })

    it('attaches image as base64 in images array', async () => {
      const http = mockHttp({ message: { content: 'ok' } })
      const client = createOllamaClient({ httpClient: http })
      const imageBuffer = Buffer.from('fake-image-bytes')
      await client.chat({ text: 'Describe this', image: imageBuffer })

      const msg = http.calls[0].body.messages[0]
      assert.ok(Array.isArray(msg.images))
      assert.equal(msg.images[0], imageBuffer.toString('base64'))
    })

    it('embeds audio as data-URI in content', async () => {
      const http = mockHttp({ message: { content: 'ok' } })
      const client = createOllamaClient({ httpClient: http })
      // Fake WAV magic bytes: RIFF
      const audioBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, ...Buffer.from('rest')])
      await client.chat({ text: 'Transcribe', audio: audioBuffer })

      const msg = http.calls[0].body.messages[0]
      assert.ok(msg.content.includes('data:audio/wav;base64,'))
    })

    it('throws on non-2xx response', async () => {
      const http = mockHttp({ error: 'model not found' }, { status: 404 })
      const client = createOllamaClient({ httpClient: http })
      await assert.rejects(
        () => client.chat({ text: 'hi' }),
        /HTTP 404/
      )
    })

    it('returns empty string when response has no message content', async () => {
      const http = mockHttp({})
      const client = createOllamaClient({ httpClient: http })
      const reply = await client.chat({ text: 'hi' })
      assert.equal(reply, '')
    })
  })

  describe('audio MIME detection', () => {
    // We test MIME detection indirectly through chat() by checking the
    // data-URI prefix in the message content.
    const cases = [
      { bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg',  label: 'MP3 (ID3)' },
      { bytes: [0x52, 0x49, 0x46], mime: 'audio/wav',   label: 'WAV (RIFF)' },
      { bytes: [0x66, 0x4c, 0x61], mime: 'audio/flac',  label: 'FLAC'       },
      { bytes: [0x4f, 0x67, 0x67], mime: 'audio/ogg',   label: 'OGG'        },
      { bytes: [0x00, 0x00, 0x00], mime: 'audio/mpeg',  label: 'unknown → mp3 fallback' },
    ]

    for (const { bytes, mime, label } of cases) {
      it(`detects ${label}`, async () => {
        const http = mockHttp({ message: { content: 'ok' } })
        const client = createOllamaClient({ httpClient: http })
        const buf = Buffer.from([...bytes, 0x00])
        await client.chat({ text: 'x', audio: buf })
        const content = http.calls[0].body.messages[0].content
        assert.ok(content.includes(`data:${mime};base64,`), `expected ${mime} in: ${content}`)
      })
    }
  })

})
