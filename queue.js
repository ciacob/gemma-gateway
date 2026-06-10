'use strict'

/**
 * Thin wrapper around p-queue.
 *
 * - Concurrency = 1 by default (Ollama handles one inference at a time well)
 * - Hard cap on pending size → 429 instead of unbounded memory growth
 * - Exposes queue depth for health/status endpoints
 */

const { default: PQueue } = require('p-queue')

const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY ?? '1',  10)
const MAX_SIZE    = parseInt(process.env.QUEUE_MAX_SIZE    ?? '20', 10)

const queue = new PQueue({ concurrency: CONCURRENCY })

/**
 * Enqueue a task function.
 * Throws a {status: 429} error if the queue is at capacity.
 *
 * @param  {Function} fn   Async function to run
 * @returns {Promise}      Resolves/rejects with fn's result
 */
function enqueue(fn) {
  if (queue.size >= MAX_SIZE) {
    const err = new Error(`Queue full (${MAX_SIZE} pending). Try again later.`)
    err.statusCode = 429
    throw err
  }
  return queue.add(fn)
}

function stats() {
  return {
    pending:     queue.size,
    running:     queue.pending,
    concurrency: CONCURRENCY,
    maxSize:     MAX_SIZE,
  }
}

module.exports = { enqueue, stats }
