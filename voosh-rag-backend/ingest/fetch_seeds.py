# fetch_seeds.py  -> collects article URLs from multiple RSS feeds (BBC + Reuters),

import requests
from bs4 import BeautifulSoup
from pathlib import Path

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    )
}

# Mix of BBC and Reuters topic feeds.
FEEDS = [
    # --- BBC ---
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",

    # --- Reuters topics  ---
    "https://www.reuters.com/world/us/rss",
    "https://www.reuters.com/world/europe/rss",
    "https://www.reuters.com/world/asia-pacific/rss",
    "https://www.reuters.com/technology/rss",
    "https://www.reuters.com/business/rss",

    # --- Extra world/general ---
    "http://rss.cnn.com/rss/edition_world.rss",        # CNN World
    "https://www.aljazeera.com/xml/rss/all.xml",       # Al Jazeera All News
    "https://www.theguardian.com/world/rss",           # Guardian World
    "https://www.theguardian.com/uk/technology/rss",   # Guardian Tech

    # --- Extra tech ---
    "https://techcrunch.com/feed/",
    "https://arstechnica.com/feed/",
    "https://www.theverge.com/rss/index.xml",
    "https://www.wired.com/feed/rss",
]


def fetch_xml(url: str) -> BeautifulSoup:
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return BeautifulSoup(r.text, "lxml-xml")

def normalize_link(item) -> str | None:
    """
    RSS can be <item><link>TEXT</link> or Atom <entry><link href="..."/>.
    This returns a plain URL string or None.
    """
    link_tag = item.find("link")
    if not link_tag:
        return None
    # Atom-style
    href = link_tag.get("href")
    if href and href.startswith("http"):
        return href.strip()
    # RSS-style with text
    txt = (link_tag.text or "").strip()
    if txt.startswith("http"):
        return txt
    return None

def main(limit: int = 80):
    urls, seen = [], set()

    for feed in FEEDS:
        try:
            doc = fetch_xml(feed)
        except Exception as e:
            print(f"[skip feed] {feed} -> {e}")
            continue

        items = doc.find_all(["item", "entry"])
        added = 0
        for it in items:
            u = normalize_link(it)
            if not u or u in seen:
                continue
            seen.add(u)
            urls.append(u)
            added += 1
            if len(urls) >= limit:
                break

        print(f"[feed ok] {feed} -> +{added} (total {len(urls)})")
        if len(urls) >= limit:
            break

    # As a hard fallback, put a few section pages (ingest will filter small pages anyway)
    if not urls:
        urls = [
            "https://www.bbc.com/news",
            "https://www.bbc.com/news/technology",
            "https://www.reuters.com/technology/",
            "https://www.reuters.com/world/",
        ]

    out = Path("seed_urls.txt")
    out.write_text("\n".join(urls), encoding="utf-8")
    print(f"wrote {len(urls)} urls to {out.resolve()}")

if __name__ == "__main__":
    main(80)
