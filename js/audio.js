// Vorlesen wie ein Podcast – kostenlos über die Sprachausgabe des Geräts (Web Speech API)
const synth = window.speechSynthesis;
const LS = 'audio-settings';
const POS = 'audio-pos';
let st = null;            // { title, key, items, idx, chunks, cidx, playing }
let token = 0, wake = null;
const settings = (() => { try { return { rate: 1, voice: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { rate: 1, voice: '' }; } })();
const saveSettings = () => { try { localStorage.setItem(LS, JSON.stringify(settings)); } catch {} };

export const audioSupported = () => !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

// ---------- Text fürs Hören aufbereiten ----------
const ABK = [
  [/§§/g, 'Paragraphen '], [/§/g, 'Paragraph '], [/Art\.\s*(?=\d)/g, 'Artikel '],
  [/\bAbs\.?\s*(?=\d)/g, 'Absatz '], [/\bZ\s+(?=\d)/g, 'Ziffer '], [/\blit\.?\s*(?=[a-z]\b)/g, 'litera '], [/\bS\.\s*(?=\d)/g, 'Seite '], [/\bRz\.?\s*(?=\d)/g, 'Randzahl '], [/\bFn\.?\s*(?=\d)/g, 'Fußnote '],
  [/\bzB\b|\bz\.\s?B\./g, 'zum Beispiel'], [/\bdh\b|\bd\.\s?h\./g, 'das heißt'], [/\buU\b|\bu\.\s?U\./g, 'unter Umständen'], [/\biSd\b/g, 'im Sinne des'], [/\biSv\b/g, 'im Sinne von'], [/\bivm\b|\biVm\b/g, 'in Verbindung mit'],
  [/\bhM\b|\bh\.\s?M\./g, 'herrschende Meinung'], [/\bhL\b/g, 'herrschende Lehre'], [/\bmE\b/g, 'meines Erachtens'], [/\bRsp\b/g, 'Rechtsprechung'], [/\bstRsp\b/g, 'ständige Rechtsprechung'], [/\bLit\b/g, 'Literatur'],
  [/\bvgl\.?/g, 'vergleiche'], [/\bbzw\.?/g, 'beziehungsweise'], [/\busw\.?/g, 'und so weiter'], [/\bua\b|\bu\.\s?a\./g, 'unter anderem'], [/\bidR\b/g, 'in der Regel'], [/\bgem\.?\s/g, 'gemäß '], [/\bausf\.?\s/g, 'ausführlich '],
  [/\bf\.?\s*$/g, ' folgende'], [/(\d)\s*ff\.?/g, '$1 fortfolgende'], [/(\d)\s*f\.(?=\s)/g, '$1 folgende'],
  [/(\d+)\s*Ob\s*(\d+)\/(\d+)([a-z])/g, '$1 Ob $2 aus $3 $4'], [/->|→/g, ' daraus folgt '], [/⇒/g, ' daher '], [/&/g, ' und '], [/\//g, ' '],
];
export function speakable(text) {
  let t = String(text || '');
  t = t.replace(/\[(?:S\.|Seite)[^\]]*\]/g, '')          // Seitenverweise in Klammern weglassen
    .replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]+/g, ' ')
    .replace(/(\w)-\n(\w)/g, '$1$2')                        // Silbentrennung am Zeilenende
    .replace(/^\s*\d{1,4}\s*$/gm, '')                       // nackte Seitenzahlen/Randzahlen
    .replace(/\n{2,}/g, '. ').replace(/\n/g, ' ')
    .replace(/^\s*[-•–]\s*/gm, '');
  for (const [re, r] of ABK) t = t.replace(re, r);
  return t.replace(/\s+([.,;:])/g, '$1').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
}
function chunk(text) {
  const out = [];
  const sentences = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 220 && cur) { out.push(cur.trim()); cur = ''; }
    if (s.length > 260) { for (const p of s.split(/,\s*/)) { if ((cur + p).length > 220 && cur) { out.push(cur.trim()); cur = ''; } cur += p + ', '; } }
    else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(x => /\w/.test(x));
}

// ---------- Stimmen ----------
function voices() { return (synth?.getVoices() || []).filter(v => /^de/i.test(v.lang)); }
function pickVoice() {
  const vs = voices();
  return vs.find(v => v.voiceURI === settings.voice)
    || vs.find(v => /de-AT/i.test(v.lang))
    || vs.find(v => /natural|enhanced|premium|google/i.test(v.name))
    || vs[0] || null;
}

// ---------- Abspielen ----------
// items: [{ label, text } | { label, load: async () => text }]
export async function playAudio({ title, key, items, start = 0 }) {
  if (!audioSupported()) { alert('Dieses Gerät/Browser kann leider nicht vorlesen.'); return; }
  stopSpeech();
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS) || '{}')[key]; } catch {}
  st = { title, key, items, idx: start, chunks: [], cidx: 0, playing: true };
  if (pos && (pos.idx === start ? pos.cidx > 2 : start === 0 && pos.idx > 0) && pos.idx < items.length && confirm(`Dort weiterhören, wo du aufgehört hast${items[pos.idx]?.label ? ` („${items[pos.idx].label}“)` : ''}?`)) { st.idx = pos.idx; st.cidx = pos.cidx || 0; }
  ui();
  await loadItem();
  speakNext();
  keepAwake(true);
}
async function loadItem() {
  const it = st.items[st.idx];
  if (!it) return;
  st.loading = true; ui();
  try { const raw = it.text ?? await it.load(); st.chunks = chunk(speakable(raw)); }
  catch (e) { st.chunks = [`Dieser Abschnitt konnte nicht geladen werden.`]; console.warn(e); }
  st.loading = false;
  if (st.cidx >= st.chunks.length) st.cidx = 0;
  if (st.items.length > 1 || it.label) st.chunks.unshift(it.label + '.');
}
function savePos() {
  try { const all = JSON.parse(localStorage.getItem(POS) || '{}'); all[st.key] = { idx: st.idx, cidx: Math.max(0, st.cidx - 1), at: Date.now() }; localStorage.setItem(POS, JSON.stringify(all)); } catch {}
}
function stopSpeech() { token++; try { synth.cancel(); } catch {} }
function speakNext() {
  if (!st?.playing) return;
  if (st.cidx >= st.chunks.length) {
    if (st.idx + 1 < st.items.length) { st.idx++; st.cidx = 0; loadItem().then(speakNext); return; }
    st.playing = false; st.done = true; keepAwake(false); savePos(); ui(); return;
  }
  const my = ++token;
  const u = new SpeechSynthesisUtterance(st.chunks[st.cidx]);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'de-AT';
  u.rate = settings.rate;
  u.onend = () => { if (my !== token) return; st.cidx++; if (st.cidx % 5 === 0) savePos(); speakNext(); };
  u.onerror = e => { if (my !== token || e.error === 'interrupted' || e.error === 'canceled') return; st.cidx++; speakNext(); };
  synth.speak(u);
  ui();
}
function toggle() {
  if (!st) return;
  if (st.done) { st.done = false; st.idx = 0; st.cidx = 0; st.playing = true; loadItem().then(speakNext); keepAwake(true); return; }
  st.playing = !st.playing;
  if (st.playing) { keepAwake(true); speakNext(); } else { stopSpeech(); keepAwake(false); savePos(); ui(); }
}
function jumpChunk(d) { if (!st) return; stopSpeech(); st.cidx = Math.max(0, Math.min(st.chunks.length - 1, st.cidx + d)); st.playing = true; speakNext(); }
async function jumpItem(d) {
  if (!st) return;
  const n = st.idx + d;
  if (n < 0 || n >= st.items.length) { if (d < 0) jumpChunk(-999); return; }
  stopSpeech(); st.idx = n; st.cidx = 0; st.playing = true; await loadItem(); speakNext();
}
function close() { stopSpeech(); if (st) savePos(); st = null; keepAwake(false); ui(); }

async function keepAwake(on) {
  try {
    if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && st?.playing) keepAwake(true); });

// ---------- Mini-Player ----------
const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
function ui() {
  let el = document.getElementById('player');
  if (!st) { el?.remove(); document.body.classList.remove('has-player'); return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'player'; el.className = 'player';
    document.body.appendChild(el);
    el.onclick = e => {
      const a = e.target.closest('[data-p]')?.dataset.p;
      if (a === 'play') toggle();
      if (a === 'back') jumpChunk(-2);
      if (a === 'fwd') jumpChunk(2);
      if (a === 'prev') jumpItem(-1);
      if (a === 'next') jumpItem(1);
      if (a === 'x') close();
      if (a === 'rate') { settings.rate = RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length] || 1; saveSettings(); if (st.playing) { stopSpeech(); speakNext(); } else ui(); }
      if (a === 'voice') voiceMenu();
    };
  }
  document.body.classList.add('has-player');
  const it = st.items[st.idx] || {};
  const pct = st.chunks.length ? Math.round(100 * st.cidx / st.chunks.length) : 0;
  el.innerHTML = `<div class="player-bar" style="width:${pct}%"></div>
    <div class="player-info"><div class="player-title">🎧 ${esc(st.title)}</div><div class="tiny muted">${st.loading ? 'lädt …' : st.done ? 'fertig' : esc(it.label || '')}${st.items.length > 1 ? ` · ${st.idx + 1}/${st.items.length}` : ''}</div></div>
    <div class="player-btns">
      ${st.items.length > 1 ? '<button data-p="prev" title="Voriger Abschnitt">⏮</button>' : ''}
      <button data-p="back" title="Zurück">↺</button>
      <button data-p="play" class="pp" title="Abspielen/Pause">${st.playing ? '⏸' : '▶'}</button>
      <button data-p="fwd" title="Vor">↻</button>
      ${st.items.length > 1 ? '<button data-p="next" title="Nächster Abschnitt">⏭</button>' : ''}
      <button data-p="rate" title="Tempo">${String(settings.rate).replace('.', ',')}×</button>
      <button data-p="voice" title="Stimme">🗣</button>
      <button data-p="x" title="Schließen">✕</button>
    </div>`;
}
function voiceMenu() {
  const vs = voices();
  if (!vs.length) { alert('Auf diesem Gerät ist keine deutsche Stimme installiert. Am Handy: Einstellungen → Allgemeine Verwaltung → Sprache → Text-zu-Sprache → deutsche Sprachdaten laden.'); return; }
  const cur = pickVoice();
  const list = vs.map((v, i) => `${i + 1}. ${v.name} (${v.lang})${v === cur ? ' ✓' : ''}`).join('\n');
  const a = prompt(`Stimme wählen (Nummer eingeben):\n${list}`);
  const v = vs[(+a || 0) - 1];
  if (v) { settings.voice = v.voiceURI; saveSettings(); if (st?.playing) { stopSpeech(); speakNext(); } }
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
if (synth) synth.onvoiceschanged = () => {};
window.addEventListener('pagehide', () => { if (st) savePos(); });

// ---------- Texte zum Hören ----------
export function summaryListenText(s) {
  if (!s) return '';
  const parts = [];
  if (s.kurzfassung) parts.push('Worum geht es? ' + s.kurzfassung);
  for (const t of s.themen || []) parts.push(`${t.titel}. ${t.inhalt}`);
  if ((s.definitionen || []).length) parts.push('Die wichtigsten Begriffe. ' + s.definitionen.map(d => `${d.begriff}: ${d.definition}`).join('. '));
  for (const sc of s.schemata || []) parts.push(`Prüfungsschema ${sc.titel}. ` + (sc.schritte || []).map((x, i) => `Schritt ${i + 1}: ${String(x).replace(/^\d+\.\s*/, '')}`).join('. '));
  if ((s.stolperfallen || []).length) parts.push('Achtung, Stolperfallen. ' + s.stolperfallen.map(x => x.text || x).join('. '));
  return parts.join('\n\n');
}
export function skriptListenText(k) {
  if (!k) return '';
  const parts = [];
  if (k.kernaussage) parts.push('Worum es im Fall geht. ' + k.kernaussage);
  if ((k.anspruchsgrundlagen || []).length) parts.push('Anspruchsgrundlagen. ' + k.anspruchsgrundlagen.map(a => `${a.norm}: ${a.wofuer}`).join('. '));
  if ((k.pruefung || []).length) parts.push('Prüfung im Fall. ' + k.pruefung.map((p, i) => `${i + 1}. ${p.punkt}. ${(p.voraussetzungen || []).join('. ')}. ${p.details || ''}`).join('\n'));
  if ((k.klausurfallen || []).length) parts.push('Klausurfallen. ' + k.klausurfallen.map(x => x.text || x).join('. '));
  if ((k.rechtsprechung || []).length) parts.push('Rechtsprechung und Fußnoten. ' + k.rechtsprechung.map(x => x.text || x).join('. '));
  if ((k.beispiele || []).length) parts.push('Beispiele aus dem Buch. ' + k.beispiele.map(x => x.text || x).join('. '));
  return parts.join('\n\n');
}
