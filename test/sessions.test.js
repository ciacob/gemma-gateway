'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createSessionStore } = require('../src/sessions')

// ---------------------------------------------------------------------------
// Fake filesystem (fresh instance per makeStore call)
// ---------------------------------------------------------------------------

function makeFakeFs() {
  const files = new Map()
  return {
    _files: files,
    existsSync:    (p) => files.has(p),
    mkdirSync:     ()  => {},
    writeFileSync: (p, data) => files.set(p, data),
    readFileSync:  (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p)
    },
    unlinkSync:    (p) => files.delete(p),
  }
}

// Fake chatFn — returns a fixed summary string
const fakeChatFn = async () => 'Summary of earlier conversation.'

// ---------------------------------------------------------------------------
// Factory helper — each call returns a fully isolated store
// ---------------------------------------------------------------------------

function makeStore(overrides = {}) {
  let tick   = 1000
  let uidSeq = 0
  return createSessionStore({
    fs:                    makeFakeFs(),
    now:                   () => ++tick,
    uuidFn:                () => `uid-${++uidSeq}`,
    cacheDir:              '/fake/sessions',
    modelContextTokens:    1000,   // small window to hit threshold easily
    summarizeThresholdPct: 80,     // threshold = 800 tokens = 3200 chars
    keepRecentTurns:       2,      // keep last 2 raw turns verbatim
    ...overrides,
  })
}

// Generate a string of exactly `tokens` tokens (4 chars per token)
function chars(tokens) {
  return 'x'.repeat(tokens * 4)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sessions', () => {

  describe('estimateTokens', () => {
    it('counts chars / 4 across all turns', () => {
      const store = makeStore()
      const history = [
        { role: 'user',      content: 'abcd'     },  // 1 token
        { role: 'assistant', content: 'abcdefgh' },  // 2 tokens
      ]
      assert.equal(store.estimateTokens(history), 3)
    })

    it('rounds up partial tokens', () => {
      const store = makeStore()
      assert.equal(store.estimateTokens([{ role: 'user', content: 'abc' }]), 1)
    })

    it('returns 0 for empty history', () => {
      const store = makeStore()
      assert.equal(store.estimateTokens([]), 0)
    })
  })

  describe('create', () => {
    it('returns a uid and empty history', () => {
      const store = makeStore()
      const { uid, session } = store.create()
      assert.ok(uid)
      assert.deepEqual(session.history, [])
    })

    it('defaults cached to true', () => {
      const store = makeStore()
      const { session } = store.create()
      assert.equal(session.cached, true)
    })

    it('writes to disk when cached=true', () => {
      const fakeFs = makeFakeFs()
      const store  = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const { uid } = store.create(true)
      assert.equal(fakeFs._files.size, 1)
      const key = [...fakeFs._files.keys()][0]
      assert.ok(key.includes(uid))
    })

    it('does not write to disk when cached=false', () => {
      const fakeFs = makeFakeFs()
      const store  = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      store.create(false)
      assert.equal(fakeFs._files.size, 0)
    })

    it('volatile session has cached=false', () => {
      const store = makeStore()
      const { session } = store.create(false)
      assert.equal(session.cached, false)
    })
  })

  describe('resolve', () => {
    it('returns session found in memory', () => {
      const store = makeStore()
      const { uid } = store.create()
      assert.ok(store.resolve(uid))
    })

    it('returns null for unknown uid with no disk entry', () => {
      const store = makeStore()
      assert.equal(store.resolve('no-such-uid'), null)
    })

    it('hydrates a cached session from disk into a fresh store', () => {
      const fakeFs = makeFakeFs()
      const store1 = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const { uid } = store1.create(true)

      // New store backed by same fakeFs — simulates restart
      const store2  = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const session = store2.resolve(uid)
      assert.ok(session)
      assert.equal(session.uid, uid)
    })

    it('returns null for volatile session after store restart', () => {
      const fakeFs = makeFakeFs()
      const store1 = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const { uid } = store1.create(false)

      const store2 = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      assert.equal(store2.resolve(uid), null)
    })
  })

  describe('remove', () => {
    it('returns true and clears memory and disk', () => {
      const fakeFs = makeFakeFs()
      const store  = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const { uid } = store.create(true)

      assert.equal(store.remove(uid), true)
      assert.equal(store.resolve(uid), null)
      assert.equal(fakeFs._files.size, 0)
    })

    it('returns false for unknown uid', () => {
      const store = makeStore()
      assert.equal(store.remove('ghost'), false)
    })

    it('removes volatile session from memory only', () => {
      const fakeFs = makeFakeFs()
      const store  = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const { uid } = store.create(false)

      assert.equal(store.remove(uid), true)
      assert.equal(fakeFs._files.size, 0)
    })
  })

  describe('status', () => {
    it('returns null for unknown session', () => {
      const store = makeStore()
      assert.equal(store.status('nope'), null)
    })

    it('counts individual turns (user + assistant = 2 per exchange)', async () => {
      const store = makeStore()
      const { uid } = store.create(false)
      await store.appendAndMaybeCompress(uid, 'hello', 'hi', fakeChatFn)
      assert.equal(store.status(uid).turns, 2)
    })

    it('hasSummary is false on a fresh session', () => {
      const store = makeStore()
      const { uid } = store.create(false)
      assert.equal(store.status(uid).hasSummary, false)
    })

    it('contextUsage is between 0 and 100', async () => {
      const store = makeStore()
      const { uid } = store.create(false)
      await store.appendAndMaybeCompress(uid, 'hi', 'hello', fakeChatFn)
      const { contextUsage } = store.status(uid)
      assert.ok(contextUsage >= 0 && contextUsage <= 100)
    })
  })

  describe('appendAndMaybeCompress', () => {
    it('appends user and assistant turns', async () => {
      const store = makeStore()
      const { uid, session } = store.create(false)
      await store.appendAndMaybeCompress(uid, 'ping', 'pong', fakeChatFn)
      assert.equal(session.history.length, 2)
      assert.equal(session.history[0].role, 'user')
      assert.equal(session.history[0].content, 'ping')
      assert.equal(session.history[1].role, 'assistant')
      assert.equal(session.history[1].content, 'pong')
    })

    it('returns a context_usage number between 0 and 100', async () => {
      const store = makeStore()
      const { uid } = store.create(false)
      const usage = await store.appendAndMaybeCompress(uid, 'hi', 'hello', fakeChatFn)
      assert.ok(typeof usage === 'number')
      assert.ok(usage >= 0 && usage <= 100)
    })

    it('triggers summarisation when token threshold is reached', async () => {
      // keepRecentTurns=0 so all turns are eligible for summarisation.
      // 400+400 = 800 tokens = exactly the threshold (800).
      const store = makeStore({ keepRecentTurns: 0 })
      const { uid, session } = store.create(false)
      const bigContent = chars(400)
      await store.appendAndMaybeCompress(uid, bigContent, bigContent, fakeChatFn)
      assert.equal(session.history[0].role, 'summary')
    })

    it('does not summarise when all turns are within the keep-recent window', async () => {
      // keepRecentTurns=2 and we only add 1 exchange (2 turns) — nothing eligible
      const store = makeStore({ keepRecentTurns: 2 })
      const { uid, session } = store.create(false)
      const bigContent = chars(400)
      await store.appendAndMaybeCompress(uid, bigContent, bigContent, fakeChatFn)
      // No summary turn — all turns protected by keep-recent
      assert.notEqual(session.history[0]?.role, 'summary')
    })

    it('never re-summarises an existing summary turn', async () => {
      // keepRecentTurns=0: all raw turns eligible, guaranteed compression
      const store = makeStore({ keepRecentTurns: 0 })
      const { uid, session } = store.create(false)
      const bigContent = chars(400)

      await store.appendAndMaybeCompress(uid, bigContent, bigContent, fakeChatFn)
      assert.equal(session.history[0].role, 'summary')

      await store.appendAndMaybeCompress(uid, bigContent, bigContent, fakeChatFn)

      const summaryTurns = session.history.filter(t => t.role === 'summary')
      assert.equal(summaryTurns.length, 1)
    })

    it('keeps at most keepRecentTurns raw turns after summarisation', async () => {
      const store = makeStore({ keepRecentTurns: 2 })
      const { uid, session } = store.create(false)

      // Add 4 exchanges (8 turns) with big content to push over threshold
      // After 2 exchanges: 800 tokens — threshold; keepRecentTurns=2 → 2 turns kept
      const bigContent = chars(100)
      for (let i = 0; i < 4; i++) {
        await store.appendAndMaybeCompress(uid, bigContent, bigContent, fakeChatFn)
      }

      const rawTurns = session.history.filter(t => t.role !== 'summary')
      assert.ok(rawTurns.length <= 2, `Expected ≤2 raw turns, got ${rawTurns.length}`)
    })

    it('context_usage resets after summarisation', async () => {
      const store = makeStore({ keepRecentTurns: 0 })
      const { uid } = store.create(false)
      const bigContent = chars(400)
      const usageAfter = await store.appendAndMaybeCompress(
        uid, bigContent, bigContent, fakeChatFn
      )
      // Summary text is short — usage after compression should be well below 100
      assert.ok(usageAfter < 100, `Expected usage < 100 after compression, got ${usageAfter}`)
    })

    it('writes to disk on each append when cached=true', async () => {
      const fakeFs = makeFakeFs()
      const store  = createSessionStore({
        fs: fakeFs, cacheDir: '/fake/sessions',
        modelContextTokens: 1000, summarizeThresholdPct: 80, keepRecentTurns: 2,
      })
      const { uid } = store.create(true)
      fakeFs._files.clear()  // ignore the initial create write

      await store.appendAndMaybeCompress(uid, 'x', 'y', fakeChatFn)
      assert.equal(fakeFs._files.size, 1)
    })

    it('does not write to disk when cached=false', async () => {
      const fakeFs = makeFakeFs()
      const store  = createSessionStore({ fs: fakeFs, cacheDir: '/fake/sessions' })
      const { uid } = store.create(false)
      await store.appendAndMaybeCompress(uid, 'x', 'y', fakeChatFn)
      assert.equal(fakeFs._files.size, 0)
    })

    it('throws if uid is not in memory', async () => {
      const store = makeStore()
      await assert.rejects(
        () => store.appendAndMaybeCompress('ghost', 'x', 'y', fakeChatFn),
        /not in memory/
      )
    })

    it('passes existing summary to chatFn when compressing a second time', async () => {
      const calls = []
      const recordingChatFn = async ({ text }) => {
        calls.push(text)
        return 'Updated summary.'
      }

      const store = makeStore({ keepRecentTurns: 0 })
      const { uid } = store.create(false)
      const bigContent = chars(400)

      // First compression — no existing summary
      await store.appendAndMaybeCompress(uid, bigContent, bigContent, recordingChatFn)
      assert.equal(calls.length, 1)
      assert.ok(!calls[0].includes('existing summary'))

      // Second compression — should reference existing summary
      await store.appendAndMaybeCompress(uid, bigContent, bigContent, recordingChatFn)
      assert.equal(calls.length, 2)
      assert.ok(calls[1].includes('existing summary'), `Expected 'existing summary' in: ${calls[1]}`)
    })
  })

})
