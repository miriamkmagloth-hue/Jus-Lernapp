// Einstieg: Start, Navigation, automatische Synchronisierung
import { STRUCT_VER, markDuplicates } from './processing.js';
import { store, local, bookRole, bookInExam, isStudyChapter } from './store.js';
import { openLaw, openPages } from './law.js';
import { serverAuthInfo, signIn, signInSilently, syncOnStart, onSync, onNeedLogin, isSignedIn, canStaySignedIn } from './drive.js';
import { $, $$, toast } from './ui.js';
import { onJobs, runJob, jobs } from './jobs.js';
import { applyTheme } from './theme.js';
import { scanSubject, processBook, analyzeUnit, analyzeAltklausur, summarizeRuling, checkNewRulings, shareAllTexts, detectBookTitle, pollBatches } from './processing.js';
import * as main from './views-main.js';
import * as subj from './views-subject.js';
import * as learn from './views-learn.js';

const routes = [
  [/^#?\/?$/, main.dashboard, 'home'],
  [/^#\/faecher$/, main.subjectList, 'faecher'],
  [/^#\/fach\/neu$/, main.subjectEditor, 'faecher'],
  [/^#\/fach\/([^/]+)\/bearbeiten$/, main.subjectEditor, 'faecher'],
  [/^#\/fach\/([^/]+)\/kapitel\/([^/]+)(?:\/([^/]+))?$/, subj.chapterView, 'faecher'],
  [/^#\/fach\/([^/]+)\/skript\/([^/]+)$/, subj.skriptView, 'faecher'],
  [/^#\/fach\/([^/]+)\/einheit\/([^/]+)(?:\/([^/]+))?$/, subj.unitView, 'faecher'],
  [/^#\/fach\/([^/]+)\/urteil\/([^/]+)(?:\/([^/]+))?$/, subj.rulingView, 'faecher'],
  [/^#\/fach\/([^/]+)\/altklausur\/([^/]+)$/, subj.altklausurView, 'faecher'],
  [/^#\/fach\/([^/]+)\/pruefung\/([^/]+)$/, subj.examView, 'faecher'],
  [/^#\/fach\/([^/]+)\/einstufung\/([^/]+)(?:\/([^/]+))?$/, learn.assessmentView, 'faecher'],
  [/^#\/fach\/([^/]+)\/fall(?:\/([^/]+))?$/, learn.caseView, 'faecher'],
  [/^#\/fach\/([^/]+)\/simulation\/([^/]+)$/, learn.oralView, 'faecher'],
  [/^#\/fach\/([^/]+)(?:\/([^/]+))?$/, subj.subjectView, 'faecher'],
  [/^#\/karten(?:\/([^/]+))?$/, learn.cardsView, 'karten'],
  [/^#\/statistik$/, main.statsView, 'statistik'],
  [/^#\/fehlerbuch$/, main.mistakesView, 'statistik'],
  [/^#\/einstellungen$/, main.settingsView, 'einstellungen'],
  [/^#\/einrichtung$/, main.setupView, 'einstellungen'],
  [/^#\/design$/, main.designView, 'einstellungen'],
  [/^#\/kalender$/, main.calendarView, 'home']
];

let currentHash = null;
export function render(force = false) {
  const hash = location.hash || '#/';
  const app = $('#app');
  for (const [re, view, nav] of routes) {
    const m = hash.match(re);
    if (m) {
      $$('#bottomnav a').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
      const isTop = ['#/', '#', '', '#/faecher', '#/karten', '#/statistik', '#/einstellungen'].includes(hash);
      $('#backBtn').hidden = isTop;
      if (hash !== currentHash) window.scrollTo(0, 0);
      currentHash = hash;
      app.innerHTML = '';
      try { view(app, ...m.slice(1).map(x => x && decodeURIComponent(x))); }
      catch (e) { console.error(e); app.innerHTML = `<div class="notice err">Fehler beim Anzeigen: ${e.message}</div>`; }
      return;
    }
  }
  location.hash = '#/';
}
export function setTitle(t) { $('#pageTitle').textContent = t; document.title = t + ' – Jus-Lernapp'; }

// Nur neu zeichnen, wenn gerade nicht getippt wird
export function softRender() {
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox'))) return;
  if (document.querySelector('[data-no-rerender]')) return;
  render();
}

window.addEventListener('hashchange', () => render());
// Paragraphen antippen: Gesetzestext mit markierten Stichwörtern öffnen
// Seitenangaben antippen → die Buchseiten lesen
document.addEventListener('click', e => {
  const c = e.target.closest('.cite');
  if (!c) return;
  const m = (location.hash || '').match(/^#\/fach\/([^/]+)(?:\/(kapitel|skript)\/([^/]+))?/);
  if (!m) return;
  const chId = c.closest('[data-chid]')?.dataset.chid || (m[2] === 'kapitel' ? m[3] : '');
  openPages({ subId: m[1], chId, fileId: m[2] === 'skript' ? m[3] : '', ref: c.textContent });
});

document.addEventListener('click', e => {
  const a = e.target.closest('a.norm');
  if (!a || !a.dataset.para) return;
  e.preventDefault();
  const ctx = (a.closest('li, p, details, .card') || a.parentElement)?.textContent || '';
  const m = (location.hash || '').match(/^#\/fach\/([^/]+)/);
  openLaw({ para: a.dataset.para, law: a.dataset.law, kind: a.dataset.kind || 'para', context: ctx, subId: m?.[1], href: a.href });
});
$('#backBtn').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/');

onSync(s => {
  const el = $('#syncState');
  el.textContent = { offline: '○ nicht verbunden', 'lädt': '⟳ lädt', speichert: '⟳ speichert', synchron: '✓ synchron', Fehler: '⚠ Sync-Fehler', anmelden: '↻ Google: anmelden' }[s] || s;
  el.style.cursor = s === 'anmelden' ? 'pointer' : '';
  el.classList.toggle('pill', s === 'anmelden');
});
// Ein Tipp auf „anmelden“ erneuert die Verbindung (Klick nötig, sonst blockiert der Browser das Google-Fenster)
$('#syncState').addEventListener('click', async () => {
  if ($('#syncState').textContent.includes('anmelden')) {
    try { await signIn(); await syncOnStart(); softRender(); autoUpdate(); } catch (e) { toast(e.message, 5000); }
  }
});

// Wenn Hintergrundaufgaben fertig werden, Ansicht auffrischen
onJobs((key, job) => {
  const bar = document.querySelector('[data-jobs]');
  if (bar) subj.renderJobBar(bar);
  if (!job || job.done) softRender();
});

// Lernzeit messen: aktive Minuten innerhalb eines Fachs
let lastActivity = Date.now();
['click', 'keydown', 'touchstart', 'scroll'].forEach(ev => window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (document.visibilityState !== 'visible' || Date.now() - lastActivity > 3 * 60 * 1000) return;
  const m = (location.hash || '').match(/^#\/fach\/([^/]+)/) || (location.hash || '').match(/^#\/karten\/([^/]+)/);
  if (!m || m[1] === 'neu') return;
  const day = new Date().toISOString().slice(0, 10);
  store.update(s => {
    let sess = s.progress.sessions.find(x => x.day === day && x.subId === m[1]);
    if (!sess) { sess = { day, subId: m[1], minutes: 0 }; s.progress.sessions.push(sess); }
    sess.minutes += 0.5;
    // Lernzeit auch dem Kapitel zuordnen (für das persönliche Lerntempo)
    const k = (location.hash || '').match(/^#\/fach\/[^/]+\/kapitel\/([^/]+)/);
    if (k) {
      const pc = s.progress.chapters[k[1]] || (s.progress.chapters[k[1]] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 });
      pc.minutes = (pc.minutes || 0) + 0.5;
    }
    // Falltraining: Zeit auf die Kapitel des aktuellen Falls verteilen
    const f = (location.hash || '').match(/^#\/fach\/([^/]+)\/fall/);
    if (f) {
      try {
        const c = JSON.parse(sessionStorage.getItem('case:' + f[1]) || 'null');
        const ids = (c?.kapitelIds || []).filter(id => s.progress.chapters[id] || true);
        ids.forEach(id => { const pc = s.progress.chapters[id] || (s.progress.chapters[id] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 }); pc.minutes = (pc.minutes || 0) + 0.5 / ids.length; });
      } catch {}
    }
    if (s.progress.sessions.length > 2000) s.progress.sessions = s.progress.sessions.slice(-2000);
  }, { silent: true });
}, 30000);

// Automatik: neue Dateien finden und verarbeiten, neue OGH-Urteile holen
export async function autoUpdate({ subjects = null } = {}) {
  if (!isSignedIn()) return;
  const list = subjects || store.state.subjects.map(s => s.id);
  for (const id of list) {
    const sub = store.subject(id);
    if (!sub) continue;
    await runJob('scan:' + id, `Suche neue Dateien in „${sub.name}“`, async st => {
      const neu = await scanSubject(id, st);
      if (neu.length) toast(`${neu.length} neue Datei(en) in „${sub.name}“ gefunden`);
    }, { subId: id });
    shareAllTexts(store.subject(id)).catch(() => {});
    if (store.state.settings.autoProcess === false) continue;
    queueProcessing(id);
    const s2 = store.subject(id);
    const booksReady = s2.books.some(b => b.status === 'fertig');
    const stale = !s2.rulingMeta?.lastCheck || Date.now() - s2.rulingMeta.lastCheck > 3 * 86400000;
    if (booksReady && stale) runJob('ogh:' + id, `Suche neue OGH-Urteile für „${sub.name}“`, st => checkNewRulings(id, st).then(n => { if (n) toast(`${n} neue OGH-Entscheidung(en) für „${sub.name}“`); }), { subId: id });
  }
}

export function queueProcessing(id) {
  const sub = store.subject(id);
  if (!sub) return;
  // Bücher der nächsten Prüfung zuerst, Nachschlagewerke (nur einlesen) zuletzt, „nicht verwenden“ gar nicht
  const next = (sub.exams || []).filter(e => e.status === 'aktiv' && e.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  const rank = b => ({ nachschlag: 3, faelle: 2 }[bookRole(b)] ?? (bookInExam(b, next) ? 0 : 1));
  // Vorbereiten (Text, Kapitel, Kostenvoranschlag) läuft automatisch und kostet so gut wie nichts.
  // Zusammenfassen erst nach Freigabe (b.approved) – nie automatisch.
  const needsWork = b => {
    const r = bookRole(b);
    if (r === 'aus' || ['fehler', 'pausiert', 'hintergrund'].includes(b.status) || b.batch) return false;
    if (r === 'nachschlag') return b.status !== 'nachschlagbar';
    if (b.approved) return true;
    if (b.chapters?.length && b.structVer !== STRUCT_VER) return true; // Kapitel mit verbesserter Erkennung neu bestimmen (kostenlos)
    if (!b.chapters?.length) return true;
    const freeAI = store.state.settings.provider === 'gemini';
    if (freeAI && b.chapters.some(c => isStudyChapter(c) && (r === 'faelle' ? !c.cases : !c.summary))) return true; // kostenlos: einfach weitermachen
    if (b.status === 'bereit' && b.estimate) return false;
    const open = b.chapters.some(c => r === 'faelle' ? !c.cases : !c.summary);
    return open && !b.estimate;
  };
  markDuplicates(id);
  const books = sub.books.filter(needsWork).sort((a, b) => rank(a) - rank(b));
  // Bücher, die schon verarbeitet sind: echten Titel nachträglich erkennen
  for (const b of sub.books) if (!b.titleDetected && !b.titleManual && bookRole(b) !== 'aus' && !books.includes(b)) runJob('title:' + b.fileId, `Buchtitel von „${b.title}“ erkennen`, () => detectBookTitle(id, b.fileId), { subId: id });
  for (const b of books) runJob('book:' + b.fileId, `${{ nachschlag: 'Nachschlagewerk', faelle: 'Fallsammlung' }[bookRole(b)] || 'Lehrbuch'} „${b.title}“ ${bookRole(b) === 'nachschlag' ? 'einlesen' : 'verarbeiten'}`, st => processBook(id, b.fileId, st), { subId: id });
  for (const u of sub.units) if (!u.analysis && (u.status !== 'fehler' || /fetch|netzwerk|verbindung|zeitüberschreitung|limit|gemini/i.test(u.error || ''))) runJob('unit:' + u.fileId, `Einheit „${u.title}“ analysieren`, st => analyzeUnit(id, u.fileId, st), { subId: id });
  for (const k of sub.altklausuren) if (!k.analysis && k.status !== 'fehler') runJob('alt:' + k.fileId, `Altklausur „${k.title}“ analysieren`, st => analyzeAltklausur(id, k.fileId, st), { subId: id });
  for (const r of sub.rulings) if (r.source === 'upload' && !r.summary && r.status !== 'fehler') runJob('rul:' + r.id, `Urteil „${r.title}“ aufbereiten`, () => summarizeRuling(id, r.id), { subId: id });
}

window.addEventListener('ai-status', e => toast(e.detail, 8000));

async function start() {
  if (location.hostname.endsWith('.netlify.app')) document.body.classList.add('on-netlify');
  await store.load();
  // Client-ID kommt vom Server (Vercel) – auf jedem neuen Gerät automatisch, ohne Eintippen
  try { await serverAuthInfo(); } catch {}
  applyTheme();
  let lastDesign = JSON.stringify(store.state.settings.design || {});
  store.on(st => { const d = JSON.stringify(st.settings.design || {}); if (d !== lastDesign) { lastDesign = d; applyTheme(); } });
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (local.loggedInHint || canStaySignedIn()) {
    if (await signInSilently()) {
      try { await syncOnStart(); softRender(); autoUpdate(); } catch (e) { console.warn(e); }
    }
  }
  // Hintergrund-Aufträge (Lehrbücher) abholen – auch wenn die App zwischendurch zu war
  const poll = () => pollBatches((b, ok, failed) => { toast(`„${b.title}“: ${ok} Kapitel fertig${failed ? `, ${failed} fehlgeschlagen` : ''}`, 6000); softRender(); }).catch(e => console.warn(e));
  setTimeout(poll, 3000);
  setInterval(() => { if (document.visibilityState === 'visible') poll(); }, 3 * 60 * 1000);
  // alle 30 Minuten nach neuen Dateien schauen, solange die App offen ist
  setInterval(() => { if (document.visibilityState === 'visible') autoUpdate(); }, 30 * 60 * 1000);
}

start();
