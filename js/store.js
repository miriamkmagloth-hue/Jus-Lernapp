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
    srs: {}
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
  out.subjects = (s.subjects || []).map(normalizeSubject);
  return out;
}

export function normalizeSubject(sub) {
  return {
    id: sub.id || uid('f_'),
    name: sub.name || 'Fach',
    createdAt: sub.createdAt || Date.now(),
    folders: { books: [], transcripts: [], exams: [], rulings: [], scope: [], protocols: [], ...(sub.folders || {}) },
    exams: sub.exams || [],
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

export function newExam(partial = {}) {
  return {
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
    assessment: partial.assessment || null,
    notes: partial.notes || ''
  };
}

// Alle Kapitel eines Fachs (über alle Lehrbücher)
export function allChapters(sub) {
  const out = [];
  for (const b of sub.books || []) for (const c of b.chapters || []) out.push({ ...c, bookId: b.fileId, bookTitle: b.title });
  return out;
}
export function findChapter(sub, chId) {
  for (const b of sub.books || []) for (const c of b.chapters || []) if (c.id === chId) return { book: b, chapter: c };
  return null;
}
