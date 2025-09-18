// src/server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { Redis as UpstashRedis } from '@upstash/redis' // REST client

/* ---------------- App & config ---------------- */
const app = express()
const PORT = process.env.PORT || 8080
const ORIGIN = process.env.ORIGIN || '*'
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'news'
const TOP_K = parseInt(process.env.TOP_K || '5', 10)

// LLM reliability knobs (retry only — still strict RAG)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL  = process.env.GEMINI_MODEL  || 'gemini-1.5-flash-latest'
const LLM_RETRIES   = parseInt(process.env.LLM_RETRIES  || '3', 10)
const LLM_RETRY_MS  = parseInt(process.env.LLM_RETRY_MS || '800', 10)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

app.use(cors({ origin: ORIGIN, credentials: true }))
app.use(express.json())

/* ---------------- Redis (REST → TCP → memory) ---------------- */
let redis // exposes rpush/lrange/expire/del/get/set
const mem = new Map()

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const r = new UpstashRedis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
  redis = {
    rpush: (k, v) => r.rpush(k, v),
    lrange: (k, s, e) => r.lrange(k, s, e),
    expire: (k, sec) => r.expire(k, sec),
    del: (k) => r.del(k),
    get: (k) => r.get(k),
    set: (k, v) => r.set(k, v),
  }
  console.log('Redis: Upstash REST client')
} else if (process.env.REDIS_URL) {
  const { default: IORedis } = await import('ioredis')
  const r = new IORedis(process.env.REDIS_URL, {
    tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    maxRetriesPerRequest: 3,
    connectTimeout: 10_000,
    retryStrategy: (times) => Math.min(times * 1000, 5000),
  })
  redis = r
  console.log('Redis: ioredis TCP client')
} else {
  console.warn('Redis: not configured — using in-memory store (demo only)')
  redis = {
    async rpush(k, v) {
      const arr = mem.get(k) || []
      arr.push(v); mem.set(k, arr); return arr.length
    },
    async lrange(k, s, e) {
      const arr = mem.get(k) || []
      const end = e === -1 ? arr.length : e + 1
      return arr.slice(s, end)
    },
    async expire() { return true },
    async del(k) { mem.delete(k); return 1 },
    async get(k) { return mem.get(k) ?? null },
    async set(k, v) { mem.set(k, v); return 'OK' },
  }
}

/* ---------------- Chat history helpers ---------------- */
const key = (id) => `session:${id}:messages`
const TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

async function pushMsg(id, role, content, extra = {}) {
  const msg = JSON.stringify({ role, content, ts: Date.now(), ...extra })
  await redis.rpush(key(id), msg)
  await redis.expire(key(id), TTL_SECONDS)
}

async function getHistory(id) {
  const arr = await redis.lrange(key(id), 0, -1)
  return arr.map((x) => (typeof x === 'string' ? JSON.parse(x) : x))
}

async function resetSession(id) {
  await redis.del(key(id))
}

/* ---------------- Qdrant + Jina ---------------- */
const QDRANT_URL = process.env.QDRANT_URL
const QDRANT_API_KEY = process.env.QDRANT_API_KEY

async function embed(texts) {
  const url = 'https://api.jina.ai/v1/embeddings'
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.JINA_API_KEY || ''}`,
  }
  const body = { model: 'jina-embeddings-v3', input: texts }
  const { data } = await axios.post(url, body, { headers })
  return data.data.map((d) => d.embedding)
}

async function qdrantSearch(query, topK = TOP_K) {
  if (!QDRANT_URL || !QDRANT_API_KEY) throw new Error('Missing Qdrant config')
  const [vec] = await embed([query])
  const url = `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`
  const headers = { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY }
  const body = { vector: vec, limit: topK, with_payload: true }
  const { data } = await axios.post(url, body, { headers })
  return (data?.result || []).map((r) => ({
    score: r.score,
    title: r.payload?.title,
    url: r.payload?.url,
    chunk: r.payload?.chunk,
  }))
}

async function qdrantCount() {
  if (!QDRANT_URL || !QDRANT_API_KEY) throw new Error('Missing Qdrant config')
  const url = `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/count`
  const headers = { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY }
  const body = { exact: true }
  const { data } = await axios.post(url, body, { headers })
  return data?.result?.count ?? 0
}

/* ---------------- Gemini (retry only) ---------------- */
async function askGeminiRaw(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
  const { data } = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } })
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function askGemini(prompt) {
  let delay = LLM_RETRY_MS
  for (let i = 0; i < LLM_RETRIES; i++) {
    try {
      return await askGeminiRaw(prompt)
    } catch (err) {
      const status = err?.response?.status
      const code = err?.response?.data?.error?.code
      if (status === 429 || status === 503 || code === 429 || code === 503) {
        if (i < LLM_RETRIES - 1) {
          await sleep(delay + Math.floor(Math.random() * 250))
          delay *= 2
          continue
        }
      }
      throw err
    }
  }
  throw new Error('llm_unavailable')
}

function buildPrompt(query, passages) {
  const ctx = passages
    .map((p, i) => `# Source ${i + 1} (${p.title})\n${p.chunk}\nURL: ${p.url}`)
    .join('\n\n')
  return `You are a news assistant. Use ONLY the context below. If the answer is unknown, say you are unsure.

## Context
${ctx}

## Task
Question: ${query}
Answer clearly with citations like [S1], [S2] referring to the numbered sources.`
}

// Optional: graceful message if LLM is still unavailable after retries
function busyFallback(query, passages) {
  const list = passages.slice(0, 5).map((p, i) => `• [S${i + 1}] ${p.title}`).join('\n')
  return `The model is busy right now. Here are relevant sources for “${query}”:\n\n${list}`
}

/* ---------------- Routes ---------------- */
app.get('/health', (_, res) => res.json({ ok: true }))

app.post('/api/session/new', (_, res) => {
  const id = uuidv4()
  res.json({ sessionId: id })
})

app.get('/api/history/:id', async (req, res) => {
  try {
    const history = await getHistory(req.params.id)
    res.json({ messages: history })
  } catch (e) {
    console.error('history_failed:', e?.response?.data || e.message)
    res.status(500).json({ error: 'history_failed' })
  }
})

app.post('/api/reset/:id', async (req, res) => {
  try {
    await resetSession(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    console.error('reset_failed:', e?.response?.data || e.message)
    res.status(500).json({ error: 'reset_failed' })
  }
})

// Aliases for convenience
app.get('/api/session/:id/history', (req, res) =>
  res.redirect(307, `/api/history/${req.params.id}`))
app.post('/api/session/:id/reset', (req, res) =>
  res.redirect(307, `/api/reset/${req.params.id}`))

// Stats (doc count + last ingest time if present)
app.get('/api/stats', async (_, res) => {
  try {
    const docs = await qdrantCount()
    let lastIngestAt = null
    try {
      if (redis.get) lastIngestAt = await redis.get('ingest:lastAt')
    } catch (_) { /* no-op for memory */ }
    res.json({ docs, lastIngestAt })
  } catch (e) {
    console.error('stats_failed:', e?.response?.data || e.message)
    res.status(500).json({ error: 'stats_failed' })
  }
})

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId & message required' })
    }

    await pushMsg(sessionId, 'user', message)

    // STRICT RAG: always retrieve → prompt with ONLY context
    const passages = await qdrantSearch(message, TOP_K)
    const prompt = buildPrompt(message, passages)

    let answer
    try {
      const raw = await askGemini(prompt)
      answer = raw?.trim() || `I am unsure. None of the provided text answers that.`
    } catch (e) {
      console.warn('LLM failed:', e?.response?.data || e.message)
      answer = busyFallback(message, passages)
    }

    const sources = passages.map((p, i) => ({ id: i + 1, title: p.title, url: p.url }))

    await pushMsg(sessionId, 'assistant', answer)
    res.json({ answer, sources })
  } catch (e) {
    console.error('chat_failed:', e?.response?.data || e.message)
    res.status(500).json({ error: 'chat_failed', detail: e.message })
  }
})

app.get('/', (_, res) => res.send('Voosh RAG backend is running'))

app.listen(PORT, () => {
  console.log(`server on http://localhost:${PORT}`)
})
