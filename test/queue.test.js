'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createQueue } = require('../src/queue')

describe('queue', () => {

  it('runs a task and returns its result', async () => {
    const q = createQueue({ concurrency: 1, maxSize: 5 })
    const result = await q.enqueue(() => Promise.resolve(42))
    assert.equal(result, 42)
  })

  it('stats reflect pending and concurrency', async () => {
    const q = createQueue({ concurrency: 1, maxSize: 5 })
    const s = q.stats()
    assert.equal(s.concurrency, 1)
    assert.equal(s.maxSize, 5)
    assert.equal(s.pending, 0)
    assert.equal(s.running, 0)
  })

  it('throws 429 when queue is full', async () => {
    const q = createQueue({ concurrency: 1, maxSize: 2 })

    // Block the one worker indefinitely
    let unblock
    q.enqueue(() => new Promise(res => { unblock = res }))

    // Fill the pending slots
    q.enqueue(() => Promise.resolve())
    q.enqueue(() => Promise.resolve())

    // This one should be rejected
    assert.throws(
      () => q.enqueue(() => Promise.resolve()),
      (err) => {
        assert.equal(err.statusCode, 429)
        return true
      }
    )

    unblock()
  })

  it('each createQueue() instance is isolated', async () => {
    const q1 = createQueue({ concurrency: 1, maxSize: 1 })
    const q2 = createQueue({ concurrency: 1, maxSize: 10 })

    let unblock
    q1.enqueue(() => new Promise(res => { unblock = res }))
    q1.enqueue(() => Promise.resolve()) // fills q1

    // q1 is full — should throw
    assert.throws(() => q1.enqueue(() => {}), /Queue full/)

    // q2 is independent — should not throw
    assert.doesNotThrow(() => q2.enqueue(() => Promise.resolve()))

    unblock()
  })

})
