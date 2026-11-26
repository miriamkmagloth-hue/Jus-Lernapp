// Volltextsuche in allen Büchern – kostenlos, läuft nur auf dem Gerät
import { store, bookRole } from './store.js';
import { esc, busy } from './ui.js';
import { setTitle } from './app.js';

const state = {};           // pro Fach: { q, scope, results }
const textCache = new Map(); // fileId -> normalisierte Seiten

const norm = s => s.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
// Text für die Suche aufbereiten: Silbentrennung am Zeilenende entfernen, Leerraum vereinheitlichen
const clean = s => String(s || '').replace(/(\w)-\s*\n\s*(\w)/g, '$1$2').replace(/\s+/g, ' ');

async function pagesOf(sub, b) {
  if (textCache.has(b.fileId)) return textCache.get(b.fileId);
  const { getFileText } = await import('./processing.js');
  const t = await getFileText(sub, b.fileId);
  const pages = t.pages.map(p => { const text = clean(p.text); return { n: p.n, label: p.label, text, low: norm(text) }; });
  textCache.set(b.fileId, pages);
  return pages;
}

const shortTitle = t => { const m = String(t).match(/Zivilrecht\s+([IVX]+)/i); return m ? 'ZR ' + m[1] : t.length > 30 ? t.slice(0, 28) + '…' : t; };
const roman = t => { const m = String(t).match(/Zivilrecht\s+([IVX]+)\b/); if (!m) return 99; const v = { I: 1, V: 5, X: 10 }; let n = 0; for (let i = 0; i < m[1].length; i++) { const a = v[m[1][i]], c = v[m[1][i + 1]] || 0; n += a < c ? -a : a; } return n; };
const searchBooks = sub => sub.books.filter(b => b.chapters?.length && bookRole(b) !== 'aus').sort((a, b) => roman(a.title) - roman(b.title));

export function searchView(el, subId) {
  const sub = store.subject(subId);
  if (!sub) { el.innerHTML = '<div class="card">Fach nicht gefunden.</div>'; return; }
  setTitle('Suche in allen Büchern');
  const st = state[subId] ||= { q: '', scope: '', results: null };
  const books = searchBooks(sub);
  el.innerHTML = `<div class="card"><div class="item-title">🔍 Suche in allen Büchern</div>
      <div class="small muted">Durchsucht den vollständigen Text deiner Lehrbücher – kostenlos, direkt auf dem Gerät. Mehrere Wörter = alle müssen auf derselben Seite vorkommen. Mit „Anführungszeichen“ suchst du eine genaue Wortfolge.</div>
      <form data-form class="row" style="margin-top:10px;gap:6px;flex-wrap:nowrap"><input type="search" data-q placeholder="z. B. Sicherungszession, „Zug um Zug“, Transmission …" value="${esc(st.q)}" style="flex:1" autofocus><button class="btn">Suchen</button></form>
      <div class="row small" style="margin-top:8px;gap:6px"><span class="muted">In:</span><select data-scope><option value="">allen Büchern</option>${books.map(b => `<option value="${b.fileId}" ${st.scope === b.fileId ? 'selected' : ''}>${esc(shortTitle(b.title))}</option>`).join('')}</select></div></div>
    <div data-res></div>`;
  const res = el.querySelector('[data-res]');
  const run = async () => {
    const raw = st.q.trim();
    if (raw.length < 2) { res.innerHTML = ''; return; }
    // Begriffe: „…“ / "…" als Wortfolge, sonst einzelne Wörter
    const terms = [];
    raw.replace(/[„"“]([^"“”]+)["”“]|(\S+)/g, (_, ph, w) => { const t = norm((ph || w).trim()); if (t.length >= 2) terms.push(t); return ''; });
    if (!terms.length) return;
    res.innerHTML = busy('Durchsuche die Bücher …');
    const groups = [];
    let total = 0;
    for (const b of books.filter(x => !st.scope || x.fileId === st.scope)) {
      let pages;
      try { pages = await pagesOf(sub, b); } catch (e) { groups.push({ b, err: e.message }); continue; }
      const hits = [];
      for (const p of pages) {
        if (!terms.every(t => p.low.includes(t))) continue;
        const first = p.low.indexOf(terms[0]);
        const count = terms.reduce((a, t) => a + p.low.split(t).length - 1, 0);
        hits.push({ p, first, count });
      }
      // Kapitel zur Seite finden
      for (const h of hits) h.ch = b.chapters.find(c => h.p.n >= (c.startPage || 0) && h.p.n <= (c.endPage || 0));
      hits.sort((x, y) => x.p.n - y.p.n);
      total += hits.length;
      if (hits.length) groups.push({ b, hits });
    }
    if (!total) { res.innerHTML = `<div class="card small">Nichts gefunden für „${esc(raw)}“. Tipp: Wortstamm verwenden (z. B. „Zession“ statt „Zessionen“).</div>` + groups.filter(g => g.err).map(g => `<div class="notice err small">${esc(shortTitle(g.b.title))}: ${esc(g.err)}</div>`).join(''); return; }
    const snippet = (p, max = 2) => {
      const out = [];
      let from = 0;
      while (out.length < max) {
        let i = -1, len = 0;
        for (const t of terms) { const j = p.low.indexOf(t, from); if (j >= 0 && (i < 0 || j < i)) { i = j; len = t.length; } }
        if (i < 0) break;
        const a = Math.max(0, i - 90), z = Math.min(p.text.length, i + len + 110);
        out.push((a > 0 ? '… ' : '') + mark(p.text.slice(a, z), p.low.slice(a, z)) + (z < p.text.length ? ' …' : ''));
        from = z;
      }
      return out.join('<br>');
    };
    const mark = (txt, low) => {
      const marks = new Array(txt.length).fill(false);
      for (const t of terms) { let k = low.indexOf(t); while (k >= 0) { for (let x = k; x < k + t.length && x < marks.length; x++) marks[x] = true; k = low.indexOf(t, k + t.length); } }
      let h = '', on = false;
      for (let x = 0; x < txt.length; x++) { if (marks[x] !== on) { h += marks[x] ? '<mark>' : '</mark>'; on = marks[x]; } h += esc(txt[x]); }
      return h + (on ? '</mark>' : '');
    };
    res.innerHTML = `<div class="tiny muted" style="margin:4px 2px 8px">${total} Seite${total === 1 ? '' : 'n'} in ${groups.filter(g => g.hits).length} Büchern</div>` +
      groups.map(g => g.err ? `<div class="notice err small">${esc(shortTitle(g.b.title))}: ${esc(g.err)}</div>` : `<details class="card search-book" ${groups.length <= 2 || g.hits.length <= 6 ? 'open' : ''}><summary><strong>${esc(g.b.title)}</strong> <span class="pill">${g.hits.length}</span></summary>
        <ul class="list">${g.hits.slice(0, 150).map(h => `<li><a class="item search-hit" href="#" data-file="${g.b.fileId}" data-page="${esc(String(h.p.label))}" style="display:block">
          <div class="row between"><span class="cite">[S. ${esc(String(h.p.label))}]</span><span class="tiny muted" style="flex:1;margin-left:8px">${h.ch ? esc(h.ch.title) : ''}</span>${h.count > 1 ? `<span class="tiny muted">${h.count}×</span>` : ''}</div>
          <div class="small" style="margin-top:4px">${snippet(h.p)}</div></a></li>`).join('')}${g.hits.length > 150 ? `<li class="tiny muted">… und ${g.hits.length - 150} weitere Seiten – such genauer.</li>` : ''}</ul></details>`).join('');
  };
  el.querySelector('[data-form]').onsubmit = e => { e.preventDefault(); st.q = el.querySelector('[data-q]').value; run(); };
  el.querySelector('[data-scope]').onchange = e => { st.scope = e.target.value; run(); };
  res.onclick = async e => {
    const a = e.target.closest('.search-hit'); if (!a) return;
    e.preventDefault(); e.stopPropagation();
    const { openPages } = await import('./law.js');
    openPages({ subId, fileId: a.dataset.file, ref: `[S. ${a.dataset.page}]` });
  };
  if (st.q) run();
}
