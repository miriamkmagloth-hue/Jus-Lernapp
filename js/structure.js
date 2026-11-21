// Buchstruktur ohne KI erkennen: gedruckte Seitenzahlen, Inhaltsverzeichnis-Seiten, Kapitelanfänge.
// Reine Funktionen (kein DOM, kein Netz) – laufen im Browser und in Node-Tests.

const DOTS = /(?:[.…]\s?){4,}\s*[\dIVXLC]+(?:\/\d+)?\s*$/;
const ROMAN = /^[IVXLC]+$/i;
const BACK_MATTER = /^(?:stichwortverzeichnis|sachregister|sachverzeichnis|register|stichwörter|literaturverzeichnis|abkürzungsverzeichnis|anhang|über den autor|die autoren)\b/i;

const lines = t => String(t || '').split('\n').map(s => s.trim()).filter(Boolean);
const norm = s => String(s || '').toLowerCase().replace(/[^a-zäöüß0-9]+/g, ' ').trim();

function romanToInt(s) {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0; s = s.toLowerCase();
  for (let i = 0; i < s.length; i++) { const a = v[s[i]], b = v[s[i + 1]] || 0; n += a < b ? -a : a; }
  return n;
}

// Zeilen mit Punktreihen + Seitenzahl/Randzahl = Verzeichniszeilen
export function dotLines(text) { return lines(text).filter(l => DOTS.test(l)).length; }

// Gedruckte Seitenzahl einer Seite aus Kopf- oder Fußzeile (arabisch oder römisch)
export function printedNumber(text) {
  const ls = lines(text);
  const cand = [...ls.slice(0, 3), ...ls.slice(-2)];
  for (const l of cand) {
    let m = l.match(/^(\d{1,4})$/) || l.match(/^(\d{1,4})\s+\S.{3,}$/) || l.match(/^\S.{3,}\s(\d{1,4})$/);
    if (m && +m[1] > 0) return { n: +m[1], roman: false };
    m = l.match(/^([IVXLC]{1,7})$/) || l.match(/^([IVXLC]{1,7})\s+\S.{3,}$/);
    if (m) return { n: romanToInt(m[1]), roman: true };
  }
  return null;
}

// Verhältnis gedruckte Seite -> PDF-Seite (häufigster Abstand der arabischen Seitenzahlen)
export function pageMap(pages) {
  const diffs = new Map();
  for (const p of pages) {
    const pn = printedNumber(p.text);
    if (pn && !pn.roman && pn.n <= pages.length) diffs.set(p.n - pn.n, (diffs.get(p.n - pn.n) || 0) + 1);
  }
  let offset = 0, best = 0;
  for (const [d, c] of diffs) if (c > best) { best = c; offset = d; }
  const reliable = best >= Math.min(20, pages.length / 4);
  return { offset: reliable ? offset : null, toPdf: printed => (reliable ? printed + offset : null) };
}

// Seiten des großen Inhaltsverzeichnisses vorne im Buch
export function tocPages(pages) {
  const set = new Set();
  const limit = Math.max(25, Math.ceil(pages.length * 0.2));
  let started = false, misses = 0;
  for (const p of pages.slice(0, limit)) {
    const ls = lines(p.text);
    const d = dotLines(p.text);
    const isToc = d >= 3 || (d >= 1 && (started || ls.slice(0, 5).some(l => /^(inhaltsverzeichnis|inhaltsübersicht|inhalt)$/i.test(l))));
    // Kapitelanfang mit eigener Mini-Gliederung (Überschrift steht NACH den Verzeichniszeilen) beendet das Verzeichnis
    if (isToc && started && endsWithHeading(ls)) break;
    if (isToc) { set.add(p.n); started = true; misses = 0; }
    else if (started) break;
  }
  return set;
}

function endsWithHeading(ls) {
  const lastDot = ls.map(l => DOTS.test(l)).lastIndexOf(true);
  return ls.slice(lastDot + 1).some(l => KINDS.some(k => k.re.test(l)));
}

// Kopf-/Fußzeilen und Verzeichniszeilen entfernen (für Text, der an die KI geht)
export function cleanPageText(text) {
  return lines(text).filter(l => !DOTS.test(l)).join('\n');
}

// Überschriften-Muster, die einen Kapitelanfang markieren
const KINDS = [
  { kind: 'kapitel', re: /^(\d{1,3})\.\s*Kapitel(?:\s*[:.–-]\s*(.+))?$/i },
  { kind: 'kapitel', re: /^Kapitel\s+(\d{1,3})(?:\s*[:.–-]\s*(.+))?$/i },
  { kind: 'fall', re: /^Fall\s+(\d{1,3})(?:\s*[:.–-]\s*(.+))?$/i },
  { kind: 'fall', re: /^(\d{1,3})\.\s*Fall(?:\s*[:.–-]\s*(.+))?$/i },
  { kind: 'paragraph', re: /^§\s*(\d{1,3})\.?(?:\s+([A-ZÄÖÜ].{2,80}))?$/ },
  { kind: 'teil', re: /^(\d{1,2})\.\s*Teil(?:\s*[:.–-]\s*(.+))?$/i },
];

function titleAfter(ls, i, inline) {
  if (inline) return inline.replace(DOTS, '').trim();
  const out = [];
  for (let k = i + 1; k < Math.min(ls.length, i + 4); k++) {
    const l = ls[k];
    if (DOTS.test(l) || /^[IVX]+\.\s/.test(l) || /^\d+\.\s*(abschnitt|kapitel|teil)/i.test(l) || /^\d+\/\d+$/.test(l)) break;
    if (l.length > 120) break;
    out.push(l);
    if (!/[–,-]$/.test(l) && !(k + 1 < ls.length && /^\(/.test(ls[k + 1]))) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function headingCandidates(pages) {
  const found = {};
  for (const p of pages) {
    const ls = lines(p.text);
    ls.forEach((l, i) => {
      for (const { kind, re } of KINDS) {
        const m = l.match(re);
        if (!m) continue;
        // Eintrag eines Verzeichnisses (gleich danach folgen Punktreihen) – kein Kapitelanfang
        if (DOTS.test(l) || ls.slice(i + 1, i + 4).some(x => DOTS.test(x))) break;
        const title = titleAfter(ls, i, m[2]);
        if (!title || title.length < 3) continue;
        (found[kind] = found[kind] || []).push({ num: +m[1], page: p.n, title, line: i });
        break;
      }
    });
  }
  return found;
}

// Aufsteigende Kapitelfolge aus den Fundstellen bauen (jede Nummer einmal, Seiten aufsteigend)
function sequence(cands) {
  const byNum = new Map();
  for (const c of cands) (byNum.get(c.num) || byNum.set(c.num, []).get(c.num)).push(c);
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  const seq = [];
  let lastPage = 0;
  for (const n of nums) {
    const c = byNum.get(n).find(x => x.page >= lastPage);
    if (!c) continue;
    seq.push(c); lastPage = c.page;
  }
  return seq;
}

function backMatterStart(pages, after) {
  for (const p of pages) {
    if (p.n <= after) continue;
    const head = lines(p.text).slice(0, 4);
    if (head.some(l => BACK_MATTER.test(l) && l.length < 40)) return p.n;
  }
  return pages.length + 1;
}

// Kapitel aus Überschriften im Fließtext. Ergebnis: [{title, start, end, num}] oder null
export function detectByHeadings(pages, toc = tocPages(pages)) {
  const found = headingCandidates(pages);
  let best = null;
  for (const kind of Object.keys(found)) {
    const seq = sequence(found[kind]);
    // Nummern sollen weitgehend lückenlos sein
    if (seq.length < 3) continue;
    const span = seq[seq.length - 1].num - seq[0].num + 1;
    if (seq.length / span < 0.7) continue;
    if (!best || seq.length > best.seq.length) best = { kind, seq };
  }
  if (!best) return null;
  const end = backMatterStart(pages, best.seq[best.seq.length - 1].page);
  const label = { kapitel: 'Kapitel', fall: 'Fall', paragraph: '§', teil: 'Teil' }[best.kind];
  return best.seq.map((c, i) => ({
    num: c.num,
    kind: best.kind,
    title: best.kind === 'paragraph' ? `§ ${c.num} ${c.title}` : best.kind === 'fall' ? `Fall ${c.num}: ${c.title}` : `${c.num}. ${label}: ${c.title}`,
    start: c.page,
    end: Math.max(c.page, (best.seq[i + 1]?.page || end) - 1),
  }));
}

// Teil vor dem ersten Kapitel (z. B. „Falllösungstechnik“) als eigenes Kapitel, wenn er echten Inhalt hat
export function introChapter(pages, toc, firstStart) {
  const after = Math.max(0, ...toc);
  const from = after + 1;
  if (!after || firstStart - from < 3) return null;
  const body = pages.slice(from - 1, firstStart - 1);
  const chars = body.reduce((a, p) => a + cleanPageText(p.text).length, 0);
  if (chars < 4000) return null;
  // Überschrift: erste kurze Zeile nach Kopfzeile, die keine Seitenzahl ist
  const runHead = runningHead(pages);
  const first = body.find(p => lines(p.text).length > 3);
  const cand = lines(first?.text).find(l => l.length > 4 && l.length < 60 && !/^\d+$|^[IVXLC]+$/i.test(l) && !/^\d+\s*$/.test(l) && !(runHead && stripHead(l) === runHead) && /[a-zäöü]{3}/i.test(l));
  return { title: cand ? `Einführung – ${cand}` : 'Einführung', start: from, end: firstStart - 1, intro: true };
}

const stripHead = l => l.replace(/\d+|\b[IVXLC]+\b/g, '').replace(/\s+/g, ' ').trim();
// häufigste Kopfzeile (Autor/Kurztitel), um sie nicht für eine Überschrift zu halten
function runningHead(pages) {
  const cnt = new Map();
  for (const p of pages.slice(0, 80)) for (const l of lines(p.text).slice(0, 2)) {
    const k = stripHead(l);
    if (k.length > 8) cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [k, c] of cnt) if (c > n) { n = c; best = k; }
  return n >= 10 ? best : null;
}

// Steht der Titel wirklich auf der Startseite? (für Lesezeichen/KI-Vorschläge)
export function titleOnPage(title, page) {
  const t = norm(title).replace(/^\d+\s*(kapitel|fall|teil)?\s*/, '');
  const words = t.split(' ').filter(w => w.length > 3).slice(0, 4);
  if (!words.length) return false;
  const p = norm(page?.text);
  return words.filter(w => p.includes(w)).length >= Math.ceil(words.length * 0.75);
}

// Prüft eine Kapitelliste und liefert Warnungen (leer = in Ordnung)
export function checkChapters(chapters, pages, toc = tocPages(pages)) {
  const warn = [];
  for (const c of chapters) {
    if (toc.has(c.start)) warn.push({ id: c.id, msg: `„${c.title}“ beginnt im Inhaltsverzeichnis` });
    const txt = pages.slice(c.start - 1, c.end).map(p => p.text).join('\n');
    const dl = dotLines(txt), all = lines(txt).length || 1;
    if (dl / all > 0.4) warn.push({ id: c.id, msg: `„${c.title}“ besteht überwiegend aus Verzeichniszeilen` });
  }
  const starts = chapters.map(c => c.start);
  if (new Set(starts).size < starts.length) warn.push({ msg: 'Mehrere Kapitel beginnen auf derselben Seite' });
  return warn;
}

// Kurze Leseprobe vom Kapitelanfang (ohne Kopfzeilen und Verzeichniszeilen)
export function excerpt(pages, start, chars = 260) {
  const ls = lines(pages[start - 1]?.text).filter(l => !DOTS.test(l) && l.length > 25);
  return ls.join(' ').slice(0, chars);
}

const toRoman = n => { let r = ''; for (const [v, s] of [[100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { r += s; n -= v; } return r; };

// Seitenbezeichnungen = gedruckte Seitenzahlen (statt PDF-Seitenzählung), damit Seitenangaben zum Buch passen
export function relabel(pages) {
  if (!pages?.length || pages.some(p => p.label && p.label !== String(p.n))) return pages;
  const { offset } = pageMap(pages);
  if (offset == null) return pages;
  return pages.map(p => {
    if (p.n > offset) return { ...p, label: String(p.n - offset) };
    const pn = printedNumber(p.text);
    return { ...p, label: pn?.roman ? toRoman(pn.n) : (p.n <= offset ? toRoman(p.n) : String(p.n)) };
  });
}
