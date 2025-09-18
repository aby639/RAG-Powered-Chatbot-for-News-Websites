import React, { useEffect, useMemo, useRef, useState } from "react";
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8080";

/* ---------- tiny fetch helper ---------- */
async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ---------- bits ---------- */
const TypingDots = () => (
  <span className="typing"><span></span><span></span><span></span></span>
);

function useAutoscroll(key) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [key]);
  return ref;
}

function SourceCard({ url, title }) {
  let domain = "";
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  const fav = domain ? `https://www.google.com/s2/favicons?sz=64&domain=${domain}` : "";
  return (
    <a className="card" href={url} target="_blank" rel="noreferrer">
      {!!fav && <img className="fav" src={fav} alt="" />}
      <div className="titleLine">
        <span className="domain">{domain}</span> · {title}
      </div>
      <svg className="arrow" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M7 17L17 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
        <path d="M10 7H17V14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
      </svg>
    </a>
  );
}

function Message({ role, content, sources }) {
  const paras = useMemo(
    () => (content || "").split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>),
    [content]
  );
  return (
    <div className={`msg ${role}`}>
      <div className="avatar">{role === "assistant" ? "🤖" : "🧑"}</div>
      <div className="bubble">
        {paras}
        {!!sources?.length && (
          <div className="sources">
            {sources.map((s) => <SourceCard key={s.id} url={s.url} title={s.title} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- app ---------- */
export default function App() {
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stats, setStats] = useState({ docs: 0 });

  const scrollerRef = useAutoscroll(messages.length + (loading ? 1 : 0));

  const suggestions = ["bbc", "mining in zambia", "tottenham", "ai regulation", "uk politics"];

  async function newSession() {
    setErr("");
    const { sessionId } = await api("/api/session/new", { method: "POST" });
    setSessionId(sessionId);
    setMessages([]);
  }

  async function resetSession() {
    if (!sessionId) return;
    if (!confirm("Reset this chat?")) return;
    try { await api(`/api/reset/${sessionId}`, { method: "POST" }); } catch {}
    await newSession();
  }

  async function send(text) {
    const userText = (text ?? input).trim();
    if (!userText || !sessionId || loading) return;
    setInput("");
    setErr("");
    setMessages((m) => [...m, { role: "user", content: userText }]);
    setLoading(true);
    try {
      const data = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ sessionId, message: userText }),
      });
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.answer || "Sorry, something went wrong.", sources: data.sources || [] },
      ]);
    } catch (e) {
      console.error(e);
      setMessages((m) => [...m, { role: "assistant", content: "Sorry, something went wrong. Try again." }]);
    } finally {
      setLoading(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  useEffect(() => {
    newSession().catch(() => setErr("Could not create a session."));
    api("/api/stats").then(setStats).catch(() => {});
  }, []);

  const showScrollDown = (() => {
    const el = scrollerRef.current;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight > 300;
  })();

  return (
    <div className="app">
      <div className="bg">
        <div className="aurora">
          <span className="a1"></span><span className="a2"></span><span className="a3"></span>
        </div>
      </div>

      <header className="header">
        <div className="title">
          <span className="logo" /> Voosh News Chatbot
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <span className="badge">{stats.docs} docs</span>
          <button className="ghost" onClick={resetSession} disabled={!sessionId || loading}>Reset</button>
        </div>
      </header>

      <main className="chat" ref={scrollerRef}>
        {!messages.length && (
          <div className="empty">
            <h1>Ask about today’s news</h1>
            <div className="suggests">
              {suggestions.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <Message key={i} role={m.role} content={m.content} sources={m.sources} />
        ))}

        {loading && (
          <div className="msg assistant">
            <div className="avatar">🤖</div>
            <div className="bubble"><TypingDots/></div>
          </div>
        )}
      </main>

      {showScrollDown && (
        <button className="fab" title="Jump to latest"
          onClick={() => scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior:"smooth" })}>
          ↓
        </button>
      )}

      <footer className="composer">
        <div className={`inputWrap ${loading ? "disabled" : ""}`}>
          <textarea
            value={input}
            onChange={(e)=>setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask about the news…"
            rows={1}
            disabled={loading}
          />
          <button className="send" onClick={()=>send()} disabled={loading || !input.trim()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {err && <div className="error">{err}</div>}
      </footer>
    </div>
  );
}
