# Berlin Nights (14–17 Oct 2026)

Rate every RA Berlin event for our trip. Each event shows its 3 artists with the most
SoundCloud followers, with each one's most-played set (≥ 30 min) embedded.

- `scraper/scrape.py`: RA GraphQL → SoundCloud → `site/data/events.json` (stdlib only).
- `site/`: static app, hosted free on GitHub Pages.
- Ratings are shared through a free Supabase table (`supabase.sql`).
- `.github/workflows/build.yml`: scrapes (on push, on manual run, and daily) and deploys Pages.

## Setup
1. **Pages**: repo Settings → Pages → Source: *GitHub Actions*.
2. **Supabase** (free): new project → SQL Editor → run `supabase.sql` →
   Settings → API → put Project URL + `anon` key into `site/config.js` and push.
3. Share `https://<user>.github.io/club-decision/`.

## Keep / toss
Add `site/data/shortlist.json` with an array of event ids to keep; the rest are hidden
(toggle "Show tossed" to see them).
