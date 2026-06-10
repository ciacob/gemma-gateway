# gemma-gateway

A resident Fastify process that proxies text, image, and audio requests to a
local Gemma 4 model running in Ollama. The model is booted on first request,
kept alive for a configurable TTL, and unloaded when idle. Requests beyond the
concurrency limit queue up instead of choking Ollama.

Stateful conversation is supported via `/context_chat`, which manages session
history automatically — including transparent compression via summarisation when
the context window fills up.

---

## Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com) installed and running
- `ollama pull gemma4:e4b` (or whichever model you set in `.env`)
- PM2 installed globally: `npm install -g pm2`

---

## Setup

```bash
npm install
cp .env .env.local   # tweak if needed
```

Key `.env` knobs:

| Variable                         | Default    | Meaning                                                        |
|----------------------------------|------------|----------------------------------------------------------------|
| `OLLAMA_MODEL`                   | gemma4:e4b | Which model tag to use                                         |
| `MODEL_KEEP_ALIVE_SECONDS`       | 300        | Ollama keeps model in VRAM for this long                       |
| `IDLE_TTL_SECONDS`               | 360        | Server unloads model after this much inactivity                |
| `QUEUE_CONCURRENCY`              | 1          | Parallel requests sent to Ollama                               |
| `QUEUE_MAX_SIZE`                 | 20         | Max queued requests before 429                                 |
| `SESSION_CACHE_DIR`              | sessions/  | Directory where cached session files are stored                |
| `MODEL_CONTEXT_TOKENS`           | 131072     | Model context window size in tokens (128K for gemma4:e4b)      |
| `CONTEXT_SUMMARIZE_THRESHOLD`    | 70         | % of context window that triggers history summarisation        |
| `CONTEXT_SUMMARY_KEEP_RECENT`    | 10         | Recent raw turns kept verbatim during summarisation            |

---

## Running

### Development (auto-restart on file change)
```bash
npm run dev
```

### Tests
```bash
npm test
```

See [README-tests.md](README-tests.md) for a full description of the test suite.

### Production via PM2
```bash
npm run pm2:start          # start
npm run pm2:logs           # tail logs
npm run pm2:monit          # live dashboard
npm run pm2:restart        # rolling restart
npm run pm2:stop           # stop

# persist across reboots
pm2 save
pm2 startup                # follow the printed instruction
```

---

## API

### GET /status
```bash
curl http://localhost:3000/status
```
```json
{
  "model": { "state": "ready", "idleTtlSeconds": 360, "idleTimerActive": true },
  "queue": { "pending": 0, "running": 1, "concurrency": 1, "maxSize": 20 }
}
```

---

### POST /chat — stateless text prompt

Context is managed entirely by the caller via the optional `history` array.
For automatic context management use `/context_chat` instead.

```bash
curl http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Explain the difference between TCP and UDP in two sentences."}'
```

With conversation history:
```bash
curl http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "What did I just ask you?",
    "history": [
      {"role": "user",      "content": "Explain TCP vs UDP."},
      {"role": "assistant", "content": "TCP is reliable and ordered..."}
    ]
  }'
```

---

### POST /chat/stream — streaming SSE
```bash
curl -N http://localhost:3000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Write a haiku about distributed systems."}'
```
Each event:  `data: {"token":"..."}`
Final event: `data: [DONE]`

---

### POST /imagine — image understanding
```bash
curl http://localhost:3000/imagine \
  -F 'image=@/path/to/photo.jpg' \
  -F 'prompt=What objects are visible in this image?'
```

Default prompt (omit `-F prompt`) is `"Describe this image."`

---

### POST /transcribe — audio transcription
```bash
curl http://localhost:3000/transcribe \
  -F 'audio=@/path/to/recording.wav' \
  -F 'prompt=Transcribe this audio accurately.'
```

Supported formats: WAV, MP3, FLAC, OGG.

---

### POST /unload — evict model immediately
```bash
curl -X POST http://localhost:3000/unload
```
Useful before a long idle period to free memory.

---

### POST /context_chat — stateful chat with automatic context management

Maintains conversation history server-side. On first call a session is created
and a `uid` returned; subsequent calls pass that `uid` to resume the conversation.
History is persisted to disk by default so sessions survive server restarts.

When accumulated history approaches the model's context window, the oldest turns
are automatically summarised inline by the model itself and replaced by a single
compressed turn. The response always includes a `context_usage` percentage so
callers can monitor memory pressure.

**Create a new session (cached to disk by default):**
```bash
curl http://localhost:3000/context_chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "My name is Alex and I am debugging a Rust async runtime."}'
```
```json
{
  "uid": "3f2a1b...",
  "reply": "Hello Alex! What aspect of the async runtime are you looking into?",
  "context_usage": 2
}
```

**Resume the session:**
```bash
curl http://localhost:3000/context_chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "What is my name?", "uid": "3f2a1b..."}'
```

**Create a volatile session (in-memory only, lost on restart):**
```bash
curl http://localhost:3000/context_chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Hello", "cache": false}'
```
A `notice` field in the response confirms the session is volatile.

**Request fields:**

| Field    | Type    | Required | Default | Description                                   |
|----------|---------|----------|---------|-----------------------------------------------|
| `prompt` | string  | yes      | —       | The user's message                            |
| `uid`    | string  | no       | —       | Session ID to resume; 404 if not found        |
| `cache`  | boolean | no       | `true`  | Persist session to disk                       |

**Response fields:**

| Field           | Type   | Description                                              |
|-----------------|--------|----------------------------------------------------------|
| `uid`           | string | Session ID (pass this back to continue the conversation) |
| `reply`         | string | The model's response                                     |
| `context_usage` | number | 0–100% of the summarisation threshold consumed           |
| `notice`        | string | Present only on new volatile sessions                    |

---

### GET /context_chat/:uid — inspect session

```bash
curl http://localhost:3000/context_chat/3f2a1b...
```
```json
{
  "uid": "3f2a1b...",
  "cached": true,
  "turns": 6,
  "hasSummary": false,
  "contextUsage": 18,
  "createdAt": 1718000000000,
  "updatedAt": 1718000500000
}
```

`hasSummary: true` means at least one round of compression has occurred.
History content is never exposed by this endpoint.

---

### DELETE /context_chat/:uid — delete session

Removes the session from memory and from disk (if cached).

```bash
curl -X DELETE http://localhost:3000/context_chat/3f2a1b...
```
```json
{ "ok": true, "uid": "3f2a1b...", "deleted": true }
```

---

## Context management and summarisation

Each `context_chat` session accumulates turns as `{role, content}` objects.
After every exchange, the server estimates the token count of the full history
(using a ~4 chars/token heuristic for the Gemma family) and compares it against
`CONTEXT_SUMMARIZE_THRESHOLD` percent of `MODEL_CONTEXT_TOKENS`.

When the threshold is crossed, the server runs a summarisation pass **inline**
(the current request waits for it) before returning a response. The process:

1. The most recent `CONTEXT_SUMMARY_KEEP_RECENT` raw turns are set aside verbatim.
2. All older raw turns are sent to the model with a compression prompt.
3. The result replaces those turns as a single `role: "summary"` turn at the head
   of the history.
4. Any existing summary turn is incorporated into the new one rather than
   re-summarised — there is always at most one summary turn in a session.

The `context_usage` value in the response resets to a lower percentage after
compression, reflecting the reduced token count of the compressed history.

---

## Architecture

```
Client
  │
  ▼
Fastify (server.js)
  │  validates & parses multipart/JSON
  ▼
routes.js  ──►  queue.js (p-queue, concurrency=1, cap=20)
                    │
                    ▼
              modelManager.js   ←── idle TTL timer
                    │  ensureLoaded() / touch()
                    ▼
              ollama.js  ──HTTP──►  Ollama :11434
                                        │
                                    gemma4:e4b

routes.js  ──►  sessions.js  ──►  disk (sessions/*.json)
               (context_chat)
```

**State machine (ModelManager):**
```
UNLOADED → LOADING → READY → UNLOADING → UNLOADED
              ↑                              │
              └──────────── (next request) ──┘
```
The idle timer fires after `IDLE_TTL_SECONDS` of no `touch()` calls, which
drives the `READY → UNLOADING → UNLOADED` transition.
