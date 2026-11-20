// UI-Hilfen: Escaping, Markdown, Dialoge, Meldungen, Ordnerauswahl
import { normLink } from './ris.js';
import { listFolder, listShared, isFolder } from './drive.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Paragraphen als Links, Seitenangaben hervorheben
export function enrich(htmlEscaped) {
  return htmlEscaped
    .replace(/(§§?\s*(\d+[a-z]?)(?:\s*(?:Abs\.?\s*\d+|Z\s*\d+|lit\.?\s*[a-z]|Satz\s*\d+|S\s*\d+|ff?\.?))*\s+(ABGB|B-VG|StGB|ZPO|UGB|KSchG|StPO|AVG|EO|IO|MRG|GmbHG|AktG|EheG|JN|ASVG|VStG|EKHG|AußStrG|WEG|ECG|FAGG|VKrG|PHG))/g,
      (m, all, para, law) => `<a class="norm" href="${normLink(para, law)}" target="_blank" rel="noopener">${all}</a>`)
    .replace(/\[(S\.?\s*[\w\d\-–, f.]+)\]/g, '<span class="cite">[$1]</span>');
}

// Kleines Markdown (KI-Antworten)
export function md(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let html = '', inList = null, para = [];
  const inline = s => enrich(esc(s))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); const l = Math.min(m[1].length + 1, 4); html += `<h${l}>${inline(m[2])}</h${l}>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    closeList(); para.push(line);
  }
  flushPara(); closeList();
  return `<div class="prose">${html}</div>`;
}

export function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms);
}

export function openModal(html, onMount) {
  const m = $('#modal'), c = $('#modalCard');
  c.innerHTML = html; m.hidden = false;
  m.onclick = e => { if (e.target === m) closeModal(); };
  onMount && onMount(c);
  return c;
}
export function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; }

export function confirmDialog(text, okLabel = 'OK') {
  return new Promise(resolve => {
    openModal(`<p>${esc(text)}</p><div class="row" style="justify-content:flex-end"><button class="btn secondary" data-a="no">Abbrechen</button><button class="btn" data-a="yes">${esc(okLabel)}</button></div>`, c => {
      c.querySelector('[data-a=no]').onclick = () => { closeModal(); resolve(false); };
      c.querySelector('[data-a=yes]').onclick = () => { closeModal(); resolve(true); };
    });
  });
}

export function busy(label) { return `<div class="busy"><span class="spinner"></span>${esc(label)}</div>`; }
export function errorBox(e) { return `<div class="notice err">${esc(e?.message || e)}</div>`; }

export function fmtDate(d) {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : new Date(d);
  if (isNaN(x)) return String(d);
  return x.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((t - now) / 86400000);
}
export function fmtMin(min) {
  min = Math.round(min);
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} Min` : `${h} h`;
}
export function ampel(mastery, assessed) {
  if (!assessed) return '';
  return mastery >= 0.75 ? 'green' : mastery >= 0.45 ? 'yellow' : 'red';
}

// Ordnerauswahl in Google Drive (mehrere Ordner möglich)
export function pickFolders({ title = 'Ordner wählen', selected = [], allowFiles = false } = {}) {
  return new Promise(resolve => {
    let chosen = [...selected];
    const stack = [{ id: 'root', name: 'Meine Ablage' }];
    const card = openModal(`<div class="row between"><h3 style="margin:0">${esc(title)}</h3><button class="btn ghost" data-a="close">✕</button></div>
      <div class="small muted" id="fbPath"></div><ul class="list folder-browser" id="fbList"></ul>
      <div class="small" id="fbChosen"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn secondary" data-a="cancel">Abbrechen</button><button class="btn" data-a="ok">Übernehmen</button></div>`);
    const render = async () => {
      card.querySelector('#fbPath').textContent = stack.map(s => s.name).join(' / ');
      const list = card.querySelector('#fbList');
      list.innerHTML = `<li>${busy('Lade Ordner …')}</li>`;
      try {
        const cur = stack[stack.length - 1];
        let items = cur.id === '__shared' ? await listShared() : await listFolder(cur.id);
        if (!allowFiles) items = items.filter(isFolder);
        let html = '';
        if (stack.length > 1) html += `<li data-up="1"><span class="item-link">‹ zurück</span></li>`;
        if (cur.id === 'root') html += `<li data-open="__shared" data-name="Für mich freigegeben"><span class="item-link">👥 Für mich freigegeben<span class="chev">›</span></span></li>`;
        for (const f of items) {
          const isSel = chosen.some(c => c.id === f.id);
          html += `<li data-id="${f.id}" data-name="${esc(f.name)}" data-folder="${isFolder(f) ? 1 : 0}"><div class="row"><input type="checkbox" ${isSel ? 'checked' : ''} data-check="${f.id}"> <span class="item-link" style="flex:1">${isFolder(f) ? '📁' : '📄'} ${esc(f.name)}</span>${isFolder(f) ? '<span class="chev">›</span>' : ''}</div></li>`;
        }
        if (!items.length) html += `<li class="muted small">Keine Unterordner</li>`;
        list.innerHTML = html;
      } catch (e) { list.innerHTML = `<li>${errorBox(e)}</li>`; }
      card.querySelector('#fbChosen').innerHTML = chosen.length ? 'Gewählt: ' + chosen.map(c => `<span class="pill blue">${esc(c.name)}</span>`).join(' ') : '<span class="muted">Noch nichts gewählt – Häkchen setzen</span>';
    };
    card.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close' || a === 'cancel') { closeModal(); resolve(null); return; }
      if (a === 'ok') { closeModal(); resolve(chosen); return; }
      const chk = e.target.closest('[data-check]');
      if (chk) {
        const li = chk.closest('li');
        if (chk.checked) chosen.push({ id: li.dataset.id, name: li.dataset.name, isFolder: li.dataset.folder === '1' });
        else chosen = chosen.filter(c => c.id !== li.dataset.id);
        render(); return;
      }
      const li = e.target.closest('li');
      if (!li) return;
      if (li.dataset.up) { stack.pop(); render(); return; }
      if (li.dataset.open) { stack.push({ id: li.dataset.open, name: li.dataset.name }); render(); return; }
      if (li.dataset.folder === '1') { stack.push({ id: li.dataset.id, name: li.dataset.name }); render(); }
    };
    render();
  });
}

// einfache Balkengrafik
export function barChart(values, labels) {
  const max = Math.max(1, ...values);
  return `<div class="chart-bars">${values.map((v, i) => `<div title="${esc(labels[i])}: ${Math.round(v)} Min" style="height:${Math.max(2, (v / max) * 100)}%"></div>`).join('')}</div>
    <div class="chart-labels">${labels.map(l => `<span>${esc(l)}</span>`).join('')}</div>`;
}
