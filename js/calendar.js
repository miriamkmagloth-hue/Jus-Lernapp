// Lernkalender: österreichische Feiertage, Kindergarten-Schließtage, Kranktage, übersprungene Tage
import { store, uid } from './store.js';

export const REASONS = {
  kindergarten: { label: 'Kindergarten geschlossen', icon: '🏠' },
  'krank-ich': { label: 'Ich bin krank', icon: '🤒' },
  'krank-kind': { label: 'Kind ist krank', icon: '🧸' },
  frei: { label: 'Heute nicht lernen', icon: '🌿' },
  urlaub: { label: 'Urlaub / verreist', icon: '✈️' },
  sonstiges: { label: 'Sonstiges', icon: '📌' }
};

export const iso = d => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const todayIso = () => iso(new Date());

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Gesetzliche Feiertage in Österreich (+ Heiligabend und Silvester, an denen Kindergärten meist zu sind)
const holidayCache = {};
export function holidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  const e = easter(year);
  const list = [
    [`${year}-01-01`, 'Neujahr'], [`${year}-01-06`, 'Heilige Drei Könige'],
    [iso(addDays(e, 1)), 'Ostermontag'], [`${year}-05-01`, 'Staatsfeiertag'],
    [iso(addDays(e, 39)), 'Christi Himmelfahrt'], [iso(addDays(e, 50)), 'Pfingstmontag'],
    [iso(addDays(e, 60)), 'Fronleichnam'], [`${year}-08-15`, 'Mariä Himmelfahrt'],
    [`${year}-10-26`, 'Nationalfeiertag'], [`${year}-11-01`, 'Allerheiligen'],
    [`${year}-12-08`, 'Mariä Empfängnis'], [`${year}-12-24`, 'Heiliger Abend'],
    [`${year}-12-25`, 'Christtag'], [`${year}-12-26`, 'Stefanitag'], [`${year}-12-31`, 'Silvester']
  ];
  holidayCache[year] = new Map(list);
  return holidayCache[year];
}

export function cal() {
  const s = store.state;
  if (!s.calendar) s.calendar = { entries: [], holidaysOff: true };
  return s.calendar;
}

// Grund, warum an einem Tag nicht gelernt wird (oder null)
export function offReason(dateIso) {
  const c = cal();
  if (c.holidaysOff !== false) {
    const h = holidays(Number(dateIso.slice(0, 4))).get(dateIso);
    if (h) return { type: 'feiertag', label: h, icon: '🎉' };
  }
  for (const e of c.entries || []) {
    if (dateIso >= e.from && dateIso <= (e.to || e.from)) return { type: e.reason, label: e.note || REASONS[e.reason]?.label || 'frei', icon: REASONS[e.reason]?.icon || '📌', entry: e };
  }
  return null;
}

export function addEntry({ from, to, reason, note = '' }) {
  if (!from) return;
  if (to && to < from) [from, to] = [to, from];
  store.update(s => {
    if (!s.calendar) s.calendar = { entries: [], holidaysOff: true };
    s.calendar.entries.push({ id: uid('t_'), from, to: to || from, reason, note, at: Date.now() });
    s.calendar.entries.sort((a, b) => a.from.localeCompare(b.from));
  });
}
export function removeEntry(id) {
  store.update(s => { s.calendar.entries = s.calendar.entries.filter(e => e.id !== id); });
}

// Für die Planung: Tage bis zur Prüfung, mit Abzug der freien Tage
export function countStudyDays(from, examDateIso, weekdays) {
  const allowed = new Set((weekdays && weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6]).map(Number));
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const end = new Date(examDateIso + 'T00:00:00');
  let days = 0, studyDays = 0, off = 0;
  const offList = [];
  while (d < end) {
    days++;
    if (allowed.has(d.getDay())) {
      const r = offReason(iso(d));
      if (r) { off++; offList.push({ date: iso(d), ...r }); } else studyDays++;
    }
    d.setDate(d.getDate() + 1);
  }
  return { days, studyDays, off, offList };
}
