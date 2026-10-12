#!/usr/bin/env python3
"""Scrape Berlin events from RA for the trip dates; for each event pick the 3
artists with the most SoundCloud followers and attach each one's most-played
set (track >= 30 min).

Writes site/data/events.json. Uses only the stdlib so it runs anywhere.
Caches artist lookups in scraper/cache.json so re-runs are cheap.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

DATES = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]
BERLIN_AREA_ID = 34
TOP_N_ARTISTS = 3
MIN_SET_MS = 30 * 60 * 1000

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "site", "data", "events.json")
CACHE = os.path.join(ROOT, "scraper", "cache.json")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(url, data=None, headers=None, retries=4):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    body = json.dumps(data).encode() if data is not None else None
    if body is not None:
        h["Content-Type"] = "application/json"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=h)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            log(f"HTTP {e.code} for {url[:120]}")
            if e.code in (401, 403):
                raise
            return None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            log(f"net error {e} for {url[:120]}")
            return None


# ---------------------------------------------------------------- RA

RA_GQL = "https://ra.co/graphql"
RA_HEADERS = {
    "Referer": "https://ra.co/events/de/berlin",
    "Origin": "https://ra.co",
    "ra-content-language": "en",
}

LISTINGS_Q = """
query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $pageSize: Int, $page: Int) {
  eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
    data {
      id
      listingDate
      event {
        __FIELDS__
      }
    }
    totalResults
  }
}
"""

FULL_FIELDS = """id title date startTime endTime contentUrl lineup attending
        venue { id name contentUrl }
        artists { id name }
        genres { name }
        images { filename }"""
MIN_FIELDS = """id title date startTime endTime contentUrl lineup
        venue { id name contentUrl }
        artists { id name }"""
_fields = [FULL_FIELDS]

ARTIST_Q = "query A($id: ID!) { artist(id: $id) { id name soundcloud } }"


def ra(query, variables):
    txt = http(RA_GQL, {"query": query, "variables": variables}, RA_HEADERS)
    if not txt:
        return None
    j = json.loads(txt)
    if j.get("errors"):
        log("RA errors:", json.dumps(j["errors"])[:400])
    return j.get("data")


def ra_events_for(date):
    events, page = [], 1
    while True:
        q = LISTINGS_Q.replace("__FIELDS__", _fields[0])
        d = ra(q, {
            "filters": {
                "areas": {"eq": BERLIN_AREA_ID},
                "listingDate": {"gte": f"{date}T00:00:00.000Z",
                                "lte": f"{date}T23:59:59.999Z"},
            },
            "pageSize": 50,
            "page": page,
        })
        if (not d or not d.get("eventListings")) and _fields[0] is FULL_FIELDS:
            log("  retrying with minimal field set")
            _fields[0] = MIN_FIELDS
            continue
        if not d or not d.get("eventListings"):
            break
        data = d["eventListings"]["data"]
        total = d["eventListings"]["totalResults"]
        events += [x["event"] for x in data if x.get("event")]
        log(f"  {date} page {page}: {len(events)}/{total}")
        if not data or len(events) >= total:
            break
        page += 1
        time.sleep(0.7)
    return events


def ordered_artists(ev):
    """Artists in billing order (first appearance in lineup text); used as tie-break."""
    arts = ev.get("artists") or []
    lineup = re.sub(r"<[^>]+>", " ", ev.get("lineup") or "").lower()

    def pos(a):
        i = lineup.find((a.get("name") or "").lower())
        return i if i >= 0 else 10 ** 9

    return sorted(arts, key=lambda a: (pos(a), arts.index(a)))


# ---------------------------------------------------------------- SoundCloud

SC_API = "https://api-v2.soundcloud.com"
_client_id = None


def sc_client_id():
    global _client_id
    if _client_id:
        return _client_id
    html = http("https://soundcloud.com/") or ""
    scripts = re.findall(r'<script[^>]+src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', html)
    for s in reversed(scripts):
        js = http(s) or ""
        m = re.search(r'client_id\s*[:=]\s*"([A-Za-z0-9]{32})"', js) or \
            re.search(r'client_id=([A-Za-z0-9]{32})', js)
        if m:
            _client_id = m.group(1)
            log("SoundCloud client_id found")
            return _client_id
    raise RuntimeError("could not find SoundCloud client_id")


def sc(path, **params):
    params["client_id"] = sc_client_id()
    url = path if path.startswith("http") else SC_API + path
    sep = "&" if "?" in url else "?"
    txt = http(url + sep + urllib.parse.urlencode(params))
    time.sleep(0.25)
    return json.loads(txt) if txt else None


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def sc_user_from_url(url):
    if not url:
        return None
    url = url.strip()
    if not url.startswith("http"):
        url = "https://soundcloud.com/" + url.lstrip("/")
    url = url.replace("://m.soundcloud", "://soundcloud").replace("://www.soundcloud", "://soundcloud")
    # keep only the profile part
    m = re.match(r"(https?://soundcloud\.com/[^/?#]+)", url)
    if not m:
        return None
    u = sc("/resolve", url=m.group(1))
    return u if u and u.get("kind") == "user" else None


def sc_user_search(name):
    res = sc("/search/users", q=name, limit=10) or {}
    n = norm(name)
    best = None
    for u in res.get("collection", []):
        cands = {norm(u.get("username")), norm(u.get("permalink")), norm(u.get("full_name"))}
        if n and n in cands:
            if not best or (u.get("followers_count") or 0) > (best.get("followers_count") or 0):
                best = u
    return best


def sc_top_set(user_id):
    best, url, pages = None, f"/users/{user_id}/tracks", 0
    params = {"limit": 200, "linked_partitioning": 1}
    while url and pages < 10:
        j = sc(url, **params)
        if not j:
            break
        for t in j.get("collection", []):
            if (t.get("duration") or 0) >= MIN_SET_MS and t.get("streamable", True):
                if not best or (t.get("playback_count") or 0) > (best.get("playback_count") or 0):
                    best = t
        url, params, pages = j.get("next_href"), {}, pages + 1
    return best


def sc_search_set(name):
    """Fallback: most played >=30min track anywhere whose title names the artist."""
    j = sc("/search/tracks", q=name, limit=50, **{"filter.duration": "epic"}) or {}
    n, best = norm(name), None
    for t in j.get("collection", []):
        if (t.get("duration") or 0) < MIN_SET_MS or n not in norm(t.get("title")):
            continue
        if not best or (t.get("playback_count") or 0) > (best.get("playback_count") or 0):
            best = t
    return best


def track_info(t, source):
    return {
        "id": t["id"],
        "title": t.get("title"),
        "url": t.get("permalink_url"),
        "minutes": round((t.get("duration") or 0) / 60000),
        "plays": t.get("playback_count"),
        "uploader": (t.get("user") or {}).get("username"),
        "source": source,  # "profile" | "search"
    }


def lookup_profile(a, cache):
    """Find the artist's SoundCloud profile (RA link first, then name search)."""
    key = str(a["id"])
    if key in cache:
        return cache[key]
    name = a["name"]
    info = {"name": name, "ra_id": a["id"], "soundcloud": None,
            "sc_id": None, "followers": None}
    try:
        d = ra(ARTIST_Q, {"id": a["id"]}) or {}
        ra_sc = (d.get("artist") or {}).get("soundcloud")
        user = sc_user_from_url(ra_sc) or sc_user_search(name)
        if user:
            info.update(soundcloud=user.get("permalink_url"), sc_id=user["id"],
                        followers=user.get("followers_count"))
    except urllib.error.HTTPError as e:
        log(f"  ! {name}: HTTP {e.code}")
        return info  # don't cache failures
    cache[key] = info
    return info


def lookup_set(info, cache):
    """Most-played >=30 min track on the profile, else best search hit."""
    key = f"set:{info['ra_id']}"
    if key in cache:
        return cache[key]
    s = None
    try:
        if info["sc_id"]:
            t = sc_top_set(info["sc_id"])
            s = track_info(t, "profile") if t else None
        if not s:
            t = sc_search_set(info["name"])
            s = track_info(t, "search") if t else None
    except urllib.error.HTTPError as e:
        log(f"  ! set {info['name']}: HTTP {e.code}")
        return None
    cache[key] = s
    return s


# ---------------------------------------------------------------- main

def main():
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    out = []
    for date in DATES:
        log(f"RA {date}")
        evs = ra_events_for(date)
        seen = set()
        for ev in evs:
            if ev["id"] in seen:
                continue
            seen.add(ev["id"])
            arts = ordered_artists(ev)
            # Top N = most SoundCloud followers; billing order breaks ties.
            profiles = [lookup_profile(a, cache) for a in arts]
            ranked = sorted(profiles, key=lambda p: -(p["followers"] or -1))
            top = []
            for p in ranked[:TOP_N_ARTISTS]:
                top.append(dict(p, set=lookup_set(p, cache)))
                log(f"    {ev['title'][:40]:40} | {p['name'][:25]:25} "
                    f"{p['followers'] or 0:>8} -> {(top[-1]['set'] or {}).get('title', '—')}")
            img = (ev.get("images") or [{}])
            out.append({
                "id": ev["id"],
                "day": date,
                "title": ev.get("title"),
                "start": ev.get("startTime"),
                "end": ev.get("endTime"),
                "venue": (ev.get("venue") or {}).get("name"),
                "url": "https://ra.co" + (ev.get("contentUrl") or f"/events/{ev['id']}"),
                "interested": ev.get("attending"),
                "genres": [g["name"] for g in ev.get("genres") or []],
                "image": img[0].get("filename") if img else None,
                "artistCount": len(arts),
                "allArtists": [a["name"] for a in arts],
                "top": top,
            })
        json.dump(cache, open(CACHE, "w"), indent=1)  # checkpoint per day
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "events": out}, open(OUT, "w"), indent=1, ensure_ascii=False)
    log(f"wrote {len(out)} events")
    if not out:
        sys.exit("no events scraped")


if __name__ == "__main__":
    main()
