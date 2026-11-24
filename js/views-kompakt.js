// Prüfungs-Kompakt: pro Buch das Klausurnötige, gewichtet nach den Altklausuren
import { store, isStudyChapter, bookRole } from './store.js';
import { esc, enrich } from './ui.js';
import { setTitle } from './app.js';
import { paint, legend } from './paint.js';
import { playAudio, audioSupported } from './audio.js';

const STARS = n => n >= 3 ? '★★★' : n === 2 ? '★★☆' : n === 1 ? '★☆☆' : '☆☆☆';
const STAR_LABEL = ['selten / Hintergrund', 'kommt vereinzelt vor', 'kommt regelmäßig vor', 'Klausurklassiker'];
const filterState = {};

const cite = x => x?.seite ? ` <span class="cite">[${esc(String(x.seite).replace(/^\[|\]$/g, ''))}]</span>` : '';
const roman = t => { const m = String(t).match(/Zivilrecht\s+([IVX]+)\b/); if (!m) return 99; const v = { I: 1, V: 5, X: 10 }; let n = 0; for (let i = 0; i < m[1].length; i++) { const a = v[m[1][i]], b = v[m[1][i + 1]] || 0; n += a < b ? -a : a; } return n; };
const booksOf = sub => sub.books.filter(b => bookRole(b) === 'stoff' && b.chapters?.some(c => c.skript)).sort((a, b) => roman(a.title) - roman(b.title));

export function kompaktView(el, subId, fileId) {
  const sub = store.subject(subId);
  if (!sub) { el.innerHTML = '<div class="card">Fach nicht gefunden.</div>'; return; }
  const K = sub.kompakt;
  if (!K) { el.innerHTML = '<div class="card">Die Prüfungs-Kompakt-Seiten sind noch nicht da.</div>'; return; }
  if (fileId === 'analyse') return analyseView(el, sub, K);
  const books = booksOf(sub);
  const b = books.find(x => x.fileId === fileId) || books[0];
  setTitle('Prüfungs-Kompakt');
  const f = filterState[subId] ?? 2;
  const chs = b.chapters.filter(isStudyChapter).map(c => ({ c, k: K.chapters[c.id] || { s: 0 } }));
  const shown = chs.filter(x => (x.k.s || 0) >= f);
  let html = `<div class="card no-print"><div class="row between"><div><div class="item-title">🎯 Prüfungs-Kompakt</div><div class="small muted">Das Klausurnötige aus jedem Kapitel – gewichtet danach, wie oft es in den Altklausuren vorkam.</div></div>
      <div class="row"><a class="btn ghost small" href="#/fach/${subId}/stoff">‹ Lehrbuch</a><a class="btn secondary small" href="#/fach/${subId}/kompakt/analyse">📊 Klausur-Analyse</a>${audioSupported() ? '<button class="btn secondary small" data-a="listen">🎧 Anhören</button>' : ''}<button class="btn secondary small" data-a="print">Drucken / PDF</button></div></div>
      <div class="tabs" style="margin-top:10px">${books.map(x => `<a class="tab ${x.fileId === b.fileId ? 'active' : ''}" href="#/fach/${subId}/kompakt/${x.fileId}">${esc(shortTitle(x.title))}</a>`).join('')}</div>
      <div class="row small" style="margin-top:8px;gap:6px"><span class="muted">Zeigen:</span>${[[3, '★★★ nur Klassiker'], [2, 'ab ★★'], [0, 'alle Kapitel']].map(([v, l]) => `<button class="btn ${f === v ? '' : 'ghost'} small" data-f="${v}">${l}</button>`).join('')}<span class="muted">${shown.length} von ${chs.length} Kapiteln</span></div></div>`;
  html += legend();
  html += `<div class="card"><h3 style="margin-top:0">${esc(b.title)}</h3><ol class="small" style="padding-left:20px;columns:2;column-gap:24px">${chs.map(({ c, k }) => `<li style="opacity:${(k.s || 0) >= f ? 1 : .45}"><a href="#" data-jump="${c.id}">${esc(c.title.replace(/^\d+\.\s*Kapitel:\s*/, ''))}</a> <span class="stars s${k.s || 0}">${STARS(k.s || 0)}</span></li>`).join('')}</ol></div>`;
  for (const { c, k } of shown) html += chapterBlock(subId, c, k);
  if (!shown.length) html += '<div class="card small muted">In diesem Buch gibt es kein Kapitel mit dieser Gewichtung – stell oben auf „alle Kapitel“.</div>';
  el.innerHTML = html;
  el.querySelectorAll('.kp-ch').forEach(x => paint(x));
  el.onclick = e => {
    const j = e.target.closest('[data-jump]');
    if (j) { e.preventDefault(); let t = el.querySelector('#kp-' + CSS.escape(j.dataset.jump)); if (!t) { filterState[subId] = 0; kompaktView(el, subId, b.fileId); t = el.querySelector('#kp-' + CSS.escape(j.dataset.jump)); } if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 60, behavior: 'smooth' }); return; }
    const fb = e.target.closest('[data-f]');
    if (fb) { filterState[subId] = +fb.dataset.f; kompaktView(el, subId, b.fileId); return; }
    if (e.target.closest('[data-a=print]')) { window.print(); return; }
    if (e.target.closest('[data-a=listen]')) {
      playAudio({ title: shortTitle(b.title) + ' – Prüfungs-Kompakt', key: 'kp:' + b.fileId + ':' + f, items: shown.map(({ c, k }) => ({ label: c.title, text: listenText(c, k) })) });
    }
  };
}

function shortTitle(t) {
  const m = t.match(/Zivilrecht\s+([IVX]+)/i);
  return m ? 'ZR ' + m[1] : t.length > 22 ? t.slice(0, 20) + '…' : t;
}

function chapterBlock(subId, c, k) {
  const s = k.s || 0, sk = c.skript || {};
  const full = s >= 2;
  let h = `<div class="card kp-ch pastel-card pc-${s >= 3 ? 0 : s === 2 ? 3 : 5}" id="kp-${c.id}" data-chid="${c.id}">
    <div class="row between" style="align-items:flex-start"><h3 style="margin:0">${esc(c.title)}</h3><span class="stars s${s}" title="${STAR_LABEL[s]}">${STARS(s)}</span></div>
    <div class="tiny muted" style="margin:2px 0 8px">S. ${esc(c.startLabel || '')}–${esc(c.endLabel || '')} · ${STAR_LABEL[s]} · <a href="#/fach/${subId}/kapitel/${c.id}">zum Kapitel ›</a></div>`;
  if (k.f) h += `<div class="kp-fokus small no-paint"><strong>🎯 In den Klausuren:</strong> ${enrich(esc(k.f))}</div>`;
  if (sk.kernaussage) h += `<p class="small">${enrich(esc(sk.kernaussage))}</p>`;
  if ((sk.anspruchsgrundlagen || []).length) h += `<div class="small skript-sec ag"><strong class="no-paint">§ Anspruchsgrundlagen</strong><ul>${sk.anspruchsgrundlagen.slice(0, full ? 12 : 6).map(a => `<li>${enrich(esc(a.norm || ''))} – ${enrich(esc(a.wofuer || ''))}${cite(a)}</li>`).join('')}</ul></div>`;
  if (full && (sk.pruefung || []).length) h += `<div class="small"><strong>🧭 So prüfst du im Fall</strong><ol class="steps">${sk.pruefung.map((p, i) => `<li class="pc-${i % 6}"><strong>${enrich(esc(p.punkt || ''))}</strong>${cite(p)}${s >= 3 && (p.voraussetzungen || []).length ? `<ul>${p.voraussetzungen.map(v => `<li>${enrich(esc(v))}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol></div>`;
  if (full && (sk.klausurfallen || []).length) h += `<div class="small skript-sec fa"><strong class="no-paint">⚠️ Klausurfallen</strong><ul>${sk.klausurfallen.slice(0, s >= 3 ? 6 : 3).map(x => `<li>${enrich(esc(x.text || x))}${cite(x)}</li>`).join('')}</ul></div>`;
  if (!c.skript && c.summary?.kurzfassung) h += `<p class="small">${enrich(esc(c.summary.kurzfassung))}</p>`;
  return h + '</div>';
}

function listenText(c, k) {
  const sk = c.skript || {}, s = k.s || 0;
  const parts = [`${['Selten geprüft', 'Kommt vereinzelt vor', 'Kommt regelmäßig vor', 'Ein Klausurklassiker'][s]}.`];
  if (k.f) parts.push('In den Klausuren: ' + k.f);
  if (sk.kernaussage) parts.push(sk.kernaussage);
  if ((sk.anspruchsgrundlagen || []).length) parts.push('Anspruchsgrundlagen. ' + sk.anspruchsgrundlagen.slice(0, s >= 2 ? 12 : 6).map(a => `${a.norm}: ${a.wofuer}`).join('. '));
  if (s >= 2 && (sk.pruefung || []).length) parts.push('So prüfst du im Fall. ' + sk.pruefung.map((p, i) => `${i + 1}. ${p.punkt}`).join('. '));
  if (s >= 2 && (sk.klausurfallen || []).length) parts.push('Klausurfallen. ' + sk.klausurfallen.slice(0, s >= 3 ? 6 : 3).map(x => x.text || x).join('. '));
  return parts.join('\n\n');
}

function analyseView(el, sub, K) {
  setTitle('Klausur-Analyse');
  const max = Math.max(...K.themen.map(t => t.n));
  const chTitle = id => { for (const b of sub.books) { const c = b.chapters?.find(x => x.id === id); if (c) return { b, c }; } return null; };
  el.innerHTML = `<div class="card"><div class="row between"><div class="item-title">📊 Was in den Altklausuren drankam</div><a class="btn ghost small" href="#/fach/${sub.id}/kompakt/${booksOf(sub)[0]?.fileId || ''}">‹ Prüfungs-Kompakt</a></div>
      <p class="small muted">${esc(K.basis)}</p>
      <h4>So sind die Klausuren aufgebaut</h4><ul class="small">${K.muster.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
      ${K.warnung ? `<div class="notice gold small">${esc(K.warnung)}</div>` : ''}</div>
    <div class="card"><h3 style="margin-top:0">Themen nach Häufigkeit</h3>
      ${K.themen.map(t => `<div class="kp-theme"><div class="row between small"><strong>${esc(t.t)}</strong><span class="muted">${t.n}×</span></div>
        <div class="kp-bar"><div style="width:${Math.round(100 * t.n / max)}%"></div></div>
        <div class="tiny muted">${esc(t.kl.join(' · '))}</div>
        <div class="tiny" style="margin-top:2px">${(t.ch || []).map(id => { const r = chTitle(id); return r ? `<a href="#/fach/${sub.id}/kompakt/${r.b.fileId}" data-to="${id}">${esc(shortTitle(r.b.title))}: ${esc(r.c.title.replace(/^\d+\.\s*Kapitel:\s*/, ''))}</a>` : ''; }).filter(Boolean).join(' · ')}</div></div>`).join('')}
      <p class="tiny muted">K1/K2 = 1./2. Klausur, ZK = Zulassungsklausur, AK = Abschlussklausur, SS/WS = Semester.</p></div>`;
  el.onclick = e => {
    const a = e.target.closest('[data-to]');
    if (a) { e.preventDefault(); filterState[sub.id] = 0; location.hash = a.getAttribute('href'); setTimeout(() => { const t = document.getElementById('kp-' + a.dataset.to); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 60, behavior: 'smooth' }); }, 300); }
  };
}
