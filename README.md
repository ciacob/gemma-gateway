# gemma-gateway

A resident Fastify process that proxies text, image, and audio requests to a
local Gemma 4 model running in Ollama.  The model is booted on first request,
kept alive for a configurable TTL, and unloaded when idle.  Requests beyond the
concurrency limit queue up instead of choking Ollama.

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

| Variable                  | Default | Meaning                                          |
|---------------------------|---------|--------------------------------------------------|
| `OLLAMA_MODEL`            | gemma4:e4b | Which model tag to use                        |
| `MODEL_KEEP_ALIVE_SECONDS`| 300     | Ollama keeps model in VRAM for this long         |
| `IDLE_TTL_SECONDS`        | 360     | Server unloads model after this much inactivity  |
| `QUEUE_CONCURRENCY`       | 1       | Parallel requests sent to Ollama                 |
| `QUEUE_MAX_SIZE`          | 20      | Max queued requests before 429                   |

---

## Running

### Development (auto-restart on file change)
```bash
npm run dev
```

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

### POST /chat — text prompt
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
```

**State machine (ModelManager):**
```
UNLOADED → LOADING → READY → UNLOADING → UNLOADED
              ↑                              │
              └──────────── (next request) ──┘
```
The idle timer fires after `IDLE_TTL_SECONDS` of no `touch()` calls, which
drives the `READY → UNLOADING → UNLOADED` transition.
