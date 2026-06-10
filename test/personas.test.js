'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createPersonaManager } = require('../src/personas')

// ---------------------------------------------------------------------------
// Fake filesystem
// ---------------------------------------------------------------------------

function makeFakeFs(files = {}) {
  // files: { '/full/path/name.json': 'raw content string' }
  const map = new Map(Object.entries(files))
  return {
    // Returns true for exact file paths AND for directory prefixes
    existsSync:   (p) => map.has(p) || [...map.keys()].some(k => k.startsWith(p + '/')),
    readFileSync: (p) => {
      if (!map.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return map.get(p)
    },
    readdirSync:  (p) => [...map.keys()]
      .filter(k => k.startsWith(p + '/'))
      .map(k => k.slice(p.length + 1)),
  }
}

const PERSONAS_DIR = '/fake/personas'

function path(name) {
  return `${PERSONAS_DIR}/${name}.json`
}

// ---------------------------------------------------------------------------
// Valid persona fixtures
// ---------------------------------------------------------------------------

const FULL_PERSONA = JSON.stringify({
  description: 'Test persona',
  system:      'You are a test assistant.',
  options:     { temperature: 0.3, top_p: 0.9 },
})

const SYSTEM_ONLY = JSON.stringify({
  system: 'Be brief.',
})

const OPTIONS_ONLY = JSON.stringify({
  options: { temperature: 0.5 },
})

const EMPTY_PERSONA = JSON.stringify({
  description: 'No system, no options',
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('personas', () => {

  describe('load', () => {
    it('returns system and options for a full persona', () => {
      const fs  = makeFakeFs({ [path('full')]: FULL_PERSONA })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      const p   = mgr.load('full')
      assert.equal(p.system, 'You are a test assistant.')
      assert.deepEqual(p.options, { temperature: 0.3, top_p: 0.9 })
    })

    it('returns only system when options are absent', () => {
      const fs  = makeFakeFs({ [path('sys')]: SYSTEM_ONLY })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      const p   = mgr.load('sys')
      assert.equal(p.system, 'Be brief.')
      assert.equal(p.options, undefined)
    })

    it('returns only options when system is absent', () => {
      const fs  = makeFakeFs({ [path('opts')]: OPTIONS_ONLY })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      const p   = mgr.load('opts')
      assert.equal(p.system, undefined)
      assert.deepEqual(p.options, { temperature: 0.5 })
    })

    it('returns empty object when persona has neither system nor options', () => {
      const fs  = makeFakeFs({ [path('empty')]: EMPTY_PERSONA })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      const p   = mgr.load('empty')
      assert.deepEqual(p, {})
    })

    it('ignores unknown keys (description etc.)', () => {
      const fs  = makeFakeFs({ [path('full')]: FULL_PERSONA })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      const p   = mgr.load('full')
      assert.equal(p.description, undefined)
    })

    it('throws 424 when persona file does not exist', () => {
      const fs  = makeFakeFs({})
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      assert.throws(
        () => mgr.load('missing'),
        (err) => {
          assert.equal(err.statusCode, 424)
          assert.ok(err.message.includes('missing'))
          return true
        }
      )
    })

    it('throws 424 when persona file contains invalid JSON', () => {
      const fs  = makeFakeFs({ [path('bad')]: '{ not valid json' })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      assert.throws(
        () => mgr.load('bad'),
        (err) => {
          assert.equal(err.statusCode, 424)
          assert.ok(err.message.includes('invalid JSON'))
          return true
        }
      )
    })

    it('throws 424 when persona file cannot be read', () => {
      const badFs = {
        existsSync:   () => true,
        readFileSync: () => { throw new Error('permission denied') },
        readdirSync:  () => [],
      }
      const mgr = createPersonaManager({ fs: badFs, personasDir: PERSONAS_DIR })
      assert.throws(
        () => mgr.load('locked'),
        (err) => {
          assert.equal(err.statusCode, 424)
          assert.ok(err.message.includes('could not be read'))
          return true
        }
      )
    })

    it('error message includes persona name', () => {
      const fs  = makeFakeFs({})
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      assert.throws(
        () => mgr.load('my-persona'),
        (err) => { assert.ok(err.message.includes('my-persona')); return true }
      )
    })
  })

  describe('list', () => {
    it('returns persona names sorted alphabetically', () => {
      const fs = makeFakeFs({
        [path('zebra')]:  '{}',
        [path('alpha')]:  '{}',
        [path('middle')]: '{}',
      })
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      assert.deepEqual(mgr.list(), ['alpha', 'middle', 'zebra'])
    })

    it('excludes non-JSON files', () => {
      const badFs = {
        existsSync:   () => true,
        readFileSync: () => '',
        readdirSync:  () => ['concise.json', 'notes.txt', 'default.json', '.DS_Store'],
      }
      const mgr = createPersonaManager({ fs: badFs, personasDir: PERSONAS_DIR })
      const names = mgr.list()
      assert.ok(names.includes('concise'))
      assert.ok(names.includes('default'))
      assert.ok(!names.includes('notes'))
      assert.ok(!names.includes('.DS_Store'))
    })

    it('returns empty array when personas directory does not exist', () => {
      const fs = {
        existsSync:   () => false,
        readFileSync: () => '',
        readdirSync:  () => [],
      }
      const mgr = createPersonaManager({ fs, personasDir: PERSONAS_DIR })
      assert.deepEqual(mgr.list(), [])
    })
  })

})
