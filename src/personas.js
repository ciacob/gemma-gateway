'use strict'

/**
 * Persona manager factory.
 *
 * Loads persona definitions from JSON files in a configurable directory.
 * Each persona may define:
 *   - system  {string}  System prompt injected before the first user message
 *   - options {object}  Ollama inference parameter overrides (temperature, etc.)
 *   - description {string}  Human-readable label (ignored at runtime)
 *
 * Dependencies are injected so tests can supply an in-memory filesystem
 * without touching disk.
 *
 * @param {Object}   deps
 * @param {Object}   [deps.fs]          fs-compatible interface
 * @param {string}   [deps.personasDir] Directory containing persona JSON files
 */

const nodefs   = require('fs')
const nodepath = require('path')

function createPersonaManager({
  fs         = nodefs,
  personasDir = process.env.PERSONAS_DIR
               ? nodepath.resolve(process.env.PERSONAS_DIR)
               : nodepath.join(process.cwd(), 'personas'),
} = {}) {

  /**
   * Load and parse a persona by name.
   * Returns { system?, options? } or throws a structured error on failure.
   *
   * @param   {string} name  Filename without extension, e.g. "concise"
   * @returns {{ system?: string, options?: object }}
   * @throws  {{ statusCode: 424, message: string }}
   */
  function load(name) {
    const file = nodepath.join(personasDir, `${name}.json`)

    if (!fs.existsSync(file)) {
      const err = new Error(`Persona '${name}' not found (looked for ${file})`)
      err.statusCode = 424
      throw err
    }

    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      const err = new Error(`Persona '${name}' could not be read: ${e.message}`)
      err.statusCode = 424
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      const err = new Error(`Persona '${name}' contains invalid JSON: ${e.message}`)
      err.statusCode = 424
      throw err
    }

    // Return only the runtime-relevant fields; silently ignore unknown keys
    const result = {}
    if (typeof parsed.system  === 'string') result.system  = parsed.system
    if (typeof parsed.options === 'object' && parsed.options !== null) {
      result.options = parsed.options
    }
    return result
  }

  /**
   * List all available persona names (filenames without .json extension).
   * Returns an empty array if the directory doesn't exist.
   */
  function list() {
    if (!fs.existsSync(personasDir)) return []
    try {
      return fs.readdirSync(personasDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .sort()
    } catch {
      return []
    }
  }

  return { load, list }
}

// Singleton for production use
const defaultManager = createPersonaManager()

module.exports = { createPersonaManager, ...defaultManager }
