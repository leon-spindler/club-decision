(() => {
  const DAYS = [
    ["2026-10-14", "Wed 14"], ["2026-10-15", "Thu 15"],
    ["2026-10-16", "Fri 16"], ["2026-10-17", "Sat 17"],
  ];
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.CONFIG || {};
  const remote = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
  const $ = (s) => document.querySelector(s);
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let events = [];
  // Curation mode: shows a Remove button on each event. Set to false before sharing.
  const EDIT_MODE = false;
  const REMOVED = "__removed__"; // pseudo-user in the ratings table marking removed events
  let shortlist = null; // array of event ids to keep, or null = show all
  let removed = new Set(); // event ids (strings) removed in curation mode
  let ratings = {};     // ratings[eventId][user] = stars
  let me = store.get("name", "");
  let day = store.get("day", DAYS[0][0]);

  // ------------------------------------------------------------ backend
  const api = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      // Legacy JWT anon keys also go in Authorization; new sb_publishable_ keys must not.
      ...(SUPABASE_ANON_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } : {}),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  }).then((r) => { if (!r.ok) throw new Error(r.status); return r; });

  async function loadRatings() {
    if (!remote) {
      ratings = store.get("ratings", {});
      removed = new Set(store.get("removed", []));
      return;
    }
    const rows = await (await api("ratings?select=user_name,event_id,stars")).json();
    const next = {}, gone = new Set();
    for (const r of rows) {
      if (r.user_name === REMOVED) gone.add(r.event_id);
      else (next[r.event_id] ||= {})[r.user_name] = r.stars;
    }
    ratings = next;
    removed = gone;
  }

  async function saveRating(eventId, stars) {
    const prev = ratings[eventId]?.[me];
    if (stars) (ratings[eventId] ||= {})[me] = stars;
    else if (ratings[eventId]) delete ratings[eventId][me];
    refreshRates();
    if (!remote) { store.set("ratings", ratings); return; }
    try {
      if (stars) {
        await api("ratings?on_conflict=user_name,event_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_name: me, event_id: String(eventId), stars }),
        });
      } else {
        await api(`ratings?user_name=eq.${encodeURIComponent(me)}&event_id=eq.${eventId}`, { method: "DELETE" });
      }
      status();
    } catch (e) {
      if (prev) ratings[eventId][me] = prev; else if (ratings[eventId]) delete ratings[eventId][me];
      refreshRates();
      status(`Couldn't save (${e.message}) — try again`, true);
    }
  }

  async function toggleRemoved(eventId) {
    const id = String(eventId);
    const wasRemoved = removed.has(id);
    wasRemoved ? removed.delete(id) : removed.add(id);
    render();
    if (!remote) { store.set("removed", [...removed]); return; }
    try {
      if (wasRemoved) {
        await api(`ratings?user_name=eq.${REMOVED}&event_id=eq.${id}`, { method: "DELETE" });
      } else {
        await api("ratings?on_conflict=user_name,event_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_name: REMOVED, event_id: id, stars: 1 }),
        });
      }
    } catch (e) {
      wasRemoved ? removed.add(id) : removed.delete(id);
      render();
      status(`Couldn't save (${e.message}) — try again`, true);
    }
  }

  // ------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const time = (iso) => iso ? iso.slice(11, 16) : "";
  const fmt = (n) => n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  const avg = (id) => {
    const v = Object.values(ratings[id] || {});
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const kept = (e) => !removed.has(String(e.id)) &&
    (!shortlist || shortlist.includes(e.id) || shortlist.includes(String(e.id)));

  function status(msg, warn) {
    const el = $("#status");
    el.className = "status" + (warn ? " warn" : "");
    el.textContent = msg ?? (remote
      ? `Shared ratings · ${new Set(Object.values(ratings).flatMap(Object.keys)).size} people rating`
      : "Local-only mode: ratings stay in this browser (set up Supabase in config.js to share).");
  }

  // ------------------------------------------------------------ render
  function visible() {
    const q = $("#q").value.trim().toLowerCase();
    const showAll = $("#allEvents").checked;
    let list = events.filter((e) => e.day === day && (showAll || kept(e)));
    if (q) list = list.filter((e) =>
      [e.title, e.venue, ...(e.allArtists || [])].join(" ").toLowerCase().includes(q));
    if ($("#unrated").checked) list = list.filter((e) => !ratings[e.id]?.[me]);
    const sort = $("#sort").value;
    const by = {
      interest: (e) => -(e.interested || 0),
      group: (e) => -(avg(e.id) ?? -1),
      mine: (e) => -(ratings[e.id]?.[me] ?? -1),
    }[sort];
    if (by) list = [...list].sort((a, b) => by(a) - by(b));
    return list;
  }

  function renderDays() {
    $("#days").innerHTML = DAYS.map(([d, label]) => {
      const evs = events.filter((e) => e.day === d && kept(e));
      const done = evs.filter((e) => ratings[e.id]?.[me]).length;
      return `<button data-day="${d}" class="${d === day ? "on" : ""}">
        <b>${label}</b><small>${done}/${evs.length} rated</small></button>`;
    }).join("");
  }

  function artistHTML(a) {
    const s = a.set;
    return `<div class="art">
      <div class="row">
        <button class="play" ${s ? `data-track="${s.id}"` : "disabled"} title="${s ? "Play set" : "No 30+ min set found"}">▶</button>
        <div class="info">
          <div class="name">${esc(a.name)}
            ${a.soundcloud ? `<a class="small" href="${esc(a.soundcloud)}" target="_blank" rel="noopener">SoundCloud ↗</a>` : ""}
            ${a.followers != null ? `<span class="small">· ${fmt(a.followers)} followers</span>` : ""}
          </div>
          <div class="set">${s
            ? `${esc(s.title)} · ${s.minutes} min · ${fmt(s.plays)} plays${s.source === "search" ? ` · <i>by ${esc(s.uploader)}</i>` : ""}`
            : "No set found"}</div>
        </div>
      </div>
    </div>`;
  }

  function eventHTML(e) {
    const rest = (e.allArtists || []).filter((n) => !e.top.some((t) => t.name === n));
    const img = e.image ? (e.image.startsWith("http") ? e.image : `https://imgproxy.ra.co/_/quality:66/w:200/rt:fill/plain/${e.image}`) : "";
    return `<article class="ev ${kept(e) ? "" : "tossed"}" data-id="${e.id}">
      <div class="head">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <div class="meta">
          ${EDIT_MODE ? `<button class="toss" data-toss>${kept(e) ? "✕ Remove" : "↺ Restore"}</button>` : ""}
          <h3><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a></h3>
          <div class="venue">${esc(e.venue)}</div>
          <div class="small">${time(e.start)}${e.end ? "–" + time(e.end) : ""}${e.interested ? ` · ${e.interested} interested on RA` : ""} · ${e.artistCount} artists</div>
          <div class="tags">${(e.genres || []).map((g) => `<span>${esc(g)}</span>`).join("")}</div>
        </div>
      </div>
      ${e.top.length ? `<div class="artists">${e.top.map(artistHTML).join("")}</div>` : ""}
      ${rest.length ? `<div class="more">Also: ${rest.map(esc).join(", ")}</div>` : ""}
      <div class="rate">${rateHTML(e)}</div>
    </article>`;
  }

  function rateHTML(e) {
    const mine = ratings[e.id]?.[me] || 0;
    const others = Object.entries(ratings[e.id] || {});
    const a = avg(e.id);
    return `
        <div class="stars">${[1, 2, 3, 4, 5].map((n) =>
          `<button data-stars="${n}" class="${n <= mine ? "on" : ""}" aria-label="${n} stars">★</button>`).join("")}</div>
        <div class="group" title="${esc(others.map(([u, s]) => `${u}: ${s}★`).join("\n"))}">
          ${a != null ? `Group <b>${a.toFixed(1)}★</b> · ${others.length} rating${others.length > 1 ? "s" : ""}` : "No ratings yet"}
        </div>`;
  }

  function render() {
    $("#shortWrap").hidden = !shortlist && !(EDIT_MODE && removed.size);
    $("#shortLabel").textContent = `Show removed (${events.filter((e) => !kept(e)).length})`;
    renderDays();
    const list = visible();
    $("#list").innerHTML = list.length ? list.map(eventHTML).join("")
      : `<div class="empty">${events.length ? "Nothing here." : "No events loaded yet."}</div>`;
    $("#who").textContent = me ? `👤 ${me}` : "Set name";
  }

  // Update only the rating bars so open SoundCloud players keep playing.
  function refreshRates() {
    renderDays();
    const byId = Object.fromEntries(events.map((e) => [String(e.id), e]));
    document.querySelectorAll(".ev").forEach((el) => {
      const e = byId[el.dataset.id];
      if (e) el.querySelector(".rate").innerHTML = rateHTML(e);
    });
  }

  function openPlayer(btn) {
    const art = btn.closest(".art");
    const existing = art.querySelector("iframe");
    if (existing) { existing.remove(); btn.textContent = "▶"; return; }
    const src = "https://w.soundcloud.com/player/?url=" +
      encodeURIComponent(`https://api.soundcloud.com/tracks/${btn.dataset.track}`) +
      `&color=%23ff3d7f&auto_play=true&hide_related=true&show_comments=false&show_reposts=false&visual=false`;
    art.insertAdjacentHTML("beforeend", `<iframe allow="autoplay" src="${src}"></iframe>`);
    btn.textContent = "✕";
  }

  // ------------------------------------------------------------ events
  $("#days").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-day]");
    if (!b) return;
    day = b.dataset.day; store.set("day", day);
    render(); window.scrollTo(0, 0);
  });
  $("#list").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-toss]")) return toggleRemoved(ev.target.closest(".ev").dataset.id);
    const play = ev.target.closest(".play[data-track]");
    if (play) return openPlayer(play);
    const star = ev.target.closest("[data-stars]");
    if (star) {
      if (!me) return askName();
      const id = star.closest(".ev").dataset.id;
      const n = +star.dataset.stars;
      saveRating(id, ratings[id]?.[me] === n ? 0 : n); // click same star again to clear
    }
  });
  for (const id of ["#q", "#sort", "#unrated", "#allEvents"]) $(id).addEventListener("input", render);
  $("#who").addEventListener("click", askName);

  function askName() {
    $("#nameIn").value = me;
    $("#nameDlg").showModal();
  }
  $("#nameDlg").addEventListener("close", () => {
    const v = $("#nameIn").value.trim();
    if (v) { me = v; store.set("name", me); render(); status(); }
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      const data = await (await fetch("data/events.json", { cache: "no-cache" })).json();
      events = data.events || [];
    } catch { status("Couldn't load events.json", true); }
    try {
      const r = await fetch("data/shortlist.json", { cache: "no-cache" });
      if (r.ok) shortlist = await r.json();
    } catch {}
    try { await loadRatings(); status(); } catch (e) { status(`Couldn't load ratings (${e.message})`, true); }
    render();
    if (!me) askName();
    if (remote) setInterval(async () => {
      if (document.hidden) return;
      try { await loadRatings(); refreshRates(); status(); } catch {}
    }, 20000);
  }
  boot();
})();
