# gemma-gateway — Test Suite

The test suite uses Node.js 20's built-in `node:test` runner and `node:assert`
— no external test framework required. All tests run offline with no Ollama
instance, no network access, and no disk I/O.

```bash
npm test              # run all tests once
npm run test:watch    # re-run on file changes
```

Current coverage: **132 tests across 6 files**, all passing.

---

## Design philosophy

The guiding principle is **dependency injection over mocking frameworks**. Every
module that talks to the outside world (Ollama, the filesystem, the clock,
timers) accepts its dependencies as constructor or factory arguments. Tests
supply simple in-process fakes instead of patching globals or intercepting
network calls.

This means:

- Tests are fast (no network, no real timers, no disk)
- Tests are deterministic (fake clock, sequential UUID generator)
- Each test gets a fully isolated instance — no shared singleton state
- The production singleton is just the factory called with real defaults

---

## Test files

### `test/queue.test.js`

Tests the `createQueue()` factory from `src/queue.js`.

Covers: task execution and result forwarding; `stats()` reflecting correct
concurrency and size values; synchronous 429 throw when `maxSize` is reached;
isolation between separate queue instances.

The key invariant: `maxSize` is checked **before** the task is enqueued, so the
throw is synchronous and never leaves a dangling promise.

---

### `test/ollama.test.js`

Tests the `createOllamaClient({ httpClient })` factory from `src/ollama.js`.

The `httpClient` parameter replaces the global `fetch`. Each test supplies a
`mockHttp(body, { status })` helper that records every call and returns a
controlled response. No network is involved.

Covers:
- `loadModel()` — correct endpoint, empty messages array, `keep_alive` header
- `unloadModel()` — `keep_alive: "0s"`
- `chat()` — reply extraction, history forwarding, image attachment (base64
  `images` array), audio embedding (data-URI in content), non-2xx error, empty
  response fallback
- `chat()` with `system` prompt — prepended as first message before history,
  absent when not provided
- `chat()` with `options` — forwarded in request body, absent when not provided
- Audio MIME detection — all four magic-byte prefixes (MP3/ID3, WAV/RIFF, FLAC,
  OGG) and the unknown-format fallback

---

### `test/personas.test.js`

Tests the `createPersonaManager({ fs, personasDir })` factory from
`src/personas.js`.

**Injected fake:**

The `makeFakeFs(files)` helper builds an in-memory filesystem from a plain
object mapping full file paths to content strings. `existsSync` returns `true`
for both exact file paths and directory prefixes (so the personas directory
itself is considered to exist if any files live inside it).

Covers `load()`: full persona with system + options; system-only; options-only;
empty persona (neither field); unknown keys ignored; 424 on missing file; 424 on
invalid JSON; 424 on unreadable file; error message includes persona name.

Covers `list()`: alphabetical sort; exclusion of non-JSON files; empty array
when directory absent.

---

### `test/sessions.test.js`

Tests the `createSessionStore({ fs, now, uuidFn, ... })` factory from
`src/sessions.js`. This is the most thorough test file.

**Injected fakes:**

| Dependency | Fake                                                    |
|------------|---------------------------------------------------------|
| `fs`       | `makeFakeFs()` — in-memory `Map` backing all file ops   |
| `now`      | Incrementing counter — deterministic timestamps         |
| `uuidFn`   | Sequential string generator — no randomness             |
| `cacheDir` | `/fake/sessions` — never touches real disk              |

**Config for threshold tests:**

Tests that exercise summarisation use a deliberately small context window
(`modelContextTokens: 1000`, `summarizeThresholdPct: 80` → threshold = 800
tokens = 3200 chars) so content can be crafted to hit the threshold with a small
number of turns.

**Important nuance — `keepRecentTurns`:**

The `summarise()` function protects the most recent N raw turns from compression.
When `keepRecentTurns ≥ number of raw turns`, there is nothing eligible to
summarise and the function returns the history unchanged — even if the token
threshold has been crossed. Tests that assert summarisation fires use
`keepRecentTurns: 0` to ensure all turns are eligible. Tests that assert it
*doesn't* fire use `keepRecentTurns: 2` with only one exchange (2 turns) — both
protected, nothing to compress. This behaviour is tested explicitly in both
directions.

Core covers: `estimateTokens`; `create` (cached and volatile, `personaName`
stored); `resolve` (memory hit, disk hydration, unknown uid, volatile session not
surviving restart, legacy session hydrated with image defaults); `remove`
(memory + disk, volatile, unknown); `status` (turn count, `hasSummary`,
`contextUsage`, `images`, `imageMode`); `appendAndMaybeCompress` (appends turns,
returns 0–100 usage, triggers summarisation, never re-summarises existing summary
turn, respects keep-recent window, resets usage after compression, disk write
policy, throws on unknown uid, passes existing summary to chatFn on second
compression).

Image tracking covers: `addImage()` (stores name + description, auto-enables
`imageMode`, replaces on same filename, multiple distinct images, throws on
unknown uid, persists when cached); `setImageMode()` (on/off toggle, invalid
value throws, throws on unknown uid); `buildImageFragment()` (null when no
images, null when mode is off, contains filename(s) when on, instructs model to
offer re-upload); `status()` image fields (image names list, imageMode reflected);
disk hydration of legacy sessions without image fields.

---

### `test/modelManager.test.js`

Tests the `ModelManager` class from `src/modelManager.js`.

**Injected fakes:**

| Dependency      | Fake                                                         |
|-----------------|--------------------------------------------------------------|
| `ollamaClient`  | Object with `loadModel()` / `unloadModel()` call counters    |
| `setTimeoutFn`  | `makeFakeTimers().setTimeout` — stores callbacks by ID       |
| `clearTimeoutFn`| `makeFakeTimers().clearTimeout` — removes by ID              |

`makeFakeTimers()` returns a `fire(id)` / `fireAll()` API so tests can trigger
the idle timer instantly without real waits.

Covers: initial `UNLOADED` state; `ensureLoaded()` (state transition, single
`loadModel()` call, concurrent-call deduplication, no-op when already READY,
`"ready"` event emission, error path back to UNLOADED with `"error"` event);
`forceUnload()` (READY→UNLOADED, `unloadModel()` called, no-op when already
UNLOADED, clears idle timer, non-fatal unload failure); idle timer (started on
load, fires→unload, `touch()` resets it, `touch()` is no-op when not READY,
`status().idleTimerActive` reflects timer state); reload after unload (both via
idle timer and via `forceUnload()`).

---

### `test/routes.test.js`

Integration tests for all HTTP endpoints in `src/routes.js`, using Fastify's
built-in `app.inject()` to fire requests in-process with no real socket.

Each test calls `buildTestApp()` which wires together mock dependencies and a
real Fastify instance, calls `app.ready()`, runs the test, then calls
`app.close()`. This ensures clean teardown and prevents event-loop leaks between
tests.

**Injected fakes:**

| Dependency      | Fake                                                          |
|-----------------|---------------------------------------------------------------|
| `ollamaClient`  | `makeOllama(replyText)` — records calls, returns fixed string |
| `modelManager`  | `makeModelManager()` — in-memory state, no-op methods         |
| `sessionStore`  | `createSessionStore` with fake fs and sequential UIDs         |
| `personaManager`| `createPersonaManager` with in-memory persona definitions     |
| `queue`         | `createQueue` with real p-queue, controlled concurrency       |

**`buildMultipart(fields, file?)` helper:**

Because `POST /context_chat` is multipart-only, tests use a lightweight
`buildMultipart` function that constructs a valid multipart/form-data body and
returns the matching `Content-Type` header. Text fields and an optional file
attachment are supported.

**Note on the 429 test:**

Testing queue exhaustion via HTTP requires care to avoid dangling promises. The
approach used here is `maxSize: 0` — every `enqueue()` call throws synchronously
before any async work begins, so there is nothing pending when the test returns.
This is a valid test of the route's error-handling path. The underlying queue
behaviour (filling up under real concurrency) is covered separately in
`queue.test.js`.

**Note on image pushback behaviour:**

The model's behaviour of offering to re-examine an image when it detects a
reference without a fresh upload is prompt-guided and non-deterministic. It is
**not** covered by the test suite — the tests verify the gateway's plumbing
(verbalization fires, description stored, `image_context` returned, `image_mode`
toggle applied) but not the model's conversational response to image references.
This is an intentional gap, documented here so it is not mistaken for an
oversight.

Covers: `GET /status` (model, queue, personas); `POST /unload`; `POST /chat`
(valid prompt, history forwarding, missing prompt → 400, full queue → 429);
`POST /context_chat` (new session, volatile notice, no-notice when cached,
session resumption, unknown uid → 404); `DELETE /context_chat/:uid`; `GET
/context_chat/:uid`; `GET /personas`; persona resolution (system + options
forwarded, per-request options override persona options, default persona applied,
424 on unknown persona, all of the above for `/context_chat`); image context chat
(verbalization fires on upload, `verbalized` field in response, `image_context`
in response, image_context carried on subsequent text turns, absent when no
images, `image_mode: off` reflected in response, re-upload replaces not
duplicates, missing prompt → 400).

---

## Adding new tests

Follow the established pattern:

1. Create the store/client/manager via its factory function, not by importing
   the singleton.
2. Supply fakes for all external dependencies — never use real `fs`, real
   timers, or real `fetch` in a unit test.
3. Call `app.close()` at the end of every route test to release Fastify's
   internal resources.
4. Keep each test's setup self-contained — avoid shared mutable state between
   `it()` blocks.
5. For behaviour that depends on model output (tone, persona compliance, image
   re-upload prompting), document the gap explicitly rather than writing a
   test that would be non-deterministic.
