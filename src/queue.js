'use strict'

/**
 * Queue factory.
 *
 * Returns a { enqueue, stats } pair backed by a p-queue instance.
 * Accepting config as arguments (rather than reading process.env at module
 * load time) means tests can create isolated queues with known settings.
 *
 * The module-level export is the singleton used by the running server,
 * configured from process.env. Tests instantiate via createQueue() directly.
 */

const { default: PQueue } = require('p-queue')

function createQueue({
  concurrency = parseInt(process.env.QUEUE_CONCURRENCY ?? '1',  10),
  maxSize     = parseInt(process.env.QUEUE_MAX_SIZE    ?? '20', 10),
} = {}) {
  const queue = new PQueue({ concurrency })

  /**
   * Enqueue a task function.
   * Throws a {statusCode: 429} error if the queue is at capacity.
   */
  function enqueue(fn) {
    if (queue.size >= maxSize) {
      const err = new Error(`Queue full (${maxSize} pending). Try again later.`)
      err.statusCode = 429
      throw err
    }
    return queue.add(fn)
  }

  function stats() {
    return {
      pending:     queue.size,
      running:     queue.pending,
      concurrency,
      maxSize,
    }
  }

  return { enqueue, stats }
}

// Singleton for production use
const defaultQueue = createQueue()

module.exports = { createQueue, ...defaultQueue }
