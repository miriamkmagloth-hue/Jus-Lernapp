// RIS (Rechtsinformationssystem des Bundes): OGH-Entscheidungen suchen und laden
// Daten: RIS OGD, Bundeskanzleramt, Lizenz CC BY 4.0
import { store } from './store.js';

const DIRECT_API = 'https://data.bka.gv.at/ris/api/v2.6/';
const DIRECT_DOC = 'https://www.ris.bka.gv.at/';

function bases() {
  const custom = (store.state.settings.risProxy || '').replace(/\/$/, '');
  const list = [];
  if (custom) list.push({ api: custom + '/ris-api/v2.6/', doc: custom + '/ris-doc/' });
  // Auf Netlify gehostet: eingebaute Weiterleitung (_redirects)
  if (location.protocol.startsWith('http') && !location.hostname.match(/^(localhost|127\.)/)) list.push({ api: location.origin + '/ris-api/v2.6/', doc: location.origin + '/ris-doc/' });
  list.push({ api: DIRECT_API, doc: DIRECT_DOC });
  return list;
}

let workingBase = null;
async function risFetch(kind, path, asText = false) {
  const tries = workingBase ? [workingBase, ...bases().filter(b => b !== workingBase)] : bases();
  let lastErr;
  for (const b of tries) {
    try {
      const res = await fetch((kind === 'api' ? b.api : b.doc) + path, { headers: kind === 'api' ? { Accept: 'application/json' } : {} });
      if (!res.ok) {
        // Das RIS liefert manche Normseiten mit Status 404 aus, obwohl der Text vollständig dabei ist
        if (kind === 'doc' && res.status === 404 && asText) { const t = await res.text(); if (/<h3>\s*Text\s*<\/h3>|Rechtssatz/.test(t)) { workingBase = b; return t; } }
        throw new Error('RIS ' + res.status);
      }
      const ct = res.headers.get('content-type') || '';
      if (kind === 'api' && !ct.includes('json')) throw new Error('RIS: keine JSON-Antwort');
      workingBase = b;
      return asText ? await res.text() : await res.json();
    } catch (e) { lastErr = e; }
  }
  throw new Error('Das RIS ist gerade nicht erreichbar (' + (lastErr?.message || 'Netzwerk') + '). Wenn die App nicht über Netlify läuft, bitte in den Einstellungen eine RIS-Weiterleitung eintragen.');
}

// Hilfsfunktionen zum robusten Auslesen der verschachtelten Antwort
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(asList);
  if (typeof v === 'object') {
    if ('item' in v) return asList(v.item);
    if ('#text' in v) return [v['#text']];
    return Object.values(v).flatMap(asList);
  }
  return [String(v)];
}
function allStrings(obj, out = []) {
  if (obj == null) return out;
  if (typeof obj === 'string') out.push(obj);
  else if (typeof obj === 'object') Object.values(obj).forEach(v => allStrings(v, out));
  return out;
}

function parseRef(ref) {
  const meta = ref?.Data?.Metadaten || ref?.Data || ref;
  const tech = meta?.Technisch || {};
  const docNr = tech.ID || findKey(meta, 'Dokumentnummer') || '';
  const gzList = asList(findKey(meta, 'Geschaeftszahl')).join('; ').split(/\s*;\s*/).map(x => x.trim()).filter(Boolean);
  const gz = gzList[gzList.length - 1] || '';
  const date = asList(findKey(meta, 'Entscheidungsdatum'))[0] || '';
  const normen = asList(findKey(meta, 'Normen'));
  const schlagworte = asList(findKey(meta, 'Schlagworte')).join(' ');
  const organ = tech.Organ || asList(findKey(meta, 'Gericht'))[0] || '';
  const dokTyp = asList(findKey(meta, 'Dokumenttyp'))[0] || (String(docNr).startsWith('JJR') ? 'Rechtssatz' : 'Entscheidungstext');
  const strs = allStrings(ref);
  const textDocs = [...new Set(strs.flatMap(s => s.match(/JJT_[A-Z0-9_]+/g) || []))];
  const rsNr = asList(findKey(meta, 'Rechtssatznummern'))[0] || asList(findKey(meta, 'Rechtssatznummer'))[0] || '';
  const url = asList(findKey(meta, 'DokumentUrl'))[0] || (docNr ? `https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Justiz&Dokumentnummer=${docNr}` : '');
  return { docNr, gz: String(gz).trim(), gzList, date: String(date).slice(0, 10), normen, schlagworte, organ: String(organ), dokTyp, textDocs, rsNr, url };
}

export async function searchJustiz({ norm, suchworte, gz, von, bis, seite = 1, proSeite = 'Fifty', texte = false } = {}) {
  const p = new URLSearchParams({ Applikation: 'Justiz', DokumenteProSeite: proSeite, Seitennummer: String(seite), Sortierung: 'Datum', SortDirection: 'Descending' });
  if (norm) p.set('Norm', norm);
  if (suchworte) p.set('Suchworte', suchworte);
  if (gz) p.set('Geschaeftszahl', gz);
  if (von) p.set('EntscheidungsdatumVon', von);
  if (bis) p.set('EntscheidungsdatumBis', bis);
  if (texte) p.set('Dokumenttyp.SucheInEntscheidungstexten', 'true');
  const j = await risFetch('api', 'Judikatur?' + p.toString());
  const res = j?.OgdSearchResult?.OgdDocumentResults;
  if (!res) return { hits: 0, items: [] };
  const hits = Number(res.Hits?.['#text'] || res.Hits || 0);
  const refs = Array.isArray(res.OgdDocumentReference) ? res.OgdDocumentReference : res.OgdDocumentReference ? [res.OgdDocumentReference] : [];
  const items = refs.map(parseRef).filter(x => /OGH/i.test(x.organ) || /^\d+\s?Ob/i.test(x.gz) || /^\d+\s?(Os|Ob|Ra|Nc|Fs)/.test(x.gz));
  return { hits, items };
}

// RIS-Seite in Text mit Zeilenumbrüchen umwandeln (Vorlesetext für Screenreader entfernen)
function htmlToLines(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,noscript,[class*="sr-only"],[class*="SrOnly"],[class*="visually-hidden"],[aria-hidden="false"].sr').forEach(n => n.remove());
  doc.querySelectorAll('p,div,h1,h2,h3,h4,h5,li,tr,br,dt,dd,section').forEach(n => n.appendChild(doc.createTextNode('\n')));
  return (doc.body?.textContent || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
// Doppelt vorgelesene Absätze („§ 1298“ / „Paragraph 1298“) nur einmal behalten
function dedupeSpoken(lines) {
  const key = l => l.replace(/Paragraph(en)?\s*/g, '§ ').replace(/Absatz\s*/g, 'Abs ').replace(/Ziffer\s*/g, 'Z ').replace(/[^a-z0-9äöüß]/gi, '').toLowerCase();
  const seen = new Set(), out = [];
  for (const l of lines) { const k = key(l); if (k.length > 20 && seen.has(k)) continue; seen.add(k); out.push(l); }
  return out;
}
const docPath = docNr => `Dokument.wxe?Abfrage=Justiz&Dokumentnummer=${encodeURIComponent(docNr)}`;

export async function fetchDocText(docNr) {
  const html = await risFetch('doc', docPath(docNr), true);
  const lines = dedupeSpoken(htmlToLines(html));
  const from = lines.findIndex(l => /^(Gericht|Kopf|Rechtssatz für)/.test(l));
  const to = lines.findIndex((l, i) => i > from && /^Über diese Seite$/.test(l));
  return lines.slice(Math.max(0, from), to > 0 ? to : undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Rechtssatz (Kernaussage) samt Rechtssatznummer – kurz, kostenlos, direkt aus dem RIS
const LABELS = ['Gericht', 'Dokumenttyp', 'Rechtsgebiet', 'Rechtssatznummer', 'Geschäftszahl', 'Entscheidungsdatum', 'Norm', 'Rechtssatz', 'Entscheidungstexte', 'Schlagworte', 'European Case Law Identifier (ECLI)', 'Dokumentnummer', 'Navigation im Suchergebnis', 'Über diese Seite', 'Begleitende Dokumente'];
export async function fetchRechtssatz(docNr) {
  const html = await risFetch('doc', docPath(docNr), true);
  const lines = dedupeSpoken(htmlToLines(html));
  const section = name => {
    const i = lines.lastIndexOf(name);
    if (i < 0) return [];
    const out = [];
    for (let k = i + 1; k < lines.length && !LABELS.includes(lines[k]); k++) out.push(lines[k]);
    return out;
  };
  const text = section('Rechtssatz').join(' ').trim();
  const rsNr = (section('Rechtssatznummer').join(' ').match(/RS\d{7}/) || html.match(/RS\d{7}/) || [''])[0];
  const schlagworte = section('Schlagworte').join(' ').trim();
  return { text, rsNr, schlagworte };
}

// "§ 1295 ABGB" -> "ABGB §1295"
export function toRisNorm(n) {
  const m = String(n).match(/§{1,2}\s*(\d+[a-z]?)(?:\s*f{1,2}\.?)?(?:\s*(?:Abs\.?|Abs)\s*\d+)?(?:\s*(?:Z|lit\.?)\s*\S+)?(?:\s*f{1,2}\.?)?\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]{1,20})/);
  if (m) return `${m[2]} §${m[1]}`;
  const m2 = String(n).match(/^([A-ZÄÖÜ][A-Za-zÄÖÜäöü\-]+)\s*§\s*(\d+[a-z]?)/);
  if (m2) return `${m2[1]} §${m2[2]}`;
  return null;
}

// OGH-Geschäftszahlen und Rechtssatznummern aus Lehrbuchtext herausziehen
const GZ_RE = /\b(\d{1,2})\s?(Ob|Os|ObA|ObS|Nc|Fs|Ra)\s?(\d{1,4})\/(\d{2})([a-z])\b/g;
export function extractCitations(text) {
  const map = new Map();
  for (const m of text.matchAll(GZ_RE)) {
    const gz = `${m[1]} ${m[2]} ${m[3]}/${m[4]}${m[5]}`;
    map.set(gz, (map.get(gz) || 0) + 1);
  }
  const rs = new Map();
  for (const m of text.matchAll(/\bRS\s?0\d{6}\b/g)) {
    const k = m[0].replace(/\s/g, '');
    rs.set(k, (rs.get(k) || 0) + 1);
  }
  return { gz: [...map.entries()].sort((a, b) => b[1] - a[1]), rs: [...rs.entries()].sort((a, b) => b[1] - a[1]) };
}

// Link zum Gesetzestext im RIS
const GESETZESNR = { ABGB: '10001622', 'B-VG': '10000138', StGB: '10002296', ZPO: '10001699', UGB: '10001702', KSchG: '10002462', StPO: '10002326', AVG: '10005768', EO: '10001700', IO: '10001736', MRG: '10002531', GmbHG: '10001720', AktG: '10002070', EheG: '10001871', JN: '10001697', ASVG: '10008147', VStG: '10005770', EKHG: '10002013', AußStrG: '20003047', WEG: '20001921', ECG: '20001703', FAGG: '20008847', VKrG: '20007120', PHG: '10002864', ABGBEinf: '' };
export function normLink(paragraph, law) {
  const nr = GESETZESNR[law];
  if (nr) return `https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=${nr}&Paragraf=${encodeURIComponent(paragraph)}`;
  return `https://www.google.com/search?q=${encodeURIComponent('RIS § ' + paragraph + ' ' + law)}`;
}

// Gesetzesnummer für Abkürzungen, die nicht fest hinterlegt sind (z. B. VGG, DHG), im RIS nachschlagen
export async function gesetzesNr(law) {
  if (GESETZESNR[law]) return GESETZESNR[law];
  const key = 'risNr:' + law;
  try { const c = localStorage.getItem(key); if (c) return c; } catch {}
  const r = await risFetch('api', `Bundesrecht?Applikation=BrKons&Titel=${encodeURIComponent(law)}&DokumenteProSeite=Twenty`);
  const docs = [].concat(r?.OgdSearchResult?.OgdDocumentResults?.OgdDocumentReference || []);
  const hit = docs.map(d => d?.Data?.Metadaten?.Bundesrecht).find(m => String(m?.BrKons?.Abkuerzung || '').toLowerCase().replace(/\s/g, '') === law.toLowerCase());
  const nr = hit?.BrKons?.Gesetzesnummer;
  if (!nr) throw new Error('Gesetz „' + law + '“ im RIS nicht gefunden');
  try { localStorage.setItem(key, nr); } catch {}
  return nr;
}

// Gesetzestext eines Paragraphen aus dem RIS holen (geltende Fassung) – nur der Normtext, ohne Kopfdaten
function normTextFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,.sr-only,[class*="onlyScreenreader"]').forEach(n => n.remove());
  const h = [...doc.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Text');
  const box = h?.parentElement;
  if (!box) return '';
  h.remove();
  box.querySelectorAll('h4,h5,li,p,div.Abs,div.Abs_small_indent,div[class*="Abs"],div[class*="Z"],div[class*="Lit"],br,tr').forEach(n => n.appendChild(doc.createTextNode('\n')));
  box.querySelectorAll('h4').forEach(n => n.prepend(doc.createTextNode('\n')));
  return box.textContent.replace(/ /g, ' ').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    .replace(/^(§\s*\d+[a-z]?\.)\n/m, '$1 ')
    .replace(/(\(\d+[a-z]?\))(?=[A-Za-zÄÖÜäöü])/g, '$1 ')
    .replace(/^(\d+[a-z]?\.|[a-z]\))(?=[A-Za-zÄÖÜäöü])/gm, '$1 ');
}

export async function fetchNormText(law, para) {
  const nr = await gesetzesNr(law);
  let text = '';
  try { text = normTextFromHtml(await risFetch('doc', `NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=${nr}&Paragraf=${encodeURIComponent(para)}`, true)); } catch {}
  if (text.length < 10) {
    // Ausweg über die Such-Schnittstelle (z. B. Gesetze, deren Paragraphen in einem „Artikel“ stehen)
    const num = String(para).match(/\d+/)?.[0];
    const r = await risFetch('api', `Bundesrecht?Applikation=BrKons&Gesetzesnummer=${nr}&Abschnitt.Von=${num}&Abschnitt.Bis=${num}&Abschnitt.Typ=Paragraph&Fassung.FassungVom=${new Date().toISOString().slice(0, 10)}`);
    const docs = [].concat(r?.OgdSearchResult?.OgdDocumentResults?.OgdDocumentReference || []);
    const id = docs.map(d => d?.Data?.Metadaten).find(m => new RegExp('§\\s*' + para + '\\b').test(m?.Bundesrecht?.BrKons?.ArtikelParagraphAnlage || ''))?.Technisch?.ID || docs[0]?.Data?.Metadaten?.Technisch?.ID;
    if (id) text = normTextFromHtml(await risFetch('doc', `Dokument.wxe?Abfrage=Bundesnormen&Dokumentnummer=${id}`, true));
  }
  if (text.length < 10) throw new Error('Text nicht gefunden');
  return text.slice(0, 15000);
}
