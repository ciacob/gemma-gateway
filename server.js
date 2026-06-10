'use strict'

require('dotenv').config()

const Fastify   = require('fastify')
const multipart = require('@fastify/multipart')

const { createOllamaClient }  = require('./src/ollama')
const { ModelManager }        = require('./src/modelManager')
const { createQueue }         = require('./src/queue')
const { createSessionStore }  = require('./src/sessions')
const { createRoutes }        = require('./src/routes')
const { createPersonaManager } = require('./src/personas')

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '127.0.0.1'

// ---------------------------------------------------------------------------
// buildApp — exported so integration tests can spin up the full stack
// without calling listen()
// ---------------------------------------------------------------------------

function buildApp() {
  const ollamaClient  = createOllamaClient()
  const modelManager  = new ModelManager({ ollamaClient })
  const queue         = createQueue()
  const sessionStore   = createSessionStore()
  const personaManager = createPersonaManager()

  const app = Fastify({
    logger: {
      transport: {
        target:  'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      },
    },
  })

  app.register(multipart)
  app.register(createRoutes({ ollamaClient, modelManager, sessionStore, queue, personaManager }))

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? err.status ?? 500
    app.log.error({ err }, err.message)
    reply.status(status).send({ error: err.message })
  })

  // Expose for graceful shutdown
  app.modelManager = modelManager

  return app
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(app, signal) {
  app.log.info(`${signal} received — shutting down`)
  try {
    await app.modelManager.forceUnload()
  } catch (e) {
    app.log.warn('Could not unload model during shutdown:', e.message)
  }
  await app.close()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const app = buildApp()

  process.on('SIGTERM', () => shutdown(app, 'SIGTERM'))
  process.on('SIGINT',  () => shutdown(app, 'SIGINT'))

  app.listen({ port: PORT, host: HOST }, (err) => {
    if (err) {
      app.log.error(err)
      process.exit(1)
    }
  })
}

module.exports = { buildApp }
