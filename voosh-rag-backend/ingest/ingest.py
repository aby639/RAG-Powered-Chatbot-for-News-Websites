import os, time, requests
from bs4 import BeautifulSoup
from urllib.parse import quote
from datetime import datetime, timezone


# --- load .env from backend root so Python sees the same vars as Node ---
try:
    from pathlib import Path
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass  # if python-dotenv isn't installed, it will fall back to OS env

QDRANT_URL = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
COLLECTION = os.getenv("COLLECTION_NAME", "news")
JINA_API_KEY = os.getenv("JINA_API_KEY")
TOP_N = int(os.getenv("TOP_N", "50"))

# Upstash REST (to set ingest:lastAt so /api/stats can show it)
UPSTASH_REDIS_REST_URL = os.getenv("UPSTASH_REDIS_REST_URL")
UPSTASH_REDIS_REST_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
}

def get_news_urls(n=50):
    here = os.path.dirname(__file__)
    seed_path = os.path.join(here, "seed_urls.txt")
    print("seed path:", seed_path, "exists:", os.path.exists(seed_path))
    urls = []
    if os.path.exists(seed_path):
        with open(seed_path, "r", encoding="utf-8") as f:
            for line in f:
                u = line.strip()
                if u.startswith("http"):
                    urls.append(u)
                    if len(urls) >= n: break
    if not urls:
        urls = [
            "https://www.bbc.com/news/technology-67213976",
            "https://www.bbc.com/news/world-67217115",
            "https://www.bbc.com/news/business-67221118",
            "https://www.reuters.com/technology/ai-meta-openai-google-2024-07-01/",
            "https://www.reuters.com/world/us/ftc-ai-regulation-2024-06-28/",
        ]
    return urls[:n]

def fetch_article(url):
    try:
        html = requests.get(url, headers=HEADERS, timeout=25).text
        soup = BeautifulSoup(html, "html.parser")
        h1 = soup.find("h1")
        title = h1.get_text(strip=True) if h1 else url
        paras = [p.get_text(" ", strip=True) for p in soup.find_all("p")]
        text = " ".join(paras)
        if len(text) < 300: 
            print(f"[skip small] {url}")
            return None, None
        return title, text
    except Exception as e:
        print("skip", url, e); return None, None

def chunk_text(t, max_chars=1200):
    return [t[i:i+max_chars] for i in range(0, len(t), max_chars)]

def embed(texts):
    url = "https://api.jina.ai/v1/embeddings"
    headers = {"Authorization": f"Bearer {JINA_API_KEY}", "Content-Type": "application/json"}
    body = {"model":"jina-embeddings-v3","input":texts}
    r = requests.post(url, headers=headers, json=body, timeout=60)
    r.raise_for_status()
    return [d["embedding"] for d in r.json()["data"]]

def ensure_collection(vector_size):
    headers = {"api-key": QDRANT_API_KEY, "Content-Type":"application/json"}
    info = requests.get(f"{QDRANT_URL}/collections/{COLLECTION}", headers=headers, timeout=20)
    if info.status_code == 200: 
        return
    body = {"vectors": {"size": vector_size, "distance":"Cosine"}}
    r = requests.put(f"{QDRANT_URL}/collections/{COLLECTION}", headers=headers, json=body, timeout=30)
    r.raise_for_status()

def upsert(points):
    headers = {"api-key": QDRANT_API_KEY, "Content-Type":"application/json"}
    body = {"points": points}
    r = requests.put(f"{QDRANT_URL}/collections/{COLLECTION}/points", headers=headers, json=body, timeout=120)
    r.raise_for_status()

def set_last_ingest():
    """Record a timestamp in Upstash so /api/stats can display it."""
    if not (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN):
        print("[warn] Upstash REST not configured; skipping lastIngestAt")
        return
    
    ts = datetime.now(timezone.utc).isoformat()

    url = f"{UPSTASH_REDIS_REST_URL}/set/{quote('ingest:lastAt', safe='')}/{quote(ts, safe='')}"
    r = requests.post(url, headers={"Authorization": f"Bearer {UPSTASH_REDIS_REST_TOKEN}"}, timeout=15)
    if r.status_code // 100 == 2:
        print("[ok] set ingest:lastAt =", ts)
    else:
        print("[warn] failed to set lastIngestAt:", r.status_code, r.text[:200])

def main():
    assert QDRANT_URL and QDRANT_API_KEY and JINA_API_KEY, "Missing QDRANT/JINA envs"
    urls = get_news_urls(TOP_N)
    print("urls:", len(urls))
    points, pid = [], 1
    total_chunks = 0

    for url in urls:
        title, text = fetch_article(url)
        if not text: 
            continue
        chunks = chunk_text(text)
        vecs = embed(chunks)
        if not vecs: 
            continue
        ensure_collection(len(vecs[0]))
        for chunk, vec in zip(chunks, vecs):
            points.append({"id": pid, "vector": vec, "payload": {"url": url, "title": title, "chunk": chunk}})
            pid += 1
            total_chunks += 1
        if len(points) >= 100:
            upsert(points); points = []; time.sleep(0.1)

    if points:
        upsert(points)

    print(f"done: {total_chunks} chunks indexed into '{COLLECTION}'")
    set_last_ingest()

if __name__ == "__main__":
    main()
