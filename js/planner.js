// Lernplan: rechnet mit der Zeit, die tatsächlich bis zur Prüfung bleibt, und priorisiert
import { store, allChapters } from './store.js';

export const PRIO_LABEL = { muss: 'muss sitzen', wichtig: 'wichtig', optional: 'nur wenn Zeit', raus: 'kein Prüfungsstoff' };
const PRIO_BASE = { muss: 3, wichtig: 2, optional: 1, raus: 0 };

export function studyMinutesUntil(exam, fromDate = new Date()) {
  if (!exam.date) return { minutes: Infinity, days: null, studyDays: null };
  const end = new Date(exam.date + 'T00:00:00');
  const d = new Date(fromDate); d.setHours(0, 0, 0, 0);
  let days = 0, studyDays = 0;
  const allowed = new Set((exam.studyDays && exam.studyDays.length ? exam.studyDays : [1, 2, 3, 4, 5, 6, 0]).map(Number));
  while (d < end) {
    days++;
    if (allowed.has(d.getDay())) studyDays++;
    d.setDate(d.getDate() + 1);
  }
  return { minutes: studyDays * (Number(exam.hoursPerDay) || 0) * 60, days, studyDays };
}

function altFrequency(sub) {
  const m = {};
  for (const k of sub.altklausuren || []) for (const f of k.analysis?.faelle || []) for (const id of f.kapitelIds || []) m[id] = (m[id] || 0) + 1;
  return m;
}
function profFrequency(sub) {
  const m = {};
  for (const u of sub.units || []) if (u.analysis?.profBetont?.length) for (const id of u.analysis.kapitelIds || []) m[id] = (m[id] || 0) + 1;
  return m;
}

export function computePlan(sub, exam) {
  const prog = store.state.progress.chapters;
  const alt = altFrequency(sub), prof = profFrequency(sub);
  const chapters = allChapters(sub).map(c => {
    const scope = exam.scopeMap ? (exam.scopeMap[c.id] || 'optional') : 'wichtig';
    const p = prog[c.id] || { mastery: 0, assessed: false };
    const base = c.summary?.lernzeitMinuten > 0 ? c.summary.lernzeitMinuten : (c.pages || 10) * 6;
    const effort = base * (exam.type === 'schriftlich' ? 1.25 : 1);
    const remaining = p.assessed ? effort * Math.max(0.12, 1 - p.mastery) : effort;
    const prio = PRIO_BASE[scope] + Math.min(1.5, (alt[c.id] || 0) * 0.5) + Math.min(1, (prof[c.id] || 0) * 0.3);
    return { id: c.id, title: c.title, bookTitle: c.bookTitle, pages: c.pages, scope, prio, effort, remaining, mastery: p.mastery || 0, assessed: !!p.assessed, lastStudied: p.lastStudied || 0, altCount: alt[c.id] || 0, profCount: prof[c.id] || 0 };
  });
  const inScope = chapters.filter(c => c.scope !== 'raus');
  const avail = studyMinutesUntil(exam);
  // 10 % Puffer für die Schlusswiederholung
  const usable = avail.minutes === Infinity ? Infinity : avail.minutes * 0.9;
  const need = inScope.reduce((a, c) => a + c.remaining, 0);

  const sorted = [...inScope].sort((a, b) => b.prio - a.prio || a.mastery - b.mastery);
  let used = 0;
  for (const c of sorted) {
    if (used + c.remaining <= usable) { c.plan = 'voll'; c.planMin = c.remaining; }
    else if (c.prio >= 2 && used + c.remaining * 0.4 <= usable) { c.plan = 'kurz'; c.planMin = c.remaining * 0.4; }
    else { c.plan = 'wenn-zeit'; c.planMin = 0; }
    used += c.planMin;
  }
  chapters.filter(c => c.scope === 'raus').forEach(c => { c.plan = 'raus'; c.planMin = 0; });

  const ratio = usable === Infinity ? 0 : need / Math.max(1, usable);
  let status, message;
  const cover = inScope.length ? Math.round(100 * inScope.filter(c => c.plan === 'voll').reduce((a, c) => a + c.remaining, 0) / Math.max(1, need)) : 100;
  if (!exam.date) { status = 'offen'; message = 'Kein Prüfungstermin eingetragen – trag einen Termin ein, dann rechne ich mit deiner tatsächlichen Zeit.'; }
  else if (avail.days <= 0) { status = 'vorbei'; message = 'Der Prüfungstermin ist vorbei. Trag ein, wie es gelaufen ist – bei Bedarf rechnet der Plan dann mit dem Ersatztermin weiter.'; }
  else if (!inScope.length) { status = 'offen'; message = 'Noch keine Kapitel – verarbeite zuerst die Lehrbücher.'; }
  else if (ratio <= 0.85) { status = 'gut'; message = `Die Zeit reicht gut für den gesamten Stoff. Es bleibt Luft für Falltraining und Wiederholung.`; }
  else if (ratio <= 1.05) { status = 'knapp'; message = `Die Zeit reicht, ist aber knapp. Bleib bei den „muss sitzen“-Kapiteln dran.`; }
  else { status = 'eng'; message = `Für alles im Detail reicht die Zeit nicht (ca. ${cover} % voll). Ich habe priorisiert: Was „muss sitzen“ ist voll eingeplant, wichtige Kapitel als Überblick, der Rest nur wenn Zeit bleibt.`; }

  return { chapters, inScope, need, available: avail.minutes, usable, days: avail.days, studyDays: avail.studyDays, ratio, status, message, today: todaySuggestions(sorted, exam) };
}

export function todaySuggestions(sorted, exam) {
  const now = Date.now();
  const cand = sorted.filter(c => c.plan === 'voll' || c.plan === 'kurz')
    .filter(c => now - c.lastStudied > 30 * 3600 * 1000)
    .sort((a, b) => b.prio * (1.05 - b.mastery) - a.prio * (1.05 - a.mastery));
  const budget = (Number(exam.hoursPerDay) || 2) * 60;
  const out = [];
  let used = 0;
  for (const c of cand) {
    let action, min;
    if (!c.assessed) { action = 'Einstufen: kurzer Test, ob du das schon kannst'; min = 10; }
    else if (c.mastery < 0.45) { action = 'Zusammenfassung durcharbeiten, dann Test'; min = Math.min(c.remaining, 90); }
    else if (c.mastery < 0.75) { action = exam.type === 'schriftlich' ? 'Fall üben oder Test' : 'Abfrage im Chat oder Test'; min = Math.min(c.remaining, 60); }
    else { action = 'Kurz wiederholen (Karteikarten)'; min = 20; }
    if (used + min > budget * 1.1 && out.length) break;
    out.push({ ...c, action, min });
    used += min;
    if (out.length >= 4) break;
  }
  return out;
}

export function subjectMastery(sub) {
  const prog = store.state.progress.chapters;
  const chs = allChapters(sub);
  if (!chs.length) return { avg: 0, assessed: 0, total: 0 };
  const assessed = chs.filter(c => prog[c.id]?.assessed);
  const avg = chs.reduce((a, c) => a + (prog[c.id]?.mastery || 0), 0) / chs.length;
  return { avg, assessed: assessed.length, total: chs.length };
}

export function activeExams(sub) {
  return (sub.exams || []).filter(e => e.status === 'aktiv').sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}
