// Verarbeitung: Ordner scannen, Lehrbücher gliedern und zusammenfassen, Transkripte/Altklausuren/Urteile analysieren
import { store, uid, textGet, textSet, allChapters, findChapter, isStudyChapter, bookRole } from './store.js';
import { listRecursive, downloadFile, getFileMeta, readAppFile, writeAppFile, isSignedIn } from './drive.js';
import { fileToText, isSupported, pagesToText } from './extract.js';
import { completeJson, clip } from './ai.js';
import { searchJustiz, fetchDocText, toRisNorm, extractCitations } from './ris.js';

export const CATEGORIES = {
  books: { label: 'Lehrbücher', hint: 'Die PDF-Lehrbücher dieses Fachs' },
  transcripts: { label: 'Transkripte der Einheiten', hint: 'z. B. Ordner „Transkripte“ der Arbeitsgemeinschaft oder Vorlesung' },
  exams: { label: 'Altklausuren', hint: 'optional' },
  rulings: { label: 'Eigene Urteile (z. B. aus LexisNexis)', hint: 'optional' },
  scope: { label: 'Stoffeingrenzungen', hint: 'optional – die App fragt später, welche zu welcher Prüfung gehört' },
  protocols: { label: 'Prüferprotokolle', hint: 'optional, für die mündliche Prüfung' }
};

const stripExt = n => (n || '').replace(/\.(pdf|docx|txt|md|srt|vtt|rtf)$/i, '');

// ---------- Ordner scannen, neue Dateien erkennen ----------
export async function scanSubject(subId, onStatus = () => {}) {
  const sub = store.subject(subId);
  const found = {};
  for (const cat of Object.keys(CATEGORIES)) {
    for (const entry of sub.folders[cat] || []) {
      onStatus(`Durchsuche ${entry.name} …`);
      let files = [];
      if (entry.isFolder === false) { try { files = [{ ...(await getFileMeta(entry.id)), path: '' }]; } catch {} }
      else files = await listRecursive(entry.id);
      for (const f of files) if (isSupported(f)) found[f.id] = { ...f, category: cat };
    }
  }
  const newOnes = [];
  store.update(s => {
    const sb = s.subjects.find(x => x.id === subId);
    for (const f of Object.values(found)) {
      const prev = sb.files[f.id];
      if (!prev) {
        sb.files[f.id] = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, path: f.path, category: f.category, addedAt: Date.now(), isNew: !!sb.lastScan };
        newOnes.push(f);
        registerItem(sb, f);
      } else {
        if (prev.modifiedTime !== f.modifiedTime) { prev.modifiedTime = f.modifiedTime; prev.changed = true; }
        prev.name = f.name; prev.path = f.path; prev.category = f.category;
        if (!itemExists(sb, f)) registerItem(sb, f);
      }
    }
    sb.lastScan = Date.now();
  });
  return newOnes;
}

function itemExists(sb, f) {
  const lists = { books: sb.books, transcripts: sb.units, exams: sb.altklausuren, rulings: sb.rulings };
  const l = lists[f.category];
  return !l || l.some(x => x.fileId === f.id);
}

function registerItem(sb, f) {
  const title = stripExt(f.name);
  if (f.category === 'books') sb.books.push({ fileId: f.id, title, status: 'neu', chapters: [] });
  if (f.category === 'transcripts') sb.units.push({ fileId: f.id, title, path: f.path, status: 'neu', addedAt: Date.now(), chat: [] });
  if (f.category === 'exams') sb.altklausuren.push({ fileId: f.id, title, status: 'neu' });
  if (f.category === 'rulings') sb.rulings.push({ id: 'up_' + f.id, fileId: f.id, source: 'upload', title, status: 'neu', isNew: true, addedAt: Date.now(), chat: [] });
}

// ---------- Text einer Datei holen (mit lokalem Zwischenspeicher) ----------
const textName = fileId => `text-${fileId}.json`;

export async function getFileText(sub, fileId, onProgress) {
  const cached = await textGet('file:' + fileId);
  const meta = sub.files[fileId];
  const fresh = v => v && (!meta || v.modifiedTime === meta.modifiedTime);
  if (fresh(cached)) {
    if (!cached.shared && cached.pages) shareText(fileId, cached);
    return cached;
  }
  // Schon auf einem anderen Gerät ausgelesen? Dann von dort holen (spart Download und Auslesen am Handy)
  if (isSignedIn()) {
    try {
      onProgress && onProgress(0, 0);
      const remote = await readAppFile(textName(fileId));
      if (fresh(remote)) {
        const val = { ...remote, text: remote.pages ? pagesToText(remote.pages) : remote.text, shared: true };
        await textSet('file:' + fileId, val);
        return val;
      }
    } catch (e) { console.warn('Geteilter Text nicht lesbar', e); }
  }
  const file = meta || await getFileMeta(fileId);
  const data = await downloadFile(file);
  const r = await fileToText(file, data, onProgress);
  const val = { text: r.text, pages: r.pages, outline: r.outline || [], modifiedTime: file.modifiedTime };
  await textSet('file:' + fileId, val);
  if (val.pages) shareText(fileId, val);
  return val;
}

// Bereits ausgelesene Bücher dieses Geräts für andere Geräte bereitstellen
export async function shareAllTexts(sub) {
  for (const b of sub.books || []) {
    const v = await textGet('file:' + b.fileId);
    if (v && v.pages && !v.shared) shareText(b.fileId, v);
  }
}

// Ausgelesenen Text im privaten App-Datenordner ablegen, damit andere Geräte ihn nicht neu auslesen müssen
const sharing = new Set();
function shareText(fileId, val) {
  if (!isSignedIn() || sharing.has(fileId)) return;
  sharing.add(fileId);
  writeAppFile(textName(fileId), { pages: val.pages, outline: val.outline || [], text: val.pages ? '' : val.text, modifiedTime: val.modifiedTime })
    .then(() => textSet('file:' + fileId, { ...val, shared: true }))
    .catch(e => console.warn('Text nicht geteilt', e))
    .finally(() => sharing.delete(fileId));
}

export async function chapterText(sub, chId) {
  const f = findChapter(sub, chId);
  if (!f) return '';
  const t = await getFileText(sub, f.book.fileId);
  if (!t.pages) return t.text;
  return pagesToText(t.pages, f.chapter.startPage, f.chapter.endPage);
}

function patchBook(subId, fileId, fn) {
  store.update(s => {
    const b = s.subjects.find(x => x.id === subId).books.find(x => x.fileId === fileId);
    if (b) fn(b);
  });
}

// ---------- Lehrbuch: Gliederung + Zusammenfassungen ----------
const SKIP_TITLES = { test: t => !isStudyChapter({ title: t }) || /^(cover|umschlag|titel|titelseite)$/i.test(String(t).trim()) };

export async function processBook(subId, fileId, onStatus = () => {}) {
  let sub = store.subject(subId);
  const role0 = bookRole(sub.books.find(b => b.fileId === fileId) || {});
  if (role0 === 'faelle' && !sub.books.some(b => bookRole(b) === 'stoff' && b.chapters?.length)) onStatus('Hinweis: Lehrbücher sind noch nicht gegliedert – Zuordnung zu Kapiteln fehlt dann.');
  if (role0 === 'aus') { onStatus('übersprungen (nicht verwenden)'); return; }
  if (role0 === 'nachschlag') {
    // Nachschlagewerk (z. B. Gesetzestext): nur Text einlesen, nicht zusammenfassen – kostet nichts
    patchBook(subId, fileId, b => { b.status = 'läuft'; b.error = null; });
    try {
      const t = await getFileText(sub, fileId, (i, n) => onStatus(`Lese Seite ${i} von ${n} …`));
      patchBook(subId, fileId, b => { b.status = 'nachschlagbar'; b.numPages = t.pages?.length || b.numPages; });
    } catch (e) { patchBook(subId, fileId, b => { b.status = 'fehler'; b.error = e.message; }); throw e; }
    return;
  }
  patchBook(subId, fileId, b => { b.status = 'läuft'; b.error = null; });
  try {
    onStatus('Lade und lese PDF …');
    const t = await getFileText(sub, fileId, (i, n) => onStatus(`Lese Seite ${i} von ${n} …`));
    if (!t.pages) throw new Error('Lehrbücher bitte als PDF ablegen.');
    const textChars = t.pages.reduce((a, p) => a + p.text.length, 0);
    if (textChars < t.pages.length * 50) throw new Error('Das PDF enthält kaum lesbaren Text (eingescannt?). Bitte eine PDF-Version mit Text verwenden oder vorher Texterkennung (OCR) laufen lassen.');

    let book = store.subject(subId).books.find(b => b.fileId === fileId);
    if (!book.chapters?.length) {
      onStatus('Erkenne Kapitel …');
      const chapters = await detectChapters(t.pages, t.outline);
      const cits = extractCitations(t.pages.map(p => p.text).join('\n'));
      patchBook(subId, fileId, b => {
        b.numPages = t.pages.length;
        b.chapters = chapters.map(c => ({ id: uid('k_'), title: c.title, startPage: c.start, endPage: c.end, startLabel: t.pages[c.start - 1]?.label, endLabel: t.pages[c.end - 1]?.label, pages: c.end - c.start + 1, summary: null, status: 'neu' }));
        b.citations = { gz: cits.gz.slice(0, 150), rs: cits.rs.slice(0, 150) };
        b.status = 'gegliedert';
      });
    }
    book = store.subject(subId).books.find(b => b.fileId === fileId);
    if (bookRole(book) === 'faelle') {
      const todoF = book.chapters.filter(c => !c.cases);
      let j = 0;
      for (const ch of todoF) {
        j++;
        const cur = store.subject(subId).books.find(b => b.fileId === fileId);
        if (!cur || bookRole(cur) !== 'faelle') { patchBook(subId, fileId, b => { b.status = 'pausiert'; }); onStatus('angehalten'); return; }
        if (!isStudyChapter(ch)) { patchCases(subId, fileId, ch.id, []); continue; }
        onStatus(`Löse Fälle heraus (${j} von ${todoF.length}): ${ch.title}`);
        await extractCases(subId, fileId, ch.id, t.pages);
      }
      patchBook(subId, fileId, b => { b.status = 'fertig'; });
      store.update(s => { const f = s.subjects.find(x => x.id === subId).files[fileId]; if (f) { f.isNew = false; f.changed = false; } });
      onStatus('Fertig');
      return;
    }
    const todo = book.chapters.filter(c => !c.summary);
    let i = 0;
    for (const ch of todo) {
      i++;
      const cur = store.subject(subId).books.find(b => b.fileId === fileId);
      if (!cur || bookRole(cur) !== 'stoff') { patchBook(subId, fileId, b => { b.status = 'pausiert'; }); onStatus('angehalten'); return; }
      if (!isStudyChapter(ch)) continue;
      onStatus(`Fasse Kapitel ${i} von ${todo.length} zusammen: ${ch.title}`);
      await summarizeChapter(subId, fileId, ch.id, t.pages);
    }
    patchBook(subId, fileId, b => { b.status = 'fertig'; });
    store.update(s => { const f = s.subjects.find(x => x.id === subId).files[fileId]; if (f) { f.isNew = false; f.changed = false; } });
    onStatus('Fertig');
  } catch (e) {
    patchBook(subId, fileId, b => { b.status = 'fehler'; b.error = e.message; });
    throw e;
  }
}

export async function detectChapters(pages, outline) {
  const n = pages.length;
  const skipPages = (outline || []).filter(o => o.page && o.level <= 1 && SKIP_TITLES.test(o.title || '')).map(o => o.page);
  let entries = (outline || []).filter(o => o.page && o.title && !SKIP_TITLES.test(o.title));
  let chosen = [];
  if (entries.length) {
    const lvl0 = entries.filter(e => e.level === 0);
    const base = lvl0.length >= 3 ? lvl0 : entries.filter(e => e.level === 1).length >= 3 ? entries.filter(e => e.level === 1) : entries;
    // zu große Kapitel in Unterkapitel aufteilen
    for (let i = 0; i < base.length; i++) {
      const e = base[i];
      const next = base[i + 1]?.page || n + 1;
      const size = next - e.page;
      const kids = entries.filter(k => k.level === e.level + 1 && k.page >= e.page && k.page < next);
      if (size > 70 && kids.length >= 2) {
        if (kids[0].page > e.page) chosen.push({ title: e.title, page: e.page });
        kids.forEach(k => chosen.push({ title: `${e.title} – ${k.title}`, page: k.page }));
      } else chosen.push({ title: e.title, page: e.page });
    }
  }
  if (chosen.length < 3) chosen = await detectChaptersAI(pages);
  chosen = chosen.filter(c => c.page >= 1 && c.page <= n).sort((a, b) => a.page - b.page);
  // doppelte Startseiten zusammenfassen
  const dedup = [];
  for (const c of chosen) {
    const last = dedup[dedup.length - 1];
    if (last && last.page === c.page) last.title += ' / ' + c.title; else dedup.push({ ...c });
  }
  if (!dedup.length) dedup.push({ title: 'Gesamtes Buch', page: 1 });
  const bounds = [...dedup.map(c => c.page), ...skipPages, n + 1].sort((a, b) => a - b);
  return dedup.map(c => ({ title: c.title, start: c.page, end: Math.max(c.page, bounds.find(p => p > c.page) - 1) }));
}

async function detectChaptersAI(pages) {
  const head = pages.slice(0, 35).map(p => `[PDF-Seite ${p.n} | Seitenzahl ${p.label}]\n${p.text}`).join('\n\n');
  const r = await completeJson({
    model: 'fast', maxTokens: 6000,
    system: 'Du analysierst das Inhaltsverzeichnis eines juristischen Lehrbuchs.',
    messages: [{ role: 'user', content: `Hier sind die ersten Seiten eines Lehrbuchs. Finde das Inhaltsverzeichnis und gib die Hauptkapitel (sinnvolle Lerneinheiten, typischerweise 8–40 Stück; zu große Teile in ihre Abschnitte zerlegen) zurück.\nFormat: {"kapitel":[{"titel":"…","seite":"gedruckte Seitenzahl laut Inhaltsverzeichnis"}]}\nLass Vorwort, Verzeichnisse und Register weg.\n\n${clip(head, 90000)}` }]
  });
  const list = r.kapitel || [];
  // gedruckte Seitenzahl -> PDF-Seite
  const byLabel = new Map(pages.map(p => [String(p.label).trim(), p.n]));
  const tocEnd = 20;
  const offsets = [];
  const norm = s => s.toLowerCase().replace(/[^a-zäöüß0-9]+/g, ' ').trim();
  for (const k of list) {
    const key = norm(k.titel).slice(0, 28);
    if (key.length < 6) continue;
    const hit = pages.find(p => p.n > tocEnd && norm(p.text.slice(0, 600)).includes(key));
    const printed = parseInt(k.seite, 10);
    if (hit && !isNaN(printed)) offsets.push(hit.n - printed);
  }
  offsets.sort((a, b) => a - b);
  const offset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0;
  return list.map(k => {
    const lab = String(k.seite).trim();
    let page = byLabel.get(lab);
    if (!page) { const p = parseInt(lab, 10); if (!isNaN(p)) page = p + offset; }
    return { title: k.titel, page };
  }).filter(c => c.page);
}

export async function summarizeChapter(subId, fileId, chId, pagesOpt) {
  const sub = store.subject(subId);
  const book = sub.books.find(b => b.fileId === fileId);
  const ch = book.chapters.find(c => c.id === chId);
  const pages = pagesOpt || (await getFileText(sub, fileId)).pages;
  const text = pagesToText(pages, ch.startPage, ch.endPage);
  const r = await completeJson({
    model: 'smart', maxTokens: 9000,
    system: `Du erstellst prüfungsorientierte Lernzusammenfassungen eines Lehrbuchkapitels. Verwende NUR den Kapiteltext. Nichts hinzufügen, nichts Wesentliches weglassen. Jede Aussage mit Seitenangabe [S. x]. Fasse nur den juristischen Inhalt zusammen; Inhaltsverzeichnisse, Gliederungsübersichten, Vorworte, Literatur- und Abkürzungsverzeichnisse, Kopfzeilen und Randziffern ignorierst du.`,
    messages: [{ role: 'user', content: `Lehrbuch: „${book.title}“\nKapitel: „${ch.title}“\n\nErstelle eine strukturierte Zusammenfassung als JSON:\n{\n "pruefungsrelevant": true, (false NUR wenn der Text kein juristischer Lernstoff ist, z. B. reines Inhaltsverzeichnis, Vorwort, Verzeichnisse, Register)\n "kurzfassung": "3–6 Sätze: worum geht es inhaltlich (Rechtsinstitute, Probleme), nicht wie das Kapitel aufgebaut ist",\n "themen": [{"titel": "…", "inhalt": "ausführliche, prüfungsrelevante Darstellung in Markdown mit Seitenangaben", "seiten": "S. x–y", "ebene": "basis|vertiefung"}],\n "definitionen": [{"begriff": "…", "definition": "…", "seite": "…", "ebene": "basis|vertiefung"}],\n "normen": ["§ 1295 ABGB", …],\n "stolperfallen": [{"text": "typische Fehler, Abgrenzungen, Ausnahmen", "seite": "…"}],\n "schemata": [{"titel": "Prüfungsschema …", "schritte": ["…"]}],\n "entscheidungen": ["im Text zitierte OGH-Entscheidungen, z. B. 1 Ob 123/05x"],\n "schlagworte": ["…"],\n "lernzeitMinuten": realistische Lernzeit für jemanden ohne Vorwissen (Zahl)\n}\nLeere Listen sind erlaubt. Gib Schemata nur an, wenn sie im Text angelegt sind.\n\nKAPITELTEXT:\n${clip(text, 320000)}` }]
  });
  store.update(s => {
    const b = s.subjects.find(x => x.id === subId).books.find(x => x.fileId === fileId);
    const c = b.chapters.find(x => x.id === chId);
    c.summary = r; c.status = 'fertig'; c.summarizedAt = Date.now();
  });
  return r;
}

function patchCases(subId, fileId, chId, cases) {
  store.update(s => {
    const b = s.subjects.find(x => x.id === subId).books.find(x => x.fileId === fileId);
    const c = b.chapters.find(x => x.id === chId);
    c.cases = cases; c.status = 'fertig';
  });
}

// Fallsammlung: Fälle samt Originallösung herauslösen und auf den Lehrbuchstoff beziehen
export async function extractCases(subId, fileId, chId, pagesOpt) {
  const sub = store.subject(subId);
  const book = sub.books.find(b => b.fileId === fileId);
  const ch = book.chapters.find(c => c.id === chId);
  const pages = pagesOpt || (await getFileText(sub, fileId)).pages;
  const text = pagesToText(pages, ch.startPage, ch.endPage);
  const r = await completeJson({
    model: 'smart', maxTokens: 12000,
    system: 'Du arbeitest eine juristische FALLSAMMLUNG (Übungsfälle mit Lösungen, österreichisches Recht) auf. Gib die Fälle und die Lösungen des Buchs wieder – erfinde keine eigenen Lösungen. Ordne jede rechtliche Aussage aus den Lösungen dem passenden Kapitel der Lehrbücher zu, damit der Lehrbuchstoff anhand der Fälle wiederholt werden kann.',
    messages: [{ role: 'user', content: `Fallsammlung: „${book.title}“, Abschnitt: „${ch.title}“\n\nJSON:\n{\n "faelle": [{\n   "titel": "kurzer Titel",\n   "sachverhalt": "Sachverhalt möglichst wörtlich",\n   "fragen": ["Fallfragen"],\n   "loesung": "die Lösung des Buchs, gegliedert (Markdown), mit Seitenangaben – vollständig, nur sprachlich gestrafft",\n   "ansprueche": [{"wer": "…", "gegen": "…", "was": "…", "grundlage": "Anspruchsgrundlage mit Norm", "ergebnis": "…"}],\n   "aussagen": [{"aussage": "eine allgemeine Rechtsaussage aus der Lösung, die über den Fall hinaus gilt", "kapitelId": "passendes Lehrbuchkapitel", "ebene": "basis|vertiefung"}],\n   "stolperfallen": ["…"],\n   "kapitelIds": ["Lehrbuchkapitel, deren Stoff der Fall prüft"],\n   "schwierigkeit": "einfach|mittel|schwer"\n }]\n}\nWenn der Abschnitt keine Fälle enthält (z. B. nur Einleitung oder Methodik), gib {"faelle": []} zurück, aber übernimm allgemeine Hinweise zur Falllösungstechnik als Fall mit titel "Hinweise zur Falllösung" nur dann, wenn sie wirklich prüfungsrelevant sind.\n\nLEHRBUCHKAPITEL (ID | Titel):\n${chapterListForPrompt(sub) || '(noch keine)'}\n\nTEXT DER FALLSAMMLUNG:\n${clip(text, 300000)}` }]
  });
  const cases = (r.faelle || []).filter(f => f && (f.sachverhalt || f.loesung));
  patchCases(subId, fileId, chId, cases);
  return cases;
}

function chapterListForPrompt(sub, withSummary = false) {
  return allChapters(sub).map(c => `${c.id} | ${c.title}${withSummary && c.summary?.kurzfassung ? ' — ' + c.summary.kurzfassung.slice(0, 220) : ''}`).join('\n');
}

// ---------- Einheiten (Transkripte) ----------
export async function analyzeUnit(subId, fileId, onStatus = () => {}) {
  const sub = store.subject(subId);
  const patch = fn => store.update(s => { const u = s.subjects.find(x => x.id === subId).units.find(x => x.fileId === fileId); u && fn(u); });
  patch(u => { u.status = 'läuft'; u.error = null; });
  try {
    onStatus('Lade Transkript …');
    const t = await getFileText(sub, fileId);
    onStatus('Analysiere Einheit …');
    const unit = sub.units.find(u => u.fileId === fileId);
    const r = await completeJson({
      model: 'smart', maxTokens: 8000,
      system: 'Du analysierst das Transkript einer Lehrveranstaltungseinheit (Vorlesung/Arbeitsgemeinschaft). Gib nur wieder, was im Transkript vorkommt. Transkripte enthalten Sprechfehler – interpretiere sinnvoll.',
      messages: [{ role: 'user', content: `Einheit: „${unit.title}“\n\nAnalysiere als JSON:\n{\n "thema": "Hauptthema in einer Zeile",\n "ueberblick": "Worum ging es in der Einheit (Markdown, 1–3 Absätze)",\n "kernthemen": [{"titel": "…", "erklaerung": "prüfungsrelevante Erklärung in Markdown"}],\n "stolperfallen": ["…"],\n "profBetont": [{"hinweis": "Was die Vortragende/der Vortragende als wichtig/prüfungsrelevant betont hat", "kontext": "kurzes Zitat oder Umschreibung"}],\n "faelle": [{"kurz": "in der Einheit besprochene Fälle/Beispiele", "loesung": "…"}],\n "begriffe": [{"begriff": "…", "erklaerung": "…"}],\n "normen": ["§ … ABGB"],\n "kapitelIds": ["IDs der passenden Lehrbuchkapitel aus der Liste unten"]\n}\n\nLEHRBUCHKAPITEL (ID | Titel):\n${chapterListForPrompt(sub) || '(noch keine)'}\n\nTRANSKRIPT:\n${clip(t.text, 260000)}` }]
    });
    patch(u => { u.analysis = r; u.status = 'fertig'; u.analyzedAt = Date.now(); });
    store.update(s => { const f = s.subjects.find(x => x.id === subId).files[fileId]; if (f) { f.isNew = false; f.changed = false; } });
    return r;
  } catch (e) { patch(u => { u.status = 'fehler'; u.error = e.message; }); throw e; }
}

// ---------- Altklausuren ----------
export async function analyzeAltklausur(subId, fileId, onStatus = () => {}) {
  const sub = store.subject(subId);
  const patch = fn => store.update(s => { const u = s.subjects.find(x => x.id === subId).altklausuren.find(x => x.fileId === fileId); u && fn(u); });
  patch(u => { u.status = 'läuft'; u.error = null; });
  try {
    onStatus('Lade Klausur …');
    const t = await getFileText(sub, fileId);
    onStatus('Analysiere Klausur …');
    const k = sub.altklausuren.find(x => x.fileId === fileId);
    const r = await completeJson({
      model: 'smart', maxTokens: 9000,
      system: 'Du analysierst eine juristische Altklausur (österreichisches Recht) für die Prüfungsvorbereitung. Wenn eine Lösung/Musterlösung beiliegt, nutze sie. Sonst leite die Lösung aus dem österreichischen Recht ab und kennzeichne sie als „Lösungsskizze (KI)“.',
      messages: [{ role: 'user', content: `Altklausur: „${k.title}“\n\nJSON:\n{\n "titel": "…", "datum": "falls erkennbar", "dauer": "falls erkennbar",\n "faelle": [{\n   "nr": 1, "kurz": "Schlagwort-Titel des Falls", "sachverhalt": "der Sachverhalt möglichst wörtlich", "fragen": ["Fallfragen"],\n   "ansprueche": [{"wer": "…", "gegen": "…", "was": "…", "grundlage": "Anspruchsgrundlage mit Norm"}],\n   "loesung": "Lösungsskizze in Markdown", "loesungQuelle": "Musterlösung|KI",\n   "themen": ["…"], "kapitelIds": ["passende Kapitel-IDs"], "stolperfallen": ["…"]\n }],\n "schwerpunkte": ["Themen-Schwerpunkte der Klausur"],\n "stolperfallen": ["übergreifende Fallen"]\n}\n\nLEHRBUCHKAPITEL (ID | Titel):\n${chapterListForPrompt(sub) || '(noch keine)'}\n\nKLAUSUR:\n${clip(t.text, 200000)}` }]
    });
    patch(u => { u.analysis = r; u.status = 'fertig'; u.analyzedAt = Date.now(); });
    store.update(s => { const sb = s.subjects.find(x => x.id === subId); sb.altOverview = null; const f = sb.files[fileId]; if (f) { f.isNew = false; f.changed = false; } });
    return r;
  } catch (e) { patch(u => { u.status = 'fehler'; u.error = e.message; }); throw e; }
}

export async function altklausurOverview(subId) {
  const sub = store.subject(subId);
  const done = sub.altklausuren.filter(k => k.analysis);
  const digest = done.map(k => ({ titel: k.title, faelle: (k.analysis.faelle || []).map(f => ({ kurz: f.kurz, themen: f.themen, ansprueche: (f.ansprueche || []).map(a => a.grundlage), kapitelIds: f.kapitelIds, stolperfallen: f.stolperfallen })), schwerpunkte: k.analysis.schwerpunkte }));
  const r = await completeJson({
    model: 'smart', maxTokens: 6000,
    system: 'Du wertest mehrere analysierte Altklausuren gemeinsam aus.',
    messages: [{ role: 'user', content: `JSON:\n{\n "dauerbrenner": [{"thema": "…", "haeufigkeit": Anzahl Klausuren, "kapitelIds": ["…"], "typischeKonstellation": "…"}],\n "anspruchsgrundlagen": [{"grundlage": "…", "haeufigkeit": Zahl}],\n "stolperfallen": ["immer wiederkehrende Fallen"],\n "muster": "Wie sind die Klausuren aufgebaut (Markdown)",\n "empfehlungen": ["konkrete Lernempfehlungen"]\n}\n\nKAPITEL:\n${chapterListForPrompt(sub)}\n\nALTKLAUSUREN:\n${JSON.stringify(digest).slice(0, 150000)}` }]
  });
  store.update(s => { s.subjects.find(x => x.id === subId).altOverview = { ...r, at: Date.now(), count: done.length }; });
  return r;
}

// ---------- Stoffeingrenzung ----------
export async function mapScope(subId, examId, onStatus = () => {}) {
  const sub = store.subject(subId);
  const exam = sub.exams.find(e => e.id === examId);
  let scopeText = exam.scopeText || '';
  for (const fid of exam.scopeFileIds || []) {
    onStatus('Lese Stoffeingrenzung …');
    const t = await getFileText(sub, fid);
    scopeText += '\n\n' + t.text;
  }
  if (!scopeText.trim()) throw new Error('Keine Stoffeingrenzung vorhanden.');
  onStatus('Ordne Stoffeingrenzung den Kapiteln zu …');
  const r = await completeJson({
    model: 'smart', maxTokens: 6000,
    system: 'Du ordnest eine Stoffeingrenzung den Kapiteln von Lehrbüchern zu.',
    messages: [{ role: 'user', content: `Prüfung: ${exam.name} (${exam.type})\n\nOrdne JEDEM Kapitel einen Status zu:\n- "muss": ausdrücklich Prüfungsstoff und zentral\n- "wichtig": Prüfungsstoff\n- "optional": nur am Rande / Grundlagenwissen\n- "raus": laut Eingrenzung nicht Prüfungsstoff\nJSON: {"kapitel": [{"id": "…", "status": "…", "grund": "kurz"}], "hinweise": "Besonderheiten der Eingrenzung (Markdown)"}\n\nKAPITEL (ID | Titel — Kurzfassung):\n${chapterListForPrompt(sub, true)}\n\nSTOFFEINGRENZUNG:\n${clip(scopeText, 60000)}` }]
  });
  store.update(s => {
    const e = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId);
    e.scopeMap = {}; (r.kapitel || []).forEach(k => { e.scopeMap[k.id] = k.status; });
    e.scopeNotes = r.hinweise || '';
  });
  return r;
}

// ---------- OGH-Urteile ----------
export function subjectNorms(sub) {
  const counts = new Map();
  for (const c of allChapters(sub)) for (const n of c.summary?.normen || []) {
    const r = toRisNorm(n);
    if (r) counts.set(r, (counts.get(r) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ norm: n, count: c }));
}

export async function checkNewRulings(subId, onStatus = () => {}, { maxNorms = 40 } = {}) {
  const sub = store.subject(subId);
  const norms = subjectNorms(sub).slice(0, maxNorms);
  if (!norms.length) throw new Error('Noch keine Normen bekannt – bitte zuerst die Lehrbücher verarbeiten.');
  const last = sub.rulingMeta?.lastCheck;
  const from = new Date(last ? last - 7 * 86400000 : Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const found = new Map();
  let i = 0;
  for (const { norm } of norms) {
    i++;
    onStatus(`Suche im RIS (${i}/${norms.length}): ${norm}`);
    try {
      const r = await searchJustiz({ norm, von: from, proSeite: 'Fifty' });
      for (const it of r.items) {
        if (!it.gz) continue;
        const key = it.gz.replace(/\s+/g, '');
        const cur = found.get(key) || { gz: it.gz, date: it.date, normen: new Set(), rsDocs: new Set(), textDocs: new Set(), schlagworte: '', matched: new Set(), url: it.url };
        it.normen.forEach(n => cur.normen.add(n));
        if (it.docNr?.startsWith('JJR')) cur.rsDocs.add(it.docNr);
        if (it.docNr?.startsWith('JJT')) cur.textDocs.add(it.docNr);
        it.textDocs.forEach(d => cur.textDocs.add(d));
        if (it.date > cur.date) cur.date = it.date;
        cur.schlagworte = cur.schlagworte || it.schlagworte;
        cur.matched.add(norm);
        found.set(key, cur);
      }
    } catch (e) {
      if (i === 1) throw e;
      console.warn(norm, e);
    }
    await new Promise(r => setTimeout(r, 700));
  }
  let added = 0;
  store.update(s => {
    const sb = s.subjects.find(x => x.id === subId);
    const existing = new Map(sb.rulings.filter(r => r.gz).map(r => [r.gz.replace(/\s+/g, ''), r]));
    for (const [key, f] of found) {
      const ex = existing.get(key);
      if (ex) {
        ex.rsDocs = [...new Set([...(ex.rsDocs || []), ...f.rsDocs])];
        ex.textDocs = [...new Set([...(ex.textDocs || []), ...f.textDocs])];
        ex.matched = [...new Set([...(ex.matched || []), ...f.matched])];
        continue;
      }
      sb.rulings.push({ id: 'ris_' + key, source: 'ris', gz: f.gz, date: f.date, normen: [...f.normen].slice(0, 12), rsDocs: [...f.rsDocs], textDocs: [...f.textDocs], matched: [...f.matched], schlagworte: f.schlagworte, url: f.url, isNew: !!last, addedAt: Date.now(), status: 'meta', chat: [] });
      added++;
    }
    sb.rulingMeta = { lastCheck: Date.now(), norms: norms.map(n => n.norm) };
  });
  return added;
}

// Im Lehrbuch zitierte Entscheidung im RIS nachschlagen und anlegen
export async function addCitedRuling(subId, gz) {
  const r = await searchJustiz({ gz, proSeite: 'Twenty' });
  const r2 = await searchJustiz({ gz, proSeite: 'Twenty', texte: true }).catch(() => ({ items: [] }));
  const items = [...r.items, ...r2.items];
  const key = gz.replace(/\s+/g, '');
  const sub = store.subject(subId);
  let ruling = sub.rulings.find(x => x.gz && x.gz.replace(/\s+/g, '') === key);
  const rsDocs = [...new Set(items.filter(i => i.docNr?.startsWith('JJR')).map(i => i.docNr))];
  const textDocs = [...new Set(items.flatMap(i => [i.docNr?.startsWith('JJT') ? i.docNr : null, ...i.textDocs]).filter(Boolean))];
  const first = items[0] || {};
  store.update(s => {
    const sb = s.subjects.find(x => x.id === subId);
    const ex = sb.rulings.find(x => x.gz && x.gz.replace(/\s+/g, '') === key);
    if (ex) { ex.rsDocs = [...new Set([...(ex.rsDocs || []), ...rsDocs])]; ex.textDocs = [...new Set([...(ex.textDocs || []), ...textDocs])]; ex.cited = true; }
    else sb.rulings.push({ id: 'ris_' + key, source: 'ris', gz, date: first.date || '', normen: first.normen || [], rsDocs, textDocs, matched: [], schlagworte: first.schlagworte || '', url: first.url || '', cited: true, isNew: false, addedAt: Date.now(), status: 'meta', chat: [] });
  });
  ruling = store.subject(subId).rulings.find(x => x.gz && x.gz.replace(/\s+/g, '') === key);
  if (!items.length) throw new Error(`Die Entscheidung ${gz} wurde im RIS nicht gefunden.`);
  return ruling;
}

export async function loadRulingTexts(subId, rulingId) {
  const sub = store.subject(subId);
  const r = sub.rulings.find(x => x.id === rulingId);
  const cacheKey = 'ruling:' + rulingId;
  const cached = await textGet(cacheKey);
  if (cached) return cached;
  let full = '', rs = [];
  if (r.source === 'upload') {
    full = (await getFileText(sub, r.fileId)).text;
  } else {
    for (const d of (r.rsDocs || []).slice(0, 6)) {
      try { rs.push(await fetchDocText(d)); } catch (e) { console.warn(e); }
    }
    let textDoc = (r.textDocs || [])[0];
    if (!textDoc && r.gz) {
      const s = await searchJustiz({ gz: r.gz, texte: true, proSeite: 'Ten' }).catch(() => ({ items: [] }));
      textDoc = s.items.map(i => i.docNr).find(d => d?.startsWith('JJT')) || s.items.flatMap(i => i.textDocs)[0];
      if (textDoc) store.update(st => { const x = st.subjects.find(y => y.id === subId).rulings.find(y => y.id === rulingId); x.textDocs = [textDoc]; });
    }
    if (textDoc) full = await fetchDocText(textDoc);
  }
  const val = { full, rs };
  if (full || rs.length) await textSet(cacheKey, val);
  return val;
}

export async function summarizeRuling(subId, rulingId) {
  const sub = store.subject(subId);
  const r = sub.rulings.find(x => x.id === rulingId);
  const t = await loadRulingTexts(subId, rulingId);
  if (!t.full && !t.rs.length) throw new Error('Kein Text zu dieser Entscheidung verfügbar.');
  const res = await completeJson({
    model: 'smart', maxTokens: 6000,
    system: 'Du bereitest eine Entscheidung des österreichischen OGH für eine Jusstudentin auf. Halte dich streng an den Entscheidungstext. Für diesen Bereich gilt: Die Entscheidung ist eine Ergänzung zum Lehrbuchstoff.',
    messages: [{ role: 'user', content: `JSON:\n{\n "gz": "Geschäftszahl", "datum": "…", "gericht": "OGH",\n "kernaussagen": ["die tragenden Rechtssätze, knapp"],\n "sachverhalt": "kurz, Markdown", "rechtsfrage": "…", "entscheidung": "Ergebnis",\n "begruendung": "wesentliche Argumentation, Markdown",\n "bedeutung": "Bedeutung für Studium und Prüfung, Bezug zur Lehre",\n "normen": ["§ …"],\n "kapitelIds": ["passende Lehrbuchkapitel"],\n "stichworte": ["…"]\n}\n\nKAPITEL:\n${chapterListForPrompt(sub)}\n\n${t.rs.length ? 'RECHTSSÄTZE:\n' + t.rs.join('\n---\n').slice(0, 30000) + '\n\n' : ''}ENTSCHEIDUNGSTEXT:\n${clip(t.full, 200000)}` }]
  });
  store.update(s => {
    const x = s.subjects.find(y => y.id === subId).rulings.find(y => y.id === rulingId);
    x.summary = res; x.status = 'fertig'; x.isNew = false;
    if (!x.gz && res.gz) x.gz = res.gz;
    if (!x.date && res.datum) x.date = res.datum;
  });
  return res;
}

// ---------- Fortschritt ----------
export function recordResult(chapterIds, fraction, kind) {
  store.update(s => {
    for (const id of chapterIds) {
      const p = s.progress.chapters[id] || (s.progress.chapters[id] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 });
      const wasAssessed = p.assessed;
      p.mastery = p.assessed ? p.mastery * 0.6 + fraction * 0.4 : fraction;
      if (!wasAssessed) setBaseline(p);
      p.assessed = true;
      p.lastStudied = Date.now();
      p.quizzes.push({ at: Date.now(), score: fraction, kind });
      if (p.quizzes.length > 30) p.quizzes = p.quizzes.slice(-30);
    }
  });
}

// Ergebnis getrennt nach Basis / Vertiefung: levels = { basis: [richtig, gesamt], vertiefung: [richtig, gesamt] }
export function recordLevelResult(chId, levels, kind) {
  store.update(s => {
    const p = s.progress.chapters[chId] || (s.progress.chapters[chId] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 });
    p.levels = p.levels || { basis: null, vertiefung: null };
    for (const k of ['basis', 'vertiefung']) {
      const v = levels[k];
      if (!v || !v[1]) continue;
      const prior = k === 'basis' ? 0.35 : 0.2;
      const f = (v[0] + prior * 2) / (v[1] + 2); // wenige Fragen → vorsichtiger Wert
      // Je mehr Fragen dieser Test hatte, desto stärker zählt er (max. 50 %)
      const alpha = Math.min(0.5, v[1] / (v[1] + 6));
      p.levels[k] = p.levels[k] == null ? f : p.levels[k] * (1 - alpha) + f * alpha;
    }
    const wasAssessed = p.assessed;
    p.mastery = combineLevels(p.levels, p.mastery, p.assessed);
    if (!wasAssessed) setBaseline(p);
    p.assessed = true;
    p.lastStudied = Date.now();
    const tot = (levels.basis?.[1] || 0) + (levels.vertiefung?.[1] || 0);
    const ok = (levels.basis?.[0] || 0) + (levels.vertiefung?.[0] || 0);
    p.quizzes.push({ at: Date.now(), score: tot ? ok / tot : 0, kind });
    if (p.quizzes.length > 30) p.quizzes = p.quizzes.slice(-30);
  });
}
// Basis zählt mehr (75 %), Vertiefung 25 %
export function combineLevels(l, prev = 0, assessed = false) {
  const b = l.basis, v = l.vertiefung;
  if (b != null && v != null) return 0.75 * b + 0.25 * v;
  if (b != null) return assessed && prev ? Math.min(prev * 0.5 + b * 0.5, b) : b * 0.9;
  if (v != null) return assessed ? prev * 0.75 + v * 0.25 : v * 0.5;
  return prev;
}
export function levelText(p) {
  if (!p?.levels) return '';
  const f = x => x == null ? '–' : Math.round(x * 100) + ' %';
  return `Basis ${f(p.levels.basis)} · Vertiefung ${f(p.levels.vertiefung)}`;
}

// Ausgangspunkt fürs Lerntempo: Kenntnisstand und bisherige Lernzeit beim ersten Test
export function setBaseline(p) {
  p.baseline = p.mastery || 0;
  p.minAtBaseline = p.minutes || 0;
}

export function markStudied(chId) {
  store.update(s => {
    const p = s.progress.chapters[chId] || (s.progress.chapters[chId] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 });
    p.studied = (p.studied || 0) + 1; p.lastStudied = Date.now();
  }, { silent: true });
}

export function addMistake(m) {
  store.update(s => {
    s.progress.mistakes.unshift({ id: uid('m_'), at: Date.now(), ...m });
    if (s.progress.mistakes.length > 500) s.progress.mistakes.length = 500;
  }, { silent: true });
}
