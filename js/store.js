// Datenhaltung: lokaler Speicher (IndexedDB) + Zustandsobjekt, das mit Google Drive synchronisiert wird
const DB_NAME = 'jus-lernapp';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    const req = fn(st);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const kvGet = key => idb('kv', 'readonly', s => s.get(key));
export const kvSet = (key, val) => idb('kv', 'readwrite', s => s.put(val, key));
export const textGet = key => idb('texts', 'readonly', s => s.get(key));
export const textSet = (key, val) => idb('texts', 'readwrite', s => s.put(val, key));
export const textDel = key => idb('texts', 'readwrite', s => s.delete(key));

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyState() {
  return {
    version: 1,
    updatedAt: 0,
    settings: {
      provider: 'anthropic',
      keys: { anthropic: '', gemini: '', openai: '' },
      models: {
        anthropic: { smart: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' },
        gemini: { smart: 'gemini-2.5-pro', fast: 'gemini-2.5-flash' },
        openai: { smart: 'gpt-5', fast: 'gpt-5-mini' }
      },
      risProxy: '',
      speakQuestions: false
    },
    subjects: [],
    progress: { chapters: {}, sessions: [], mistakes: [], cases: [], orals: [], quizzes: [] },
    cards: {},
    srs: {},
    calendar: { entries: [], holidaysOff: true },
    usage: { days: {} }
  };
}

// Lokale Einstellungen, die NICHT synchronisiert werden (werden vor dem Login gebraucht)
export const local = {
  get googleClientId() { return localStorage.getItem('googleClientId') || ''; },
  set googleClientId(v) { localStorage.setItem('googleClientId', v || ''); },
  get loggedInHint() { return localStorage.getItem('loggedInHint') === '1'; },
  set loggedInHint(v) { localStorage.setItem('loggedInHint', v ? '1' : '0'); }
};

export const store = {
  state: emptyState(),
  listeners: new Set(),
  saveTimer: null,
  remoteSaver: null, // wird von drive.js gesetzt

  async load() {
    try {
      const s = await kvGet('state');
      if (s) this.state = migrate(s);
    } catch (e) { console.warn('Lokaler Speicher nicht lesbar', e); }
    return this.state;
  },

  replace(newState) {
    this.state = migrate(newState);
    kvSet('state', this.state).catch(console.warn);
    this.emit();
  },

  // Änderung durchführen und speichern (lokal sofort, Drive verzögert)
  update(fn, { silent = false } = {}) {
    fn(this.state);
    this.state.updatedAt = Date.now();
    kvSet('state', this.state).catch(console.warn);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.remoteSaver && this.remoteSaver(), 2500);
    if (!silent) this.emit();
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { this.listeners.forEach(fn => { try { fn(this.state); } catch (e) { console.error(e); } }); },

  subject(id) { return this.state.subjects.find(s => s.id === id); },
  chapterProgress(chId) {
    const p = this.state.progress.chapters;
    if (!p[chId]) p[chId] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 };
    return p[chId];
  }
};

function migrate(s) {
  const base = emptyState();
  const out = { ...base, ...s };
  out.settings = { ...base.settings, ...(s.settings || {}) };
  out.settings.keys = { ...base.settings.keys, ...((s.settings || {}).keys || {}) };
  out.settings.models = { ...base.settings.models, ...((s.settings || {}).models || {}) };
  out.progress = { ...base.progress, ...(s.progress || {}) };
  out.cards = s.cards || {};
  out.srs = s.srs || {};
  out.calendar = { entries: [], holidaysOff: true, ...(s.calendar || {}) };
  out.usage = s.usage || { days: {} };
  out.subjects = (s.subjects || []).map(normalizeSubject);
  return out;
}

export function normalizeSubject(sub) {
  return {
    id: sub.id || uid('f_'),
    name: sub.name || 'Fach',
    createdAt: sub.createdAt || Date.now(),
    folders: { books: [], transcripts: [], exams: [], rulings: [], scope: [], protocols: [], ...(sub.folders || {}) },
    exams: (sub.exams || []).map(syncExam),
    files: sub.files || {},
    books: sub.books || [],
    units: sub.units || [],
    altklausuren: sub.altklausuren || [],
    altOverview: sub.altOverview || null,
    rulings: sub.rulings || [],
    rulingMeta: sub.rulingMeta || { lastCheck: null, norms: [] },
    lastScan: sub.lastScan || null
  };
}

// Termine einer Prüfung: Haupttermin + Ersatztermine. exam.date ist immer der aktuell relevante Termin.
export function syncExam(e) {
  if (!Array.isArray(e.attempts) || !e.attempts.length) {
    e.attempts = [{ date: e.date || '', result: e.status === 'bestanden' ? 'bestanden' : e.status === 'nicht_bestanden' ? 'nicht_bestanden' : 'offen' }];
  }
  e.attempts = e.attempts.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const open = e.attempts.find(a => a.result === 'offen');
  e.date = (open || e.attempts[e.attempts.length - 1]).date || '';
  if (e.attempts.some(a => a.result === 'bestanden')) e.status = 'bestanden';
  else if (!open) e.status = 'nicht_bestanden';
  else if (e.status === 'bestanden' || e.status === 'nicht_bestanden') e.status = 'aktiv';
  return e;
}
export function currentAttempt(e) {
  return (e.attempts || []).find(a => a.result === 'offen') || null;
}

export function newExam(partial = {}) {
  return syncExam({
    id: uid('p_'),
    name: partial.name || 'Prüfung',
    type: partial.type || 'schriftlich',
    date: partial.date || '',
    hoursPerDay: partial.hoursPerDay ?? 3,
    studyDays: partial.studyDays || [1, 2, 3, 4, 5, 6],
    status: partial.status || 'aktiv', // aktiv | bestanden | nicht_bestanden | archiviert
    scopeText: partial.scopeText || '',
    scopeFileIds: partial.scopeFileIds || [],
    scopeMap: partial.scopeMap || null, // { chapterId: 'muss'|'wichtig'|'optional'|'raus' }
    bookIds: partial.bookIds || null, // null = alle Lernstoff-Bücher
    assessment: partial.assessment || null,
    notes: partial.notes || '',
    attempts: partial.attempts || null
  });
}

// Verzeichnisse, Vorwort usw. sind kein Lernstoff
const NO_STUDY = /^(?:[\W\d]|[IVX]+\.\s)*(?:(?:inhaltsverzeichnis|inhaltsübersicht|vorwort|vorworte|geleitwort|abkürzungen|abkürzungsverzeichnis|literatur|literaturverzeichnis|literaturhinweise|schrifttum|schrifttumsverzeichnis|stichwortverzeichnis|sachregister|sachverzeichnis|register|benutzungshinweise|hinweise zur benutzung|impressum|titelei)(?![a-zäöüß])|(?:inhalt|übersicht|gliederung)\s*$)/i;
export function isStudyChapter(c) {
  if (c.hidden === true) return false;
  if (c.hidden === false) return true; // ausdrücklich eingeblendet
  if (c.summary && c.summary.pruefungsrelevant === false) return false;
  return !NO_STUDY.test(c.title || '');
}

// Rolle eines Buchs: 'stoff' (Lernstoff), 'nachschlag' (nur nachschlagen, z. B. Gesetzestext), 'aus' (nicht verwenden)
const LOOKUP_TITLE = /gesetz(es)?text|kodex|textausgabe|gesetzessammlung|^[a-zäöüß-]*(gesetz|gesetzbuch|ordnung)(\s+\d{4})?$|^(abgb|kschg|mrg|ugb|ehg|eheg|weg|vgg|ecg|fagg|iprg|ausserstrg|zpo|eo|io|stgb|stpo|b-vg|avg)(\s+\d{4})?$/i;
const CASES_TITLE = /fall+(ö|oe)sung|fallsammlung|fallbuch|fälle|faelle|casebook|übungsbuch|uebungsbuch|klausurenkurs/i;
export function bookRole(b) {
  if (b.roleManual && b.role) return b.role;
  if (b.dupOf) return 'aus'; // ältere Auflage eines anderen Buchs
  if (LOOKUP_TITLE.test((b.title || '').trim()) || LOOKUP_TITLE.test((b.fileTitle || '').trim())) return 'nachschlag';
  if (b.role) return b.role;
  if (CASES_TITLE.test(b.title || '')) return 'faelle';
  return 'stoff';
}
// Alle Fälle aus Fallsammlungen eines Fachs: [{ book, chapter, idx, fall }]
export function collectionCases(sub) {
  const out = [];
  for (const b of sub.books || []) if (bookRole(b) === 'faelle') for (const c of b.chapters || []) (c.cases || []).forEach((f, idx) => out.push({ book: b, chapter: c, idx, fall: f }));
  return out;
}
// Gehört ein Buch zu einer Prüfung? (exam.bookIds = null heißt: alle Lernstoff-Bücher)
export function bookInExam(b, exam) {
  if (bookRole(b) !== 'stoff') return false;
  return !exam || !Array.isArray(exam.bookIds) || exam.bookIds.includes(b.fileId);
}

// Alle Kapitel eines Fachs – standardmäßig nur echter Lernstoff aus Lernstoff-Büchern (optional: nur einer Prüfung)
export function allChapters(sub, { includeHidden = false, exam = null } = {}) {
  const out = [];
  for (const b of sub.books || []) {
    if (!includeHidden && !bookInExam(b, exam)) continue;
    for (const c of b.chapters || []) if (includeHidden || isStudyChapter(c)) out.push({ ...c, bookId: b.fileId, bookTitle: b.title });
  }
  return out;
}
export function findChapter(sub, chId) {
  for (const b of sub.books || []) for (const c of b.chapters || []) if (c.id === chId) return { book: b, chapter: c };
  return null;
}
