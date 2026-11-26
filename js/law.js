// Paragraph antippen: Gesetzestext anzeigen (RIS oder eigenes Buch „Gesetzestext“), Stichwörter markieren
import { store, bookRole, textGet, findChapter } from './store.js';
import { fetchNormText } from './ris.js';
import { openModal, closeModal, esc, busy } from './ui.js';

const STOP = new Set('aber alle allem allen aller alles also auch auf aus bei beim bereits besteht bzw dabei damit dann dass dem den denen der deren des dessen die dies diese diesem diesen dieser dieses doch durch eine einem einen einer eines etwa gegen gemäß hat hier ihre ist jedoch kann keine können muss nach nicht noch nur oder ohne sich sie sind sowie über unter vom von vor wenn werden wird wobei zum zur zwischen also abgb absatz satz seite gilt etwa insbesondere'.split(' '));

function keywords(context) {
  const words = (context.match(/[A-Za-zÄÖÜäöüß]{5,}/g) || []).map(w => w.toLowerCase()).filter(w => !STOP.has(w));
  const count = new Map();
  words.forEach(w => count.set(w, (count.get(w) || 0) + 1));
  return [...count.keys()].slice(0, 14);
}

function highlight(text, kws) {
  let html = esc(text);
  const stems = [...new Set(kws.map(k => k.slice(0, Math.max(5, k.length - 3))))].filter(s => s.length >= 5);
  if (!stems.length) return html;
  const re = new RegExp('(' + stems.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-zäöüß]*', 'gi');
  return html.replace(re, '<mark>$&</mark>');
}

// im eigenen Gesetzestext-PDF suchen
async function fromOwnBook(subId, para, law) {
  const subs = subId ? [store.subject(subId)] : store.state.subjects;
  for (const sub of subs.filter(Boolean)) {
    for (const b of sub.books.filter(x => bookRole(x) === 'nachschlag')) {
      const t = await textGet('file:' + b.fileId);
      if (!t?.text) continue;
      const re = new RegExp('§\\s*' + para + '\\.?\\s', 'g');
      const hits = [...t.text.matchAll(re)].map(m => m.index);
      if (!hits.length) continue;
      // Treffer bevorzugen, in dessen Nähe (davor) der Gesetzesname vorkommt
      const best = hits.find(i => t.text.slice(Math.max(0, i - 40000), i).includes(law)) ?? hits[0];
      let out = t.text.slice(best, best + 4000);
      const next = out.slice(5).search(/\n?§\s*\d+[a-z]?\.?\s/);
      if (next > 100) out = out.slice(0, next + 5);
      return { text: out.replace(/\[S\. [^\]]+\]\n?/g, ''), source: b.title };
    }
  }
  return null;
}

export async function openLaw({ para, law, kind = 'para', context = '', subId, href }) {
  const kws = keywords(context);
  const card = openModal(`<div class="row between"><h3 style="margin:0">${kind === 'art' ? 'Art' : '§'} ${esc(para)} ${esc(law)}</h3><button class="btn ghost" data-x>✕</button></div><div id="lawBody">${busy('Lade Gesetzestext …')}</div>
    <div class="row" style="margin-top:12px"><a class="btn secondary small" href="${esc(href)}" target="_blank" rel="noopener">Im RIS öffnen ↗</a></div>`);
  card.querySelector('[data-x]').onclick = closeModal;
  const body = card.querySelector('#lawBody');
  let res = null, err = null;
  try { res = { text: await fetchNormText(law, para, kind), source: 'RIS – geltende Fassung' }; } catch (e) { err = e; }
  if (!res && kind !== 'art') { try { res = await fromOwnBook(subId, para, law); } catch {} }
  if (!res) { body.innerHTML = `<div class="notice warn small">Der Text konnte nicht geladen werden${err ? ' (' + esc(err.message) + ')' : ''}. Öffne ihn direkt im RIS.</div>`; return; }
  body.innerHTML = `<div class="tiny muted" style="margin:6px 0">Quelle: ${esc(res.source)}${kws.length ? ' · markiert: Stichwörter aus dem Zusammenhang' : ''}</div>
    <div class="sachverhalt" style="font-size:.95rem;max-height:60vh;overflow:auto">${highlight(res.text, kws)}</div>`;
}


// Seitenangabe wie „S. 21–22“, „S. 290 f“, „S. 145, 147“ → Buchseiten zum Nachlesen
const PDF_CACHE = new Map();
export async function openPages({ subId, chId, fileId, ref }) {
  const sub = store.subject(subId);
  if (!sub) return;
  const found = chId ? findChapter(sub, chId) : null;
  const book = found?.book || sub.books.find(b => b.fileId === fileId);
  const card = openModal(`<div class="row between"><h3 style="margin:0">${esc(ref.replace(/^\[|\]$/g, ''))}</h3><button class="btn ghost" data-x>✕</button></div><div class="tiny muted">${esc(book?.title || '')}</div><div id="pgBody">${busy('Lade die Buchseiten …')}</div>`);
  card.querySelector('[data-x]').onclick = closeModal;
  const body = card.querySelector('#pgBody');
  if (!book) { body.innerHTML = '<div class="notice small">Zu dieser Stelle ist kein Buch bekannt.</div>'; return; }
  try {
    const { getFileText } = await import('./processing.js');
    const t = await getFileText(sub, book.fileId);
    const byLabel = new Map(t.pages.map(p => [String(p.label), p.n]));
    // Zahlen aus der Angabe lesen
    const txt = ref.replace(/^\[|\]$/g, '').replace(/^S\.?\s*/, '');
    const wanted = new Set();
    for (const part of txt.split(/[,;]/)) {
      const r = part.match(/(\d+)\s*(?:[–-]\s*(\d+))?\s*(ff?)?/);
      if (!r) continue;
      const a = +r[1], b = r[2] ? +r[2] : r[3] === 'ff' ? a + 2 : r[3] === 'f' ? a + 1 : a;
      for (let x = a; x <= Math.min(b, a + 6); x++) { const n = byLabel.get(String(x)); if (n) wanted.add(n); }
    }
    const nums = [...wanted].sort((a, b) => a - b);
    if (!nums.length) throw new Error('Seite nicht gefunden');
    // ganzes Buch öffnen, an der verwiesenen Seite beginnen – vor und zurück blättern
    body.innerHTML = busy('Lade das Buch …');
    const { openPdf, openPdfUrl, renderPdfPage } = await import('./extract.js');
    let doc = PDF_CACHE.get(book.fileId);
    if (!doc) {
      const drive = await import('./drive.js');
      for (const d of PDF_CACHE.values()) { try { d.destroy(); } catch {} }
      PDF_CACHE.clear();
      try {
        // nur die nötigen Seiten aus Drive holen
        doc = await openPdfUrl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(book.fileId)}?alt=media`, await drive.authHeader());
      } catch (e1) {
        console.warn('Teil-Laden fehlgeschlagen, lade ganzes Buch', e1);
        const f = sub.files[book.fileId];
        const buf = (await drive.downloadFile({ id: book.fileId, mimeType: f?.mimeType || 'application/pdf', name: f?.name })).buffer;
        doc = await openPdf(buf);
      }
      PDF_CACHE.set(book.fileId, doc);
    }
    const total = doc.numPages;
    const marked = new Set(nums);
    const label = n => t.pages[n - 1]?.label ?? n;
    const imgCache = new Map();
    const getImg = n => { if (!imgCache.has(n)) imgCache.set(n, renderPdfPage(doc, n, { scale: 2.4, quality: 0.85 })); return imgCache.get(n); };
    // Buch über den ganzen Bildschirm
    card.classList.add('book-full');
    let zoom = +(localStorage.getItem('bookZoom') || 100);
    body.innerHTML = `<div class="row between book-bar" style="gap:6px;flex-wrap:wrap">
        <button class="btn secondary small" data-prev>◀ zurück</button>
        <span class="small" data-lbl style="text-align:center"></span>
        <button class="btn secondary small" data-next>weiter ▶</button>
      </div>
      <div class="row book-zoom" style="gap:6px;justify-content:center;align-items:center;margin:6px 0">
        <button class="btn ghost small" data-z="-">−</button>
        <input type="range" data-zr min="60" max="300" step="10" value="${zoom}" style="width:min(320px,50vw)">
        <button class="btn ghost small" data-z="+">+</button>
        <span class="tiny muted" data-zl>${zoom} %</span>
        <button class="btn ghost small" data-z="0">Anpassen</button>
      </div>
      <div data-view class="book-view"></div>
      <div class="row" style="margin-top:6px;gap:6px;justify-content:center">
        <span class="tiny muted">Gehe zu Seite</span><input data-go type="text" inputmode="numeric" style="width:70px" placeholder="${esc(label(nums[0]))}">
      </div>`;
    const view = body.querySelector('[data-view]'), lbl = body.querySelector('[data-lbl]');
    let cur = nums[0], token = 0;
    const show = async n => {
      cur = Math.max(1, Math.min(total, n));
      const my = ++token;
      lbl.innerHTML = `Seite <b>${esc(label(cur))}</b>${marked.has(cur) ? ' <span class="tag">verwiesen</span>' : ''}<br><span class="tiny muted">${cur} / ${total}</span>`;
      body.querySelector('[data-prev]').disabled = cur <= 1;
      body.querySelector('[data-next]').disabled = cur >= total;
      if (!imgCache.has(cur)) view.innerHTML = busy('Seite wird geladen …');
      try {
        const img = await getImg(cur);
        if (my !== token) return;
        view.innerHTML = `<img src="data:image/jpeg;base64,${img}" class="book-page${marked.has(cur) ? ' marked' : ''}">`;
        applyZoom(); view.scrollTop = 0; view.scrollLeft = 0;
        // Nachbarseiten schon vorbereiten
        if (cur < total) getImg(cur + 1).catch(() => {});
        if (cur > 1) getImg(cur - 1).catch(() => {});
      } catch (e) { if (my === token) { imgCache.delete(cur); view.innerHTML = `<div class="notice err small">${esc(e.message)}</div>`; } }
    };
    // Zoom: Seite so breit wie der Bildschirm (100 %), größer → seitlich scrollen
    function applyZoom() {
      const im = view.querySelector('img'); if (!im) return;
      const base = Math.min(view.clientWidth - 4, 1000);
      im.style.width = Math.round(base * zoom / 100) + 'px';
      body.querySelector('[data-zl]').textContent = zoom + ' %';
      body.querySelector('[data-zr]').value = zoom;
      try { localStorage.setItem('bookZoom', zoom); } catch {}
    }
    const setZoom = z => { const im = view.querySelector('img'); const cx = view.scrollLeft + view.clientWidth / 2, cy = view.scrollTop; const w0 = im?.offsetWidth || 1; zoom = Math.max(60, Math.min(300, Math.round(z / 10) * 10)); applyZoom(); const f = (im?.offsetWidth || 1) / w0; view.scrollLeft = cx * f - view.clientWidth / 2; view.scrollTop = cy * f; };
    body.querySelector('[data-zr]').oninput = e => setZoom(+e.target.value);
    body.querySelectorAll('[data-z]').forEach(b => b.onclick = () => setZoom(b.dataset.z === '+' ? zoom + 20 : b.dataset.z === '-' ? zoom - 20 : 100));
    view.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom - Math.sign(e.deltaY) * 10); } }, { passive: false });
    window.addEventListener('resize', applyZoom);
    body.querySelector('[data-prev]').onclick = () => show(cur - 1);
    body.querySelector('[data-next]').onclick = () => show(cur + 1);
    body.querySelector('[data-go]').onchange = e => {
      const v = e.target.value.trim(); const n = byLabel.get(v);
      if (n) show(n); else e.target.value = '';
    };
    // Wischen am Handy
    let sx = null, sy = null;
    view.addEventListener('touchstart', e => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null; }, { passive: true });
    view.addEventListener('touchend', e => {
      if (sx == null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (zoom > 100 && view.scrollWidth > view.clientWidth + 5) return; // beim Zoomen wird seitlich geschoben, nicht geblättert
      if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) show(cur + (dx < 0 ? 1 : -1));
    }, { passive: true });
    // Pfeiltasten am Laptop
    const onKey = e => {
      if (!document.body.contains(view)) { document.removeEventListener('keydown', onKey); return; }
      if (e.target.matches?.('input,textarea')) return;
      if (e.key === 'ArrowRight') show(cur + 1); else if (e.key === 'ArrowLeft') show(cur - 1);
      else if (e.key === '+' || e.key === '=') setZoom(zoom + 20); else if (e.key === '-') setZoom(zoom - 20);
    };
    document.addEventListener('keydown', onKey);
    await show(cur);
  } catch (err) {
    const login = /401|403|anmeld|token|sign|auth/i.test(err.message);
    body.innerHTML = `<div class="notice err small">${login ? 'Die Verbindung zu Google Drive ist abgelaufen – bitte kurz neu anmelden, dann geht das Buch wieder auf.' : 'Das Buch konnte nicht geöffnet werden.'}<div class="tiny muted" style="margin-top:4px">${esc(err.message)}</div></div>${login ? '<button class="btn small" data-relogin style="margin-top:8px">Bei Google anmelden</button>' : '<button class="btn small" data-retry style="margin-top:8px">Nochmal versuchen</button>'}`;
    const rl = body.querySelector('[data-relogin]'); if (rl) rl.onclick = async () => { try { const d = await import('./drive.js'); await d.signIn(); closeModal(); openPages({ subId, chId, fileId, ref }); } catch (e) { alert(e.message); } };
    const rt = body.querySelector('[data-retry]'); if (rt) rt.onclick = () => { closeModal(); PDF_CACHE.clear(); openPages({ subId, chId, fileId, ref }); };
  }
}
