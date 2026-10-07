// MusicalWork card — a Tier-2 component shipped in the pack, beside the MusicalWork
// type. Loaded by /apps/entities.html when an entity's type is "MusicalWork". Uses the
// shared fragment helper (config/apps/entity-card.js); no framework.
//
// Contract:
//   default — the visual (HTML fragment + scoped styles + bind hook).
//
// MusicalWork.fields: title, subtitle, composer, genre, workId, searchQuery.

import { cardComponent } from '/apps/world/entity-card.js';

const styles = `
  .work{display:flex;flex-direction:column;gap:9px;font-family:'Inter',system-ui,sans-serif;}
  .work-top{display:flex;gap:12px;align-items:flex-start;}
  .work-play{position:relative;width:46px;height:46px;flex:0 0 auto;border-radius:50%;display:flex;align-items:center;
    justify-content:center;font-size:18px;text-decoration:none;color:#d8b27a;overflow:hidden;
    border:1px solid rgba(216,178,122,.35);background:linear-gradient(160deg,rgba(216,178,122,.18),rgba(216,178,122,.04));
    transition:background .15s;}
  .work-play:hover{background:rgba(216,178,122,.22);}
  .work-title{font-size:16px;font-weight:600;color:#fff;line-height:1.15;}
  .work-sub{font-family:'JetBrains Mono',monospace;font-size:11px;color:#d8b27a;margin-top:3px;letter-spacing:.04em;}
  .work-composer{font-size:12.5px;color:#b9b3a3;}
  .work-composer b{color:#f4f4f4;font-weight:500;}
  .work-genres{display:flex;flex-wrap:wrap;gap:5px;}
  .work-genre{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#d8b27a;
    background:rgba(216,178,122,.10);border:1px solid rgba(216,178,122,.28);border-radius:999px;padding:2px 7px;}
  .wr-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px;}
  .wr-stars{display:inline-flex;gap:1px;}
  .wr-star{cursor:pointer;color:#3a3a44;font-size:16px;line-height:1;transition:color .1s;}
  .wr-star.wr-on{color:#d8b27a;}
  .wr-label{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8b8b96;min-width:34px;}
  .wr-note-toggle{background:none;border:0;color:#63c0f5;font-size:11px;cursor:pointer;padding:0;}
  .wr-note{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);
    border-radius:6px;color:#f4f4f4;font-size:12px;padding:5px 8px;margin-top:4px;font-family:inherit;}
`;

// A 1–10 star rating with a reveal-on-demand note. Recording a rating IS making the
// link: create_entry against MusicalWorkRating auto-emits (User)-[:RATED]->… and
// upserts by workId (a re-rate updates in place). Same gateway op the MusicalWork.rate
// pack method uses.
function buildRating(host, workId, title, composer, gw) {
  let current = 0, noteVal = '', me = null;
  const wrap = document.createElement('div'); wrap.className = 'wr-wrap';
  const stars = document.createElement('div'); stars.className = 'wr-stars';
  const label = document.createElement('span'); label.className = 'wr-label';
  const starEls = [];
  const paint = (n) => { starEls.forEach((s, i) => s.classList.toggle('wr-on', i < n)); label.textContent = n ? n + '/10' : 'Rate'; };
  // The current user's own Person id + name — the rater for a rating made from this card.
  const currentUser = async () => {
    if (me) return me;
    const res = await gw.kg.query({ cypher: 'MATCH (u:AssistantUser) RETURN u.id AS id, u.name AS name LIMIT 1', params: JSON.stringify({}) });
    const rows = (res && res.rows) ? res.rows : (res || []);
    me = rows[0] || {};
    return me;
  };
  const submit = async (n) => {
    current = n; paint(n); label.textContent = 'Saving…';
    try {
      const u = await currentUser();
      const raterId = u.id || '';
      await gw.repository.createEntry({
        type: 'MusicalWorkRating',
        data: {
          ratingKey: raterId + '::' + workId,
          raterId, raterName: u.name,
          workId, title, composer, rating: n,
          heardOn: new Date().toISOString().slice(0, 10), notes: noteVal || undefined,
        },
      });
      label.textContent = 'Rated ' + n + '/10 ✓';
    } catch (e) { label.textContent = 'Failed: ' + (e && e.message); }
  };
  for (let i = 1; i <= 10; i++) {
    const s = document.createElement('span'); s.className = 'wr-star'; s.textContent = '★';
    s.onmouseenter = () => paint(i);
    s.onclick = () => submit(i);
    stars.appendChild(s); starEls.push(s);
  }
  stars.onmouseleave = () => paint(current);
  wrap.appendChild(stars); wrap.appendChild(label);

  const noteToggle = document.createElement('button'); noteToggle.className = 'wr-note-toggle'; noteToggle.textContent = '+ note';
  const noteInput = document.createElement('input'); noteInput.className = 'wr-note'; noteInput.placeholder = 'one-line reaction'; noteInput.style.display = 'none';
  noteToggle.onclick = () => { const show = noteInput.style.display === 'none'; noteInput.style.display = show ? 'block' : 'none'; if (show) noteInput.focus(); };
  noteInput.oninput = () => { noteVal = noteInput.value; };
  wrap.appendChild(noteToggle); host.appendChild(wrap); host.appendChild(noteInput);
  paint(0);

  // Pre-fill the user's existing rating so re-rating starts where they left off.
  gw.kg.query({
    cypher: 'MATCH (au:AssistantUser)-[:RATED]->(r:MusicalWorkRating) WHERE r.workId = $id RETURN r.rating AS rating, r.notes AS notes LIMIT 1',
    params: JSON.stringify({ id: workId }),
  }).then((rows) => {
    const list = (rows && rows.rows) ? rows.rows : rows;
    const row = list && list[0];
    if (row && row.rating) {
      current = Number(row.rating); paint(current);
      if (row.notes) { noteVal = String(row.notes); noteInput.value = noteVal; }
    }
  }).catch(() => {});
}

export default await cardComponent({
  fragmentUrl: '/apps/impromptu/MusicalWork.tpl',
  styles,
  bind(root, entity, f) {
    const title = f.title || entity.name || 'Untitled work';
    const composer = f.composer || '';
    const workId = f.workId;
    const query = f.searchQuery || [composer, title].filter(Boolean).join(' ');

    // The play button links to the top YouTube recording of the work. The link comes
    // from the gateway (the path vibe-coded apps use) — `gateway.brave.webSearch` restricted
    // to youtube.com/watch, the same op the MusicalWork type's `recordings` method wraps.
    // Starts as a ▶ linking to a YouTube search; upgrades to the top video when the gateway
    // answers (and stays a search link if pack-research isn't installed).
    const play = root.querySelector('[data-play]');
    play.textContent = '▶';
    play.setAttribute('href', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query));
    play.setAttribute('title', 'Listen to ' + title);

    const gw = window.gateway;
    if (gw && gw.brave && query) {
      gw.brave.webSearch({ q: query + ' site:youtube.com/watch', count: 3 }).then((res) => {
        const hits = (res && res.web && res.web.results) || [];
        const hit = hits.find((r) => r.url && r.url.indexOf('youtube.com/watch') >= 0);
        if (hit) {
          play.setAttribute('href', hit.url);
          if (hit.title) play.setAttribute('title', 'Listen: ' + hit.title);
        }
      }).catch(() => {});
    }

    root.querySelector('[data-title]').textContent = title;

    const sub = root.querySelector('[data-sub]');
    if (f.subtitle) sub.textContent = String(f.subtitle); else sub.remove();

    const comp = root.querySelector('[data-composer]');
    if (composer) {
      const label = document.createElement('span'); label.textContent = 'Composer: ';
      const b = document.createElement('b'); b.textContent = String(composer);
      comp.appendChild(label); comp.appendChild(b);
    } else comp.remove();

    const genres = root.querySelector('[data-genres]');
    const list = f.genre ? String(f.genre).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4) : [];
    if (list.length) {
      list.forEach((name) => { const c = document.createElement('span'); c.className = 'work-genre'; c.textContent = name; genres.appendChild(c); });
    } else genres.remove();

    const rateEl = root.querySelector('[data-rate]');
    if (rateEl && workId && window.gateway && window.gateway.repository) buildRating(rateEl, workId, title, composer, window.gateway);
    else if (rateEl) rateEl.remove();
  },
});

// No `actions` export: MusicalWork's affordances are the gateway-driven play button
// above (youtube) and any gateway methods on the type, which the host renders
// generically from methods.json. No bespoke action paths.
