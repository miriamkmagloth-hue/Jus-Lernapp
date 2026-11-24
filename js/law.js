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
    // direkt die Originalseiten aus dem Buch zeigen (PDF bleibt für weitere Aufrufe im Speicher)
    body.innerHTML = busy(`Lade ${nums.length > 1 ? 'die Seiten' : 'die Seite'} aus dem Buch …`);
    const { renderPdfPages } = await import('./extract.js');
    let buf = PDF_CACHE.get(book.fileId);
    if (!buf) {
      const { downloadFile } = await import('./drive.js');
      const f = sub.files[book.fileId];
      buf = (await downloadFile({ id: book.fileId, mimeType: f?.mimeType || 'application/pdf', name: f?.name })).buffer;
      PDF_CACHE.clear(); PDF_CACHE.set(book.fileId, buf);
    }
    const imgs = await renderPdfPages(buf.slice(0), nums, { scale: 1.7, quality: 0.85 });
    body.innerHTML = `<div style="max-height:75vh;overflow:auto">${nums.map(n => `<div class="tiny muted" style="margin:8px 0 4px">Seite ${esc(t.pages[n - 1].label)}</div><img src="data:image/jpeg;base64,${imgs[n]}" style="width:100%;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.12)">`).join('')}</div>`;
  } catch (err) { body.innerHTML = `<div class="notice err small">${esc(err.message)}</div>`; }
}
