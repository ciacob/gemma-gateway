'use strict'

require('dotenv').config()

const Fastify    = require('fastify')
const multipart  = require('@fastify/multipart')
const routes     = require('./src/routes')
const modelManager = require('./src/modelManager')

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '127.0.0.1'

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
    },
  },
})

app.register(multipart)
app.register(routes)

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? err.status ?? 500
  app.log.error({ err }, err.message)
  reply.status(status).send({ error: err.message })
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  app.log.info(`${signal} received — shutting down`)
  try {
    await modelManager.forceUnload()
  } catch (e) {
    app.log.warn('Could not unload model during shutdown:', e.message)
  }
  await app.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
