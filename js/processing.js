// Verarbeitung: Ordner scannen, Lehrbücher gliedern und zusammenfassen, Transkripte/Altklausuren/Urteile analysieren
import { store, uid, textGet, textSet, allChapters, findChapter, isStudyChapter, bookRole } from './store.js';
import { listRecursive, downloadFile, getFileMeta, readAppFile, writeAppFile, isSignedIn } from './drive.js';
import { fileToText, isSupported, pagesToText } from './extract.js';
import { completeJson, clip, batchAvailable, submitBatch, batchStatus, batchResults, parseJson } from './ai.js';
import { estimate } from './costs.js';
import { tocPages, detectByHeadings, introChapter, titleOnPage, checkChapters, excerpt, relabel, pageMap } from './structure.js';
import { searchJustiz, fetchDocText, fetchRechtssatz, toRisNorm, extractCitations } from './ris.js';

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
  const v = await getFileTextRaw(sub, fileId, onProgress);
  if (v?.pages && !v.relabeled) { v.pages = relabel(v.pages); v.relabeled = true; }
  return v;
}

async function getFileTextRaw(sub, fileId, onProgress) {
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

    try { await detectBookTitle(subId, fileId); } catch (e) { console.warn('Titel nicht erkannt', e); }
    let book = store.subject(subId).books.find(b => b.fileId === fileId);
    // Alte Gliederung ohne erkennbare Fehler behalten (bereits bezahlte Ergebnisse nicht verwerfen)
    if (book.chapters?.length && book.structVer !== STRUCT_VER && book.chapters.some(c => c.summary || c.cases) && !checkChapters(book.chapters.map(c => ({ id: c.id, title: c.title, start: c.startPage, end: c.endPage })), t.pages).length) {
      patchBook(subId, fileId, b => { b.structVer = STRUCT_VER; });
      book = store.subject(subId).books.find(b => b.fileId === fileId);
    }
    if (!book.chapters?.length || book.structVer !== STRUCT_VER) {
      onStatus('Erkenne Kapitel …');
      const chapters = await detectChapters(t.pages, t.outline);
      const cits = extractCitations(t.pages.map(p => p.text).join('\n'));
      const old = book.chapters || [];
      let kept = 0, dropped = 0;
      patchBook(subId, fileId, b => {
        b.numPages = t.pages.length;
        b.chapters = chapters.map(c => {
          // Ergebnisse nur übernehmen, wenn das Kapitel exakt dieselben Seiten hatte (sonst stammen sie aus falschem Text)
          const o = old.find(x => x.startPage === c.start && x.endPage === c.end);
          const base = { title: c.title, startPage: c.start, endPage: c.end, startLabel: t.pages[c.start - 1]?.label, endLabel: t.pages[c.end - 1]?.label, pages: c.end - c.start + 1, intro: !!c.intro, preview: excerpt(t.pages, c.start, 200) };
          if (o) { kept++; return { ...o, ...base, id: o.id }; }
          return { id: uid('k_'), ...base, summary: null, status: 'neu' };
        });
        dropped = old.filter(o => !b.chapters.some(c => c.id === o.id) && (o.summary?.kurzfassung || o.cases?.length)).length;
        b.structWarn = checkChapters(b.chapters.map(c => ({ id: c.id, title: c.title, start: c.startPage, end: c.endPage })), t.pages).map(w => w.msg);
        b.structVer = STRUCT_VER;
        b.citations = { gz: cits.gz.slice(0, 150), rs: cits.rs.slice(0, 150) };
        b.status = 'gegliedert'; b.estimate = null; b.approved = false;
        if (old.length && dropped) b.notice = `Kapitel neu erkannt. ${dropped} alte Zusammenfassung(en) stammten aus falschen Seiten und wurden entfernt.`;
      });
    }
    book = store.subject(subId).books.find(b => b.fileId === fileId);
    const role = bookRole(book);
    const todo = book.chapters.filter(c => role === 'faelle' ? !c.cases : !c.summary);
    // Kapitel, die kein Lernstoff sind, gleich als erledigt markieren (kostet nichts)
    for (const ch of todo.filter(c => !isStudyChapter(c))) role === 'faelle' ? patchCases(subId, fileId, ch.id, []) : patchSummary(subId, fileId, ch.id, { pruefungsrelevant: false, kurzfassung: '' });
    const work = todo.filter(c => isStudyChapter(c));
    if (!work.length) {
      patchBook(subId, fileId, b => { b.status = 'fertig'; b.estimate = null; b.approved = false; });
      store.update(s => { const f = s.subjects.find(x => x.id === subId).files[fileId]; if (f) { f.isNew = false; f.changed = false; } });
      onStatus('Fertig');
      return;
    }
    // Kostenvoranschlag – ohne Freigabe wird nichts an die KI geschickt
    const useBatch = batchAvailable();
    const est = estimateWork(book, work, t.pages, useBatch);
    // Kostenloser Anbieter (Gemini): keine Freigabe nötig
    if (!book.approved && !(est.usd === 0 && !useBatch)) {
      patchBook(subId, fileId, b => { b.status = 'bereit'; b.estimate = est; });
      onStatus(`Bereit – Zusammenfassen kostet ca. ${est.usd.toFixed(2)} $. Bitte im Reiter „Lehrbuch“ freigeben.`);
      return;
    }
    if (useBatch) {
      onStatus('Schicke die Kapitel an den Hintergrund-Modus …');
      const reqs = work.map(ch => {
        const text = pagesToText(t.pages, ch.startPage, ch.endPage);
        const pr = role === 'faelle' ? casesPrompt(store.subject(subId), book, ch, text) : summaryPrompt(book, ch, text);
        return { id: ch.id, system: pr.system, prompt: pr.prompt, maxTokens: pr.maxTokens, model: 'book' };
      });
      const { id, model } = await submitBatch(reqs);
      patchBook(subId, fileId, b => { b.status = 'hintergrund'; b.batch = { id, model, kind: role === 'faelle' ? 'faelle' : 'summary', at: Date.now(), n: reqs.length }; b.approved = false; });
      onStatus('Läuft im Hintergrund – du kannst die App schließen.');
      return;
    }
    // ohne Hintergrund-Modus: Kapitel für Kapitel (freigegeben, daher ohne Limit-Rückfrage)
    let i = 0, failed = 0, lastErr = '';
    const startProvider = store.state.settings.provider;
    for (const ch of work) {
      i++;
      // Anbieter gewechselt (z. B. von kostenlos auf kostenpflichtig)? Dann sofort anhalten – nie ohne Freigabe Geld ausgeben
      if (store.state.settings.provider !== startProvider) { patchBook(subId, fileId, b => { b.status = 'gegliedert'; b.approved = false; b.estimate = null; }); onStatus('angehalten – KI-Anbieter wurde gewechselt'); return; }
      const cur = store.subject(subId).books.find(b => b.fileId === fileId);
      if (!cur || bookRole(cur) !== role) { patchBook(subId, fileId, b => { b.status = 'pausiert'; }); onStatus('angehalten'); return; }
      onStatus(`${role === 'faelle' ? 'Löse Fälle heraus' : 'Fasse zusammen'} (${i} von ${work.length}): ${ch.title}`);
      try {
        if (role === 'faelle') await extractCases(subId, fileId, ch.id, t.pages, { budgetExempt: true });
        else await summarizeChapter(subId, fileId, ch.id, t.pages, { budgetExempt: true });
      } catch (e) {
        // ein Kapitel schlägt fehl → die anderen trotzdem verarbeiten; bei Schlüssel-/Guthabenproblemen sofort aufhören
        failed++; lastErr = e.message; console.warn(ch.title, e);
        if (/401|403|credit|guthaben|api key|schlüssel|billing/i.test(e.message)) throw e;
      }
    }
    if (failed) {
      patchBook(subId, fileId, b => { b.status = 'fehler'; b.estimate = null; b.approved = false; b.error = `${failed} Kapitel konnten nicht verarbeitet werden (${lastErr}). Mit „Erneut vorbereiten“ noch einmal versuchen.`; });
      onStatus(`${failed} Kapitel fehlgeschlagen`);
      return;
    }
    patchBook(subId, fileId, b => { b.status = 'fertig'; b.estimate = null; b.approved = false; });
    store.update(s => { const f = s.subjects.find(x => x.id === subId).files[fileId]; if (f) { f.isNew = false; f.changed = false; } });
    onStatus('Fertig');
  } catch (e) {
    patchBook(subId, fileId, b => { b.status = 'fehler'; b.error = e.message; });
    throw e;
  }
}

export const STRUCT_VER = 2;

// Kapitel erkennen – zuerst kostenlos aus Überschriften im Text, dann aus Lesezeichen (geprüft), zuletzt per KI (geprüft)
export async function detectChapters(pages, outline) {
  const n = pages.length;
  const toc = tocPages(pages);
  const finish = list => {
    list = list.filter(c => c.page >= 1 && c.page <= n && !toc.has(c.page)).sort((a, b) => a.page - b.page);
    const dedup = [];
    for (const c of list) { const last = dedup[dedup.length - 1]; if (last && last.page === c.page) continue; dedup.push({ ...c }); }
    return dedup.map((c, i) => ({ title: c.title, start: c.page, end: Math.max(c.page, (dedup[i + 1]?.page || c.endHint || n + 1) - 1), intro: c.intro }));
  };
  // 1. Überschriften wie „5. Kapitel“, „Fall 3“, „§ 4“ im Fließtext
  const heads = detectByHeadings(pages, toc);
  if (heads) {
    const intro = introChapter(pages, toc, heads[0].start);
    const out = heads.map(h => ({ title: h.title, start: h.start, end: h.end }));
    return intro ? [{ title: intro.title, start: intro.start, end: intro.end, intro: true }, ...out] : out;
  }
  // 2. Lesezeichen des PDFs – nur wenn die Überschriften wirklich auf den Zielseiten stehen
  const entries = (outline || []).filter(o => o.page && o.title && !SKIP_TITLES.test(o.title));
  if (entries.length >= 3) {
    const lvl0 = entries.filter(e => e.level === 0);
    const base = lvl0.length >= 3 ? lvl0 : entries.filter(e => e.level === 1).length >= 3 ? entries.filter(e => e.level === 1) : entries;
    const ok = base.filter(e => !toc.has(e.page) && titleOnPage(e.title, pages[e.page - 1]));
    if (ok.length >= 3 && ok.length >= base.length * 0.7) {
      const chosen = [];
      for (let i = 0; i < ok.length; i++) {
        const e = ok[i], next = ok[i + 1]?.page || n + 1;
        const kids = entries.filter(k => k.level === e.level + 1 && k.page >= e.page && k.page < next && titleOnPage(k.title, pages[k.page - 1]));
        if (next - e.page > 70 && kids.length >= 2) {
          if (kids[0].page > e.page) chosen.push({ title: e.title, page: e.page });
          kids.forEach(k => chosen.push({ title: `${e.title} – ${k.title}`, page: k.page }));
        } else chosen.push({ title: e.title, page: e.page });
      }
      return finish(chosen);
    }
  }
  // 3. KI liest das Inhaltsverzeichnis – jede Startseite wird im Text überprüft
  let ai = [];
  try { ai = await detectChaptersAI(pages, toc); } catch (e) { console.warn(e); }
  if (ai.length >= 3) return finish(ai);
  // 4. Notlösung: in Abschnitte zu ca. 25 Seiten teilen (ehrlich benannt)
  const first = Math.max(0, ...toc) + 1, out = [];
  for (let p = first; p <= n; p += 25) out.push({ title: `Seiten ${pages[p - 1].label}–${pages[Math.min(n, p + 24) - 1].label}`, page: p });
  return finish(out);
}

async function detectChaptersAI(pages, toc) {
  const head = pages.slice(0, 40).map(p => `[PDF-Seite ${p.n} | Seitenzahl ${p.label}]\n${p.text}`).join('\n\n');
  const r = await completeJson({
    model: 'fast', maxTokens: 6000, purpose: 'Kapitel erkennen',
    system: 'Du analysierst das Inhaltsverzeichnis eines juristischen Lehrbuchs.',
    messages: [{ role: 'user', content: `Hier sind die ersten Seiten eines Lehrbuchs. Finde das Inhaltsverzeichnis und gib die Hauptkapitel (sinnvolle Lerneinheiten, typischerweise 8–40 Stück) mit ihrer Überschrift genau wie im Buch zurück.\nFormat: {"kapitel":[{"titel":"…","seite":"gedruckte Seitenzahl laut Inhaltsverzeichnis oder leer, wenn dort nur Randzahlen stehen"}]}\nLass Vorwort, Verzeichnisse und Register weg.\n\n${clip(head, 90000)}` }]
  });
  const list = (r.kapitel || []).filter(k => k && k.titel);
  const byLabel = new Map(pages.map(p => [String(p.label).trim(), p.n]));
  const after = Math.max(0, ...toc);
  const out = [];
  let last = after;
  for (const k of list) {
    // Kandidat aus der Seitenzahl, danach Umgebung und notfalls das ganze Buch nach der Überschrift absuchen
    const guess = byLabel.get(String(k.seite || '').trim());
    const near = guess ? [guess, guess + 1, guess - 1, guess + 2, guess + 3] : [];
    let hit = near.find(p => p > after && pages[p - 1] && titleOnPage(k.titel, pages[p - 1]));
    if (!hit) hit = pages.find(p => p.n > last && titleOnPage(k.titel, p))?.n;
    if (hit && hit > last) { out.push({ title: k.titel, page: hit }); last = hit; }
  }
  return out;
}

// Regeln für den festen Fragenpool (einmal erstellt, danach kostenlos beliebig oft nutzbar)
export const POOL_RULES = `FRAGENPOOL: Erstelle 12 Multiple-Choice-Fragen zum BASISWISSEN (davon mind. 3 Anwendungen auf einen Mini-Sachverhalt bzw. ein Prüfungsschema) und 6 zur VERTIEFUNG.
- Jede Frage prüft das VERSTÄNDNIS eines anderen prüfungsrelevanten Punkts; nie Paragraphennummern, Gliederung, Überschriften oder Seitenzahlen abfragen.
- Je 4 Optionen, genau eine eindeutig richtig; die falschen sind plausible, typische Fehlvorstellungen; Optionen ungefähr gleich lang; keine „alle/keine der genannten“.
- Erklärung: max. 2 Sätze, warum richtig (und warum die häufigste Verwechslung falsch ist), mit Seitenangabe.
- Verwende in Texten „ “ oder ' statt gerader Anführungszeichen.`;
const POOL_JSON = `"fragen": [{"frage": "…", "optionen": ["…","…","…","…"], "richtig": 0, "erklaerung": "…", "seite": "S. …", "ebene": "basis|vertiefung"}]`;

function summaryPrompt(book, ch, text) {
  return {
    maxTokens: 16000,
    system: `Du erstellst prüfungsorientierte Lernzusammenfassungen eines Lehrbuchkapitels. Verwende NUR den Kapiteltext. Nichts hinzufügen, nichts Wesentliches weglassen. Jede Aussage mit Seitenangabe [S. x]. Fasse nur den juristischen Inhalt zusammen; Inhaltsverzeichnisse, Gliederungsübersichten, Vorworte, Literatur- und Abkürzungsverzeichnisse, Kopfzeilen und Randziffern ignorierst du. Verwende in Texten „ “ statt gerader Anführungszeichen.`,
    prompt: `Lehrbuch: „${book.title}“\nKapitel: „${ch.title}“\n\nErstelle eine strukturierte Zusammenfassung als JSON – GENAU in dieser Reihenfolge der Felder (die kurzen Listen zuerst, die ausführlichen Themen zum Schluss):\n{\n "pruefungsrelevant": true, (false NUR wenn der Text kein juristischer Lernstoff ist, z. B. reines Inhaltsverzeichnis, Vorwort, Verzeichnisse, Register)\n "kurzfassung": "3–6 Sätze: worum geht es inhaltlich (Rechtsinstitute, Probleme), nicht wie das Kapitel aufgebaut ist",\n "normen": ["§ 1295 ABGB", …],\n "definitionen": [{"begriff": "…", "definition": "…", "seite": "…", "ebene": "basis|vertiefung"}],\n "schemata": [{"titel": "Prüfungsschema …", "schritte": ["…"]}],\n "stolperfallen": [{"text": "typische Fehler, Abgrenzungen, Ausnahmen", "seite": "…"}],\n "entscheidungen": ["im Text zitierte OGH-Entscheidungen, z. B. 1 Ob 123/05x"],\n "schlagworte": ["…"],\n "lernzeitMinuten": realistische Lernzeit für jemanden ohne Vorwissen (Zahl),\n "themen": [{"titel": "…", "inhalt": "prüfungsrelevante Darstellung in Markdown mit Seitenangaben – präzise, ohne Wiederholungen", "seiten": "S. x–y", "ebene": "basis|vertiefung"}]\n}\nLeere Listen sind erlaubt. Gib Schemata nur an, wenn sie im Text angelegt sind. Die gesamte Antwort soll höchstens etwa 25.000 Zeichen lang sein.\n\nKAPITELTEXT:\n${clip(text, 320000)}`
  };
}

function patchSummary(subId, fileId, chId, r) {
  store.update(s => {
    const b = s.subjects.find(x => x.id === subId).books.find(x => x.fileId === fileId);
    const c = b.chapters.find(x => x.id === chId);
    if (c) {
      const pool = Array.isArray(r?.fragen) ? r.fragen : null;
      if (r) delete r.fragen;
      c.summary = r; c.status = 'fertig'; c.summarizedAt = Date.now();
      if (pool?.length) c.pool = cleanPool(pool);
    }
  });
}

export async function summarizeChapter(subId, fileId, chId, pagesOpt, { budgetExempt = false } = {}) {
  const sub = store.subject(subId);
  const book = sub.books.find(b => b.fileId === fileId);
  const ch = book.chapters.find(c => c.id === chId);
  const pages = pagesOpt || (await getFileText(sub, fileId)).pages;
  const pr = summaryPrompt(book, ch, pagesToText(pages, ch.startPage, ch.endPage));
  const r = await completeJson({ model: 'book', maxTokens: pr.maxTokens, system: pr.system, messages: [{ role: 'user', content: pr.prompt }], purpose: 'Lehrbuch zusammenfassen', budgetExempt });
  patchSummary(subId, fileId, chId, r);
  return r;
}

// Fragenpool säubern: nur vollständige Fragen mit 4 Optionen und gültiger Lösung
export function cleanPool(list) {
  return (list || []).map(q => {
    const optionen = (q.optionen || q.options || []).map(o => typeof o === 'object' ? (o.text || '') : String(o)).map(o => o.replace(/^\s*[A-Da-d][).:]\s+/, '')).filter(Boolean);
    let richtig = q.richtig;
    if (typeof richtig === 'string') richtig = /^[A-D]$/i.test(richtig.trim()) ? 'ABCD'.indexOf(richtig.trim().toUpperCase()) : parseInt(richtig, 10);
    return { frage: q.frage, optionen, richtig, erklaerung: q.erklaerung || '', seite: q.seite || '', ebene: String(q.ebene || 'basis').startsWith('vert') ? 'vertiefung' : 'basis' };
  }).filter(q => q.frage && q.optionen.length >= 3 && Number.isInteger(q.richtig) && q.richtig >= 0 && q.richtig < q.optionen.length);
}

function digest(c) {
  const s = c.summary || {};
  return `${s.kurzfassung || ''}\n${(s.themen || []).map(t => `### ${t.titel}\n${t.inhalt}`).join('\n')}\nDefinitionen: ${(s.definitionen || []).map(d => d.begriff + ': ' + d.definition).join(' | ')}\nStolperfallen: ${(s.stolperfallen || []).map(x => x.text || x).join(' | ')}`;
}
function poolPrompt(book, ch, text) {
  return {
    maxTokens: 8000,
    system: 'Du erstellst einen festen Pool präziser Multiple-Choice-Prüfungsfragen zu einem Lehrbuchkapitel (österreichisches Recht). Grundlage ist ausschließlich das Kapitel.',
    prompt: `Lehrbuch: „${book.title}“, Kapitel: „${ch.title}“\n\n${POOL_RULES}\n\nJSON: {${POOL_JSON}}\n\nZUSAMMENFASSUNG DES KAPITELS:\n${digest(ch)}\n\nAUSZUG AUS DEM LEHRBUCHTEXT:\n${clip(text, 30000)}`
  };
}
export function poolEstimate(book, pages) {
  const prov = store.state.settings.provider || 'anthropic';
  const mm = store.state.settings.models?.[prov] || {};
  const model = mm.book || mm.fast || mm.smart || 'sonnet';
  const chs = book.chapters.filter(c => isStudyChapter(c) && c.summary && !c.pool?.length);
  let usdSum = 0;
  for (const ch of chs) usdSum += estimate(model, Math.min(30000, pagesToText(pages, ch.startPage, ch.endPage).length) + digest(ch).length + 3000, 4500, { batch: batchAvailable() });
  return { usd: Math.round(usdSum * 100) / 100, chapters: chs.length };
}
// Fragenpool für schon zusammengefasste Kapitel nachträglich erstellen (Hintergrund-Modus)
export async function buildPools(subId, fileId, onStatus = () => {}) {
  const sub = store.subject(subId);
  const book = sub.books.find(b => b.fileId === fileId);
  const t = await getFileText(sub, fileId);
  const chs = book.chapters.filter(c => isStudyChapter(c) && c.summary && !c.pool?.length);
  if (!chs.length) return;
  if (batchAvailable()) {
    onStatus('Schicke die Kapitel an den Hintergrund-Modus …');
    const reqs = chs.map(ch => { const pr = poolPrompt(book, ch, pagesToText(t.pages, ch.startPage, ch.endPage)); return { id: ch.id, system: pr.system, prompt: pr.prompt, maxTokens: pr.maxTokens, model: 'book' }; });
    const { id, model } = await submitBatch(reqs);
    patchBook(subId, fileId, b => { b.batch = { id, model, kind: 'pool', at: Date.now(), n: reqs.length }; });
    return;
  }
  let i = 0;
  for (const ch of chs) {
    i++; onStatus(`Erstelle Fragenpool (${i} von ${chs.length}): ${ch.title}`);
    const pr = poolPrompt(book, ch, pagesToText(t.pages, ch.startPage, ch.endPage));
    try { const r = await completeJson({ model: 'book', maxTokens: pr.maxTokens, system: pr.system, messages: [{ role: 'user', content: pr.prompt }], purpose: 'Fragenpool', budgetExempt: true }); patchPool(subId, fileId, ch.id, r.fragen); }
    catch (e) { console.warn(e); if (/401|403|credit|guthaben|api key|billing/i.test(e.message)) throw e; }
  }
}
function patchPool(subId, fileId, chId, list) {
  store.update(s => { const c = s.subjects.find(x => x.id === subId).books.find(x => x.fileId === fileId).chapters.find(x => x.id === chId); if (c) c.pool = cleanPool(list); });
}

// Kostenvoranschlag für die noch offenen Kapitel eines Buchs
export function estimateWork(book, chapters, pages, batch) {
  const prov = store.state.settings.provider || 'anthropic';
  const mm = store.state.settings.models?.[prov] || {};
  const model = mm.book || mm.fast || mm.smart || 'sonnet';
  let usdSum = 0, chars = 0;
  const outPer = bookRole(book) === 'faelle' ? 9000 : 8000;
  for (const ch of chapters) {
    const c = pagesToText(pages, ch.startPage, ch.endPage).length;
    chars += c;
    usdSum += estimate(model, Math.min(c, 320000) + 9000, outPer, { batch });
  }
  return { usd: Math.round(usdSum * 100) / 100, chapters: chapters.length, chars, batch, at: Date.now() };
}

// Hintergrund-Aufträge abholen (beim Start und regelmäßig)
export async function pollBatches(onDone = () => {}) {
  for (const sub of store.state.subjects) {
    for (const b of sub.books) {
      if (!b.batch?.id) continue;
      let st;
      try { st = await batchStatus(b.batch.id); } catch (e) { console.warn(e); continue; }
      const counts = st.request_counts || {};
      store.update(s => { const x = s.subjects.find(y => y.id === sub.id).books.find(y => y.fileId === b.fileId); if (x?.batch) x.batch.progress = counts; }, { silent: true });
      if (st.processing_status !== 'ended') continue;
      let results;
      try { results = await batchResults(b.batch.id, b.batch.model); } catch (e) { console.warn(e); continue; }
      let ok = 0, failed = 0;
      let firstErr = '';
      const doneKind = b.batch.kind;
      for (const r of results) {
        if (!r.ok) { failed++; firstErr = firstErr || r.error || ''; continue; }
        let j; try { j = parseJson(r.text); } catch (e) { failed++; firstErr = firstErr || 'Antwort nicht lesbar: ' + e.message; continue; }
        if (b.batch.kind === 'pool') { patchPool(sub.id, b.fileId, r.id, j.fragen); ok++; continue; }
        if (b.batch.kind === 'faelle') patchCases(sub.id, b.fileId, r.id, (j.faelle || []).filter(f => f && (f.sachverhalt || f.loesung)));
        else patchSummary(sub.id, b.fileId, r.id, j);
        ok++;
      }
      store.update(s => {
        const x = s.subjects.find(y => y.id === sub.id).books.find(y => y.fileId === b.fileId);
        const left = x.chapters.filter(c => isStudyChapter(c) && (b.batch.kind === 'pool' ? c.summary && !c.pool?.length : b.batch.kind === 'faelle' ? !c.cases : !c.summary)).length;
        const kind = b.batch.kind;
        x.batch = null; x.estimate = null;
        if (kind === 'pool') { x.error = left ? `Fragenpool: ${left} Kapitel fehlen noch${firstErr ? ` (Grund: ${firstErr})` : ''}.` : null; return; }
        x.status = left ? 'bereit' : 'fertig';
        if (left) x.error = `${left} Kapitel konnten nicht verarbeitet werden${firstErr ? ` (Grund: ${firstErr})` : ''} – mit „Vorbereiten“ erneut versuchen.`;
      });
      onDone(b, ok, failed);
      // nach den Zusammenfassungen gleich den Fragenpool im Hintergrund nachziehen (günstig)
      if (doneKind === 'summary' && ok) buildPools(sub.id, b.fileId).catch(e => console.warn('Fragenpool', e));
    }
  }
}

function patchCases(subId, fileId, chId, cases) {
  store.update(s => {
    const b = s.subjects.find(x => x.id === subId).books.find(x => x.fileId === fileId);
    const c = b.chapters.find(x => x.id === chId);
    c.cases = cases; c.status = 'fertig';
  });
}

// Fallsammlung: Fälle samt Originallösung herauslösen und auf den Lehrbuchstoff beziehen
function casesPrompt(sub, book, ch, text) {
  return {
    maxTokens: 12000,
    system: 'Du arbeitest eine juristische FALLSAMMLUNG (Übungsfälle mit Lösungen, österreichisches Recht) auf. Gib die Fälle und die Lösungen des Buchs wieder – erfinde keine eigenen Lösungen. Ordne jede rechtliche Aussage aus den Lösungen dem passenden Kapitel der Lehrbücher zu, damit der Lehrbuchstoff anhand der Fälle wiederholt werden kann.',
    prompt: `Fallsammlung: „${book.title}“, Abschnitt: „${ch.title}“\n\nJSON:\n{\n "faelle": [{\n   "titel": "kurzer Titel",\n   "sachverhalt": "Sachverhalt möglichst wörtlich",\n   "fragen": ["Fallfragen"],\n   "loesung": "die Lösung des Buchs, gegliedert (Markdown), mit Seitenangaben – vollständig, nur sprachlich gestrafft",\n   "ansprueche": [{"wer": "…", "gegen": "…", "was": "…", "grundlage": "Anspruchsgrundlage mit Norm", "ergebnis": "…"}],\n   "aussagen": [{"aussage": "eine allgemeine Rechtsaussage aus der Lösung, die über den Fall hinaus gilt", "kapitelId": "passendes Lehrbuchkapitel", "ebene": "basis|vertiefung"}],\n   "stolperfallen": ["…"],\n   "kapitelIds": ["Lehrbuchkapitel, deren Stoff der Fall prüft"],\n   "schwierigkeit": "einfach|mittel|schwer"\n }]\n}\nWenn der Abschnitt keine Fälle enthält (z. B. nur Einleitung oder Methodik), gib {"faelle": []} zurück.\n\nLEHRBUCHKAPITEL (ID | Titel):\n${chapterListForPrompt(sub) || '(noch keine)'}\n\nTEXT DER FALLSAMMLUNG:\n${clip(text, 300000)}`
  };
}

// Fallsammlung: Fälle samt Originallösung herauslösen und auf den Lehrbuchstoff beziehen
export async function extractCases(subId, fileId, chId, pagesOpt, { budgetExempt = false } = {}) {
  const sub = store.subject(subId);
  const book = sub.books.find(b => b.fileId === fileId);
  const ch = book.chapters.find(c => c.id === chId);
  const pages = pagesOpt || (await getFileText(sub, fileId)).pages;
  const pr = casesPrompt(sub, book, ch, pagesToText(pages, ch.startPage, ch.endPage));
  const r = await completeJson({ model: 'smart', maxTokens: pr.maxTokens, system: pr.system, messages: [{ role: 'user', content: pr.prompt }], purpose: 'Fallsammlung aufbereiten', budgetExempt });
  const cases = (r.faelle || []).filter(f => f && (f.sachverhalt || f.loesung));
  patchCases(subId, fileId, chId, cases);
  return cases;
}

// Den echten Buchtitel aus den ersten Seiten lesen (statt Dateiname)
export async function detectBookTitle(subId, fileId) {
  const sub = store.subject(subId);
  const b = sub.books.find(x => x.fileId === fileId);
  if (!b || b.titleDetected) return;
  const t = await getFileText(sub, fileId);
  const head = t.pages ? t.pages.slice(0, 8).map(p => `[Seite ${p.n}]\n${p.text}`).join('\n\n') : (t.text || '').slice(0, 12000);
  const r = await completeJson({
    model: 'fast', maxTokens: 600, purpose: 'Buchtitel erkennen',
    system: 'Du liest Titelangaben aus den ersten Seiten eines Buchs.',
    messages: [{ role: 'user', content: `Wie heißt dieses Buch laut Titelseite? Gib den Titel so an, wie man das Buch nennt (inkl. Band, z. B. „Bürgerliches Recht II“), ohne Verlag.\nJSON: {"titel":"…","autoren":["Nachname", …],"auflage":"z. B. 16. Auflage oder leer"}\n\n${clip(head, 15000)}` }]
  });
  const titel = String(r.titel || '').trim();
  if (!titel || titel.length > 140) return;
  store.update(s => {
    const x = s.subjects.find(y => y.id === subId).books.find(y => y.fileId === fileId);
    if (!x || x.titleDetected) return;
    if (!x.role) x.role = bookRole(x); // Buchart beibehalten, auch wenn sich der Titel ändert
    x.fileTitle = x.fileTitle || x.title;
    x.title = titel;
    x.authors = (r.autoren || []).filter(Boolean).slice(0, 5);
    x.edition = r.auflage || '';
    x.titleDetected = true;
  });
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
      model: 'smart', maxTokens: 8000, purpose: 'Einheit analysieren',
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
      model: 'smart', maxTokens: 9000, purpose: 'Altklausur analysieren',
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
    model: 'smart', maxTokens: 6000, purpose: 'Altklausuren auswerten',
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
    model: 'smart', maxTokens: 6000, purpose: 'Stoffeingrenzung',
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
        // Rechtssatz (Leitsatz mit vielen Entscheidungen) = ein Eintrag; Einzelentscheidung = ein Eintrag
        const isRs = it.docNr?.startsWith('JJR');
        const key = isRs ? 'rs_' + (it.rsNr || it.docNr) : it.gz.replace(/\s+/g, '');
        const cur = found.get(key) || { key, kind: isRs ? 'rs' : 'e', rsNr: it.rsNr || '', gz: it.gz, gzList: it.gzList || [it.gz], date: it.date, normen: new Set(), rsDocs: new Set(), textDocs: new Set(), schlagworte: '', matched: new Set(), url: it.url };
        it.normen.forEach(n => cur.normen.add(n));
        if (isRs) cur.rsDocs.add(it.docNr);
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
    migrateRulings(sb);
    const existing = new Map(sb.rulings.filter(r => r.source === 'ris').map(r => [r.id.replace(/^ris_/, ''), r]));
    for (const [key, f] of found) {
      const ex = existing.get(key) || (f.kind === 'rs' ? sb.rulings.find(r => (r.rsDocs || []).some(d => f.rsDocs.has(d))) : null);
      if (ex) {
        ex.rsDocs = [...new Set([...(ex.rsDocs || []), ...f.rsDocs])];
        ex.textDocs = [...new Set([...(ex.textDocs || []), ...f.textDocs])];
        ex.matched = [...new Set([...(ex.matched || []), ...f.matched])];
        if (f.gzList.length > (ex.gzList || []).length) { ex.gzList = f.gzList; ex.gz = f.gz; ex.date = f.date; }
        continue;
      }
      sb.rulings.push({ id: 'ris_' + key, source: 'ris', kind: f.kind, rsNr: f.rsNr, gz: f.gz, gzList: f.gzList, date: f.date, normen: [...f.normen].slice(0, 12), rsDocs: [...f.rsDocs], textDocs: [...f.textDocs], matched: [...f.matched], schlagworte: f.schlagworte, url: f.url, isNew: !!last, addedAt: Date.now(), status: 'meta', chat: [] });
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
    model: 'smart', maxTokens: 6000, purpose: 'OGH-Urteil aufbereiten',
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

// ---------- Doppelte Bücher (alte und neue Auflage) ----------
const editionNo = b => {
  const src = `${b.edition || ''} ${b.fileTitle || ''} ${b.title || ''}`;
  const m = src.match(/(\d{1,2})\s*\.?\s*(?:auflage|aufl\b|a\b|ed\b|edition)/i) || src.match(/(?:auflage|aufl\.?)\s*(\d{1,2})/i);
  return m ? +m[1] : 0;
};
const bookKey = b => String(b.title || '').toLowerCase().replace(/\(?\d{1,2}\.?\s*(auflage|aufl\.?)\)?/g, '').replace(/[^a-zäöüß0-9]+/g, ' ').trim();

// Gleiches Buch mehrfach vorhanden? Dann nur die neueste Auflage verwenden, die anderen auf „nicht verwenden“
export function markDuplicates(subId) {
  const sub = store.subject(subId);
  if (!sub) return;
  const groups = new Map();
  for (const b of sub.books) {
    if (!b.titleDetected || b.roleManual) continue;
    const k = bookKey(b);
    if (k.length < 4) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(b);
  }
  const changes = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const mt = b => Date.parse(sub.files[b.fileId]?.modifiedTime || 0) || 0;
    // neueste Auflage; bei Gleichstand: Datei im Ordner „Neue Auflagen“ bzw. eine, die schon gelesen werden konnte
    const neu = b => /neu/i.test(sub.files[b.fileId]?.path || '') ? 1 : 0;
    const ok = b => (b.chapters?.length ? 1 : 0);
    const keep = [...list].sort((a, b) => editionNo(b) - editionNo(a) || neu(b) - neu(a) || ok(b) - ok(a) || mt(b) - mt(a))[0];
    for (const b of list) changes.push([b.fileId, b === keep ? null : keep.fileId]);
  }
  if (!changes.some(([fid, dup]) => (sub.books.find(b => b.fileId === fid).dupOf || null) !== dup)) return;
  store.update(s => {
    const sb = s.subjects.find(x => x.id === subId);
    for (const [fid, dup] of changes) { const b = sb.books.find(x => x.fileId === fid); b.dupOf = dup; if (dup) { b.approved = false; } }
  });
}


// ---------- OGH: alte Einträge umstellen, Rechtssätze laden, Kapiteln zuordnen ----------
// Früher wurde bei Rechtssätzen die ganze Liste aller Geschäftszahlen als „GZ“ gespeichert
export function migrateRulings(sb) {
  for (const r of sb.rulings || []) {
    if (r.source !== 'ris' || r.kind) continue;
    const list = String(r.gz || '').split(/\s*;\s*/).filter(Boolean);
    r.gzList = list;
    r.gz = list[list.length - 1] || r.gz;
    r.kind = (r.rsDocs || []).length ? 'rs' : 'e';
  }
  // gleiche Rechtssätze zusammenführen
  const byDoc = new Map();
  sb.rulings = (sb.rulings || []).filter(r => {
    const d = r.kind === 'rs' && r.rsDocs?.[0];
    if (!d) return true;
    const ex = byDoc.get(d);
    if (!ex) { byDoc.set(d, r); return true; }
    ex.matched = [...new Set([...(ex.matched || []), ...(r.matched || [])])];
    ex.cited = ex.cited || r.cited;
    return false;
  });
}

const normNum = n => { const m = String(n).match(/§\s*(\d+)/); return m ? +m[1] : null; };
const normLaw = n => (String(n).match(/^([A-ZÄÖÜa-zäöü-]+)\s*§/) || String(n).match(/§\s*\d+[a-z]?\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöü-]+)/) || [])[1] || '';

// Kostenlose Zuordnung über die Paragraphen: Kapiteltitel („§§ 1053 ff“) und Normen aus den Zusammenfassungen
export function chaptersByNorm(sub, r) {
  const chs = allChapters(sub);
  const nums = (r.normen || []).map(n => ({ law: normLaw(n), num: normNum(n) })).filter(x => x.num);
  const score = new Map();
  for (const c of chs) {
    const own = (c.summary?.normen || []).map(toRisNorm).filter(Boolean).map(n => ({ law: normLaw(n), num: normNum(n) }));
    for (const x of nums) if (own.some(o => o.num === x.num && (!o.law || !x.law || o.law === x.law))) score.set(c.id, (score.get(c.id) || 0) + 2);
  }
  // Kapitel mit „(§§ X ff)“ im Titel: Paragraph gehört zum Kapitel mit dem nächstkleineren Anfang im selben Buch
  const ranged = chs.map(c => ({ c, start: (c.title.match(/\(§§?\s*(\d+)/) || [])[1] })).filter(x => x.start).map(x => ({ ...x, start: +x.start }));
  for (const x of nums.filter(x => !x.law || x.law === 'ABGB')) {
    const cand = ranged.filter(r2 => r2.start <= x.num).sort((a, b) => b.start - a.start)[0];
    if (cand && x.num - cand.start < 150) score.set(cand.c.id, (score.get(cand.c.id) || 0) + 1);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
}

export async function prepareRulings(subId, onStatus = () => {}) {
  store.update(s => migrateRulings(s.subjects.find(x => x.id === subId)), { silent: true });
  let sub = store.subject(subId);
  const valid = new Set(allChapters(sub).map(c => c.id));
  // 1. Rechtssätze aus dem RIS holen (kostenlos)
  const todo = sub.rulings.filter(r => r.source === 'ris' && r.head == null && (r.rsDocs || []).length);
  let n = 0;
  for (const r of todo) {
    n++;
    onStatus(`Lade Rechtssätze aus dem RIS (${n}/${todo.length}) …`);
    let h;
    try { h = await fetchRechtssatz(r.rsDocs[0]); } catch (e) { console.warn(e); if (n === 1) throw e; continue; }
    store.update(s => { const x = s.subjects.find(y => y.id === subId).rulings.find(y => y.id === r.id); if (x) { x.head = h.text || ''; x.rsNr = x.rsNr || h.rsNr; if (h.schlagworte) x.schlagworte = h.schlagworte; } }, { silent: n % 10 !== 0 });
    await new Promise(res => setTimeout(res, 250));
  }
  // 2. Schlagwörter und Kapitel zuordnen (schnelles Modell, Bruchteil eines Cents pro Urteil)
  sub = store.subject(subId);
  const chs = allChapters(sub);
  if (!chs.length) return;
  const sig = chs.length + ':' + chs[0].id + ':' + chs[chs.length - 1].id;
  const open = sub.rulings.filter(r => r.source === 'ris' && (r.head || r.schlagworte) && !(r.chapterIds || []).some(id => valid.has(id)) && r.classified !== sig);
  const chapterList = chs.map(c => `${c.id} | ${c.bookTitle} | ${c.title}`).join('\n');
  for (let i = 0; i < open.length; i += 40) {
    const part = open.slice(i, i + 40);
    onStatus(`Ordne Urteile den Kapiteln zu (${Math.min(i + 40, open.length)}/${open.length}) …`);
    let res = {};
    try {
      res = await completeJson({
        model: 'fast', maxTokens: 6000, purpose: 'OGH zuordnen',
        system: 'Du ordnest Rechtssätze des österreichischen OGH Lehrbuchkapiteln zu. Nur zuordnen, wenn das Kapitel das Thema wirklich behandelt.',
        messages: [{ role: 'user', content: `Gib für jeden Rechtssatz 2–4 kurze Schlagwörter (Rechtsinstitute/Probleme, wie man sie im Studium nennt) und die 1–2 passenden Kapitel-IDs aus der Liste an (leer, wenn keines passt).\nJSON: {"urteile":[{"id":"…","schlagworte":["…"],"kapitel":["…"]}]}\n\nKAPITEL (ID | Buch | Titel):\n${chapterList}\n\nRECHTSSÄTZE:\n${part.map(r => `${r.id} | Normen: ${(r.normen || []).slice(0, 5).join(', ')} | ${(r.head || r.schlagworte).slice(0, 600)}`).join('\n')}` }]
      });
    } catch (e) {
      if (e.budget) { onStatus('Zuordnung per KI abgebrochen – Zuordnung nur über Paragraphen.'); break; }
      console.warn(e); continue;
    }
    const map = new Map((res.urteile || []).map(u => [u.id, u]));
    store.update(s => {
      const sb = s.subjects.find(y => y.id === subId);
      for (const r of part) {
        const x = sb.rulings.find(y => y.id === r.id); if (!x) continue;
        const u = map.get(r.id);
        x.classified = sig;
        if (u) { x.tags = (u.schlagworte || []).filter(Boolean).slice(0, 4); x.chapterIds = (u.kapitel || []).filter(id => valid.has(id)).slice(0, 2); }
      }
    });
  }
}


// ---------- Fach-Chat: passende Stellen aus allen Lehrbüchern und Einheiten heraussuchen (lokal, kostenlos) ----------
const STOP = new Set('aber alle also auch dass dann dass denn dein dem den der des die dies diese dieser doch durch eine einem einen einer eines erst etwa für gibt habe haben hast hier immer ist jetzt kann kannst mein mich mir mit nach nicht noch nur oder schon sein sich sie sind über und uns unter vom von war was weil wenn werden wie wird wir zum zur bitte erkläre erklär mal genau frage fragen thema kapitel buch unterschied zwischen welche welcher welches warum wann wieso'.split(' '));
const terms = q => [...new Set(String(q).toLowerCase().replace(/§\s*(\d+)/g, ' §$1 ').split(/[^a-zäöüß0-9§]+/).filter(w => (w.length > 3 || /^§\d+/.test(w)) && !STOP.has(w)).map(w => w.length > 8 && !w.startsWith('§') ? w.slice(0, 7) : w))]; // grobe Wortstämme

export async function subjectContext(subId, question, maxChars = 45000) {
  const sub = store.subject(subId);
  const qs = terms(question);
  const passages = [];
  for (const b of sub.books) {
    if (bookRole(b) === 'aus' || !b.chapters?.length) continue;
    let t;
    try { t = await getFileText(sub, b.fileId); } catch { continue; }
    if (!t?.pages) continue;
    for (const c of b.chapters) {
      if (!isStudyChapter(c)) continue;
      for (let n = c.startPage; n <= c.endPage; n++) {
        const p = t.pages[n - 1]; if (!p) continue;
        const low = p.text.toLowerCase();
        let score = 0;
        for (const w of qs) { const k = low.split(w).length - 1; if (k) score += 1 + Math.log(1 + k) + (c.title.toLowerCase().includes(w) ? 2 : 0); }
        if (score > 0) passages.push({ score, text: p.text, label: p.label, book: b.title, chapter: c.title });
      }
    }
  }
  passages.sort((a, b) => b.score - a.score);
  let used = 0;
  const picked = [];
  for (const p of passages) { if (used + p.text.length > maxChars) break; picked.push(p); used += p.text.length; }
  const units = (sub.units || []).filter(u => u.analysis).map(u => `- ${u.title}: ${u.analysis.thema || ''} – ${(u.analysis.profBetont || []).map(x => x.hinweis).join('; ').slice(0, 400)}`).join('\n');
  const toc = sub.books.filter(b => bookRole(b) !== 'aus' && b.chapters?.length).map(b => `${b.title}: ${b.chapters.filter(isStudyChapter).map(c => c.title.replace(/^\d+\.\s*Kapitel:\s*/, '')).join(' | ')}`).join('\n');
  return { text: picked.map(p => `[${p.book} – ${p.chapter}, S. ${p.label}]\n${p.text}`).join('\n\n'), units, toc, n: picked.length };
}
