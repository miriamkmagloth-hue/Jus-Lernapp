// Zwei App-Stände (z. B. Laptop und Handy) zusammenführen, statt den einen mit dem anderen zu überschreiben.
// Grundsatz: Der neuere Stand ist die Basis; was dort fehlt, aber im anderen schon erarbeitet wurde
// (Zusammenfassungen, Fragenpools, Skripten, Schemata, Fälle, Fortschritt …), wird übernommen.

const filled = v => v != null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const byKey = (arr, key) => new Map((arr || []).map(x => [x?.[key], x]));

const CHAPTER_FIELDS = ['summary', 'pool', 'skript', 'cases', 'chat', 'miniChat', 'summarizedAt'];

function mergeChapters(base = [], other = []) {
  const o = byKey(other, 'id');
  return base.map(c => {
    const x = o.get(c.id);
    if (!x) return c;
    const out = { ...c };
    for (const f of CHAPTER_FIELDS) {
      if (!filled(out[f]) && filled(x[f])) out[f] = x[f];
      // Verläufe: den längeren behalten
      if ((f === 'chat' || f === 'miniChat') && Array.isArray(x[f]) && Array.isArray(out[f]) && x[f].length > out[f].length) out[f] = x[f];
    }
    if (out.summary && out.status !== 'fertig' && x.status === 'fertig') out.status = 'fertig';
    return out;
  });
}

function mergeVisuals(base = [], other = []) {
  const o = byKey(other, 'id');
  const out = base.map(v => (!v.schema && o.get(v.id)?.schema ? { ...v, schema: o.get(v.id).schema } : v));
  for (const v of other) if (!out.some(x => x.id === v.id)) out.push(v);
  return out;
}

function mergeBooks(base = [], other = []) {
  const o = byKey(other, 'fileId');
  const out = base.map(b => {
    const x = o.get(b.fileId);
    if (!x) return b;
    const m = { ...b, chapters: mergeChapters(b.chapters, x.chapters), visuals: mergeVisuals(b.visuals, x.visuals) };
    // laufender Hintergrund-Auftrag nicht verlieren
    if (!m.batch && x.batch) m.batch = x.batch;
    if (m.status !== 'fertig' && x.status === 'fertig' && m.chapters.every(c => c.summary || c.cases || c.hidden)) m.status = 'fertig';
    return m;
  });
  for (const x of other) if (!out.some(b => b.fileId === x.fileId)) out.push(x);
  return out;
}

function mergeList(base = [], other = [], key, better) {
  const out = [...base];
  for (const x of other) {
    const i = out.findIndex(y => y?.[key] === x?.[key]);
    if (i < 0) out.push(x);
    else if (better && better(x, out[i])) out[i] = { ...out[i], ...x };
  }
  return out;
}

function mergeSubjects(base = [], other = []) {
  const o = byKey(other, 'id');
  const out = base.map(s => {
    const x = o.get(s.id);
    if (!x) return s;
    return {
      ...s,
      books: mergeBooks(s.books, x.books),
      units: mergeList(s.units, x.units, 'fileId', (a, b) => a.analysis && !b.analysis),
      altklausuren: mergeList(s.altklausuren, x.altklausuren, 'fileId', (a, b) => a.analysis && !b.analysis),
      rulings: mergeList(s.rulings, x.rulings, 'id', (a, b) => (a.head && !b.head) || (a.summary && !b.summary) || (a.chapterIds?.length && !b.chapterIds?.length)),
      chat: (x.chat || []).length > (s.chat || []).length ? x.chat : s.chat,
    };
  });
  for (const x of other) if (!out.some(s => s.id === x.id)) out.push(x);
  return out;
}

function mergeProgress(a = {}, b = {}) {
  const out = { ...a };
  // Kapitel: das mit mehr Übungen / jüngerem Lernen
  out.chapters = { ...(b.chapters || {}), ...(a.chapters || {}) };
  for (const [id, x] of Object.entries(b.chapters || {})) {
    const y = a.chapters?.[id];
    if (y && ((x.quizzes?.length || 0) > (y.quizzes?.length || 0) || (x.lastStudied || 0) > (y.lastStudied || 0))) out.chapters[id] = x;
  }
  // Begriffe: der weiter fortgeschrittene Stand
  out.terms = { ...(b.terms || {}), ...(a.terms || {}) };
  for (const [k, x] of Object.entries(b.terms || {})) { const y = a.terms?.[k]; if (y && (x.seen || 0) > (y.seen || 0)) out.terms[k] = x; }
  out.termsHidden = { ...(b.termsHidden || {}), ...(a.termsHidden || {}) };
  out.poolSeen = { ...(b.poolSeen || {}) };
  for (const [k, n] of Object.entries(a.poolSeen || {})) out.poolSeen[k] = Math.max(n, out.poolSeen[k] || 0);
  const union = (x = [], y = [], key = 'at') => { const seen = new Set(x.map(i => JSON.stringify([i?.[key], i?.question || i?.id || '']))); return [...x, ...y.filter(i => !seen.has(JSON.stringify([i?.[key], i?.question || i?.id || ''])))]; };
  for (const k of ['mistakes', 'sessions', 'quizzes', 'cases', 'orals']) if (Array.isArray(a[k]) || Array.isArray(b[k])) out[k] = union(a[k], b[k]);
  for (const k of Object.keys(b)) if (!(k in out)) out[k] = b[k];
  return out;
}

export function mergeStates(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  const newerIsLocal = (local.updatedAt || 0) >= (remote.updatedAt || 0);
  const base = newerIsLocal ? local : remote, other = newerIsLocal ? remote : local;
  const out = { ...base };
  out.subjects = mergeSubjects(base.subjects, other.subjects);
  out.progress = mergeProgress(base.progress, other.progress);
  out.cards = { ...(other.cards || {}), ...(base.cards || {}) };
  out.srs = { ...(other.srs || {}), ...(base.srs || {}) };
  // Kosten: pro Tag den höheren Wert
  const days = { ...(other.usage?.days || {}) };
  for (const [d, v] of Object.entries(base.usage?.days || {})) if (!days[d] || (v.usd || 0) >= (days[d].usd || 0)) days[d] = v;
  out.usage = { ...(base.usage || {}), days };
  // Schlüssel nie durch leere Werte ersetzen
  out.settings = { ...(other.settings || {}), ...(base.settings || {}) };
  out.settings.keys = { ...Object.fromEntries(Object.entries(other.settings?.keys || {}).filter(([, v]) => v)), ...Object.fromEntries(Object.entries(base.settings?.keys || {}).filter(([, v]) => v)) };
  out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  return out;
}
