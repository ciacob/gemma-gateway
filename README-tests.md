# gemma-gateway — Test Suite

The test suite uses Node.js 20's built-in `node:test` runner and `node:assert`
— no external test framework required. All tests run offline with no Ollama
instance, no network access, and no disk I/O.

```bash
npm test              # run all tests once
npm run test:watch    # re-run on file changes
```

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
- Audio MIME detection — all four magic-byte prefixes (MP3/ID3, WAV/RIFF, FLAC,
  OGG) and the unknown-format fallback

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

Covers: `estimateTokens`; `create` (cached and volatile); `resolve` (memory hit,
disk hydration, unknown uid, volatile session not surviving restart); `remove`
(memory + disk, volatile, unknown); `status` (turn count, `hasSummary`,
`contextUsage`); `appendAndMaybeCompress` (appends turns, returns 0–100 usage,
triggers summarisation, never re-summarises existing summary turn, respects
keep-recent window, resets usage after compression, disk write policy, throws on
unknown uid, passes existing summary to chatFn on second compression).

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
| `queue`         | `createQueue` with real p-queue, controlled concurrency       |

**Note on the 429 test:**

Testing queue exhaustion via HTTP requires care to avoid dangling promises. The
approach used here is `maxSize: 0` — every `enqueue()` call throws synchronously
before any async work begins, so there is nothing pending when the test returns.
This is a valid test of the route's error-handling path. The underlying queue
behaviour (filling up under real concurrency) is covered separately in
`queue.test.js`.

Covers: `GET /status`; `POST /unload`; `POST /chat` (valid prompt, history
forwarding, missing prompt → 400, full queue → 429); `POST /context_chat` (new
session with uid + reply + context_usage, volatile notice, no notice when cached,
session resumption by uid, unknown uid → 404); `DELETE /context_chat/:uid`
(success, unknown → 404); `GET /context_chat/:uid` (status snapshot, unknown →
404).

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
