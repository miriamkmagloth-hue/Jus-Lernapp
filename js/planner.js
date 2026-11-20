// Lernplan: rechnet mit der Zeit, die tatsächlich bis zur Prüfung bleibt, und priorisiert
import { store, allChapters } from './store.js';
import { countStudyDays, offReason, todayIso } from './calendar.js';

export const PRIO_LABEL = { muss: 'muss sitzen', wichtig: 'wichtig', optional: 'nur wenn Zeit', raus: 'kein Prüfungsstoff' };
const PRIO_BASE = { muss: 3, wichtig: 2, optional: 1, raus: 0 };

export function studyMinutesUntil(exam, fromDate = new Date()) {
  if (!exam.date) return { minutes: Infinity, days: null, studyDays: null, off: 0, offList: [] };
  const r = countStudyDays(fromDate, exam.date, exam.studyDays);
  return { ...r, minutes: r.studyDays * (Number(exam.hoursPerDay) || 0) * 60 };
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

// Ziele: wie gut ein Kapitel sitzen soll (Basis / Vertiefung), je nach Wichtigkeit
export const TARGETS = {
  sehrgut: { label: 'Sehr gut', basis: { muss: 0.9, wichtig: 0.9, optional: 0.75 }, vert: { muss: 0.75, wichtig: 0.6, optional: 0.3 } },
  faelle: { label: 'Fälle sicher lösen', basis: { muss: 0.85, wichtig: 0.8, optional: 0.5 }, vert: { muss: 0.4, wichtig: 0.2, optional: 0 } }
};
const BASIS_SHARE = 0.65; // Anteil des Lernaufwands, der aufs Basiswissen entfällt

function collectionFrequency(sub) {
  const m = {};
  for (const b of sub.books || []) for (const c of b.chapters || []) for (const f of c.cases || []) for (const id of f.kapitelIds || []) m[id] = (m[id] || 0) + 1;
  return m;
}

// Restaufwand bis zum Ziel (Minuten)
function remainingFor(effort, levels, assessed, mastery, tB, tV) {
  let b = levels?.basis, v = levels?.vertiefung;
  if (b == null && assessed) b = mastery;     // alte Ergebnisse ohne Ebenen
  if (v == null && assessed) v = mastery * 0.6;
  b = b ?? 0; v = v ?? 0;
  // „effort“ = Aufwand, um ein Kapitel vollständig zu beherrschen; man lernt bis zum jeweiligen Ziel
  const partB = effort * BASIS_SHARE * Math.max(0, tB - b);
  const partV = effort * (1 - BASIS_SHARE) * Math.max(0, tV - v);
  return partB + partV;
}

// Persönliches Lerntempo in einem Fach: tatsächliche Lernzeit im Verhältnis zur geschätzten Zeit für den erreichten Fortschritt
export function paceFor(sub) {
  const prog = store.state.progress.chapters;
  let act = 0, exp = 0, chs = 0;
  for (const c of allChapters(sub)) {
    const p = prog[c.id];
    if (!p || p.baseline == null) continue;
    const minutes = Math.max(0, (p.minutes || 0) - (p.minAtBaseline || 0));
    const gain = Math.max(0, (p.mastery || 0) - p.baseline);
    if (minutes < 5) continue;
    const base = c.summary?.lernzeitMinuten > 0 ? c.summary.lernzeitMinuten : (c.pages || 10) * 6;
    act += minutes; exp += base * gain; chs++;
  }
  const MIN_ACT = 90;
  if (act < MIN_ACT || exp < 20) return { factor: 1, reliable: false, act, exp, chapters: chs, minNeeded: MIN_ACT };
  const raw = Math.min(2.5, Math.max(0.4, act / exp));
  const weight = Math.min(1, act / 600); // je mehr Lernzeit gemessen, desto stärker zählt das eigene Tempo
  return { factor: 1 + (raw - 1) * weight, raw, reliable: true, act, exp, chapters: chs, weight };
}

export function paceText(pace) {
  if (!pace.reliable) return `Noch zu wenig Daten – ab ca. ${(Math.round(pace.minNeeded / 60 * 10) / 10).toLocaleString('de-AT')} h Lernzeit nach dem Einstufungstest passt die App die Schätzung an dein Tempo an (bisher ${Math.round(pace.act)} Min).`;
  const f = pace.factor;
  const how = f < 0.9 ? `${(1 / f).toLocaleString('de-AT', { maximumFractionDigits: 1 })}× so schnell wie geschätzt` : f > 1.1 ? `du brauchst ca. ${f.toLocaleString('de-AT', { maximumFractionDigits: 1 })}× so lang wie geschätzt` : 'ungefähr so schnell wie geschätzt';
  return `Dein Lerntempo in diesem Fach: ${how} (gemessen an ${(Math.round(pace.act / 60 * 10) / 10).toLocaleString('de-AT')} h Lernzeit in ${pace.chapters} Kapiteln). Die Restzeit ist entsprechend angepasst.`;
}

export function computePlan(sub, exam) {
  const prog = store.state.progress.chapters;
  const pace = paceFor(sub);
  const alt = altFrequency(sub), prof = profFrequency(sub), fs = collectionFrequency(sub);
  const chapters = allChapters(sub, { exam }).map(c => {
    const scope = exam.scopeMap ? (exam.scopeMap[c.id] || 'optional') : 'wichtig';
    const p = prog[c.id] || { mastery: 0, assessed: false };
    const base = c.summary?.lernzeitMinuten > 0 ? c.summary.lernzeitMinuten : (c.pages || 10) * 6;
    const effort = base * (exam.type === 'schriftlich' ? 1.25 : 1) * pace.factor;
    const hasSchema = (c.summary?.schemata || []).length > 0;
    const reasons = [];
    if (exam.scopeMap) reasons.push('Eingrenzung: ' + PRIO_LABEL[scope]);
    if (alt[c.id]) reasons.push(`${alt[c.id]}× in Altklausuren`);
    if (fs[c.id]) reasons.push(`${fs[c.id]} Fälle in Fallsammlungen`);
    if (prof[c.id]) reasons.push('in der LV betont');
    if (hasSchema && exam.type === 'schriftlich') reasons.push('Prüfungsschema');
    const prio = PRIO_BASE[scope] + Math.min(1.5, (alt[c.id] || 0) * 0.5) + Math.min(1, (prof[c.id] || 0) * 0.3)
      + (exam.type === 'schriftlich' ? Math.min(1, (fs[c.id] || 0) * 0.15) + (hasSchema ? 0.3 : 0) : 0);
    const sc = scope === 'raus' ? 'optional' : scope;
    const tg = k => ({ basis: TARGETS[k].basis[sc], vert: TARGETS[k].vert[sc] });
    const remSG = scope === 'raus' ? 0 : remainingFor(effort, p.levels, p.assessed, p.mastery || 0, tg('sehrgut').basis, tg('sehrgut').vert);
    const remF = scope === 'raus' ? 0 : remainingFor(effort, p.levels, p.assessed, p.mastery || 0, tg('faelle').basis, tg('faelle').vert);
    // Prüfungsreife: wie nah am Sehr-gut-Ziel
    const b = p.levels?.basis ?? (p.assessed ? p.mastery : 0), v = p.levels?.vertiefung ?? (p.assessed ? (p.mastery || 0) * 0.6 : 0);
    const T = tg('sehrgut');
    const readiness = (BASIS_SHARE * Math.min(b, T.basis) / T.basis) + ((1 - BASIS_SHARE) * (T.vert ? Math.min(v, T.vert) / T.vert : 1));
    return { id: c.id, title: c.title, bookTitle: c.bookTitle, pages: c.pages, scope, prio, reasons, effort, remaining: remSG, remainingFaelle: remF, target: T, readiness,
      mastery: p.mastery || 0, levels: p.levels || null, assessed: !!p.assessed, lastStudied: p.lastStudied || 0, altCount: alt[c.id] || 0, profCount: prof[c.id] || 0, caseCount: fs[c.id] || 0 };
  });
  const inScope = chapters.filter(c => c.scope !== 'raus');
  const avail = studyMinutesUntil(exam);
  const usable = avail.minutes === Infinity ? Infinity : avail.minutes * 0.9; // 10 % Puffer für die Schlusswiederholung
  const need = inScope.reduce((a, c) => a + c.remaining, 0);
  const needFaelle = inScope.reduce((a, c) => a + c.remainingFaelle, 0);
  const effortTotal = inScope.reduce((a, c) => a + c.effort, 0);
  const readiness = inScope.length ? inScope.reduce((a, c) => a + c.readiness * c.effort, 0) / Math.max(1, effortTotal) : 0;

  // Empfohlene Lernstunden pro Lerntag (mit 10 % Puffer)
  const perDay = m => avail.studyDays ? m / 0.9 / avail.studyDays / 60 : null;
  const hoursSehrGut = perDay(need), hoursFaelle = perDay(needFaelle);

  const sorted = [...inScope].sort((a, b) => b.prio - a.prio || a.readiness - b.readiness);
  let used = 0;
  for (const c of sorted) {
    if (used + c.remaining <= usable) { c.plan = 'voll'; c.planMin = c.remaining; }
    else if (used + c.remainingFaelle <= usable && c.prio >= 1.5) { c.plan = 'kurz'; c.planMin = c.remainingFaelle; }
    else if (c.prio >= 2 && used + c.remainingFaelle * 0.5 <= usable) { c.plan = 'kurz'; c.planMin = c.remainingFaelle * 0.5; }
    else { c.plan = 'wenn-zeit'; c.planMin = 0; }
    used += c.planMin;
  }
  chapters.filter(c => c.scope === 'raus').forEach(c => { c.plan = 'raus'; c.planMin = 0; });

  const ratio = usable === Infinity ? 0 : need / Math.max(1, usable);
  const h = x => x == null ? '–' : (Math.ceil(x * 2) / 2).toLocaleString('de-AT');
  let status, message;
  if (!exam.date) { status = 'offen'; message = 'Kein Prüfungstermin eingetragen – trag einen Termin ein, dann rechne ich mit deiner tatsächlichen Zeit.'; }
  else if (avail.days <= 0) { status = 'vorbei'; message = 'Der Prüfungstermin ist vorbei. Trag ein, wie es gelaufen ist – bei Bedarf rechnet der Plan dann mit dem Ersatztermin weiter.'; }
  else if (!inScope.length) { status = 'offen'; message = 'Noch keine Kapitel – verarbeite zuerst die Lehrbücher.'; }
  else if (need <= usable) { status = 'gut'; message = `Mit ${exam.hoursPerDay} h pro Lerntag reicht es für ein Sehr gut (nötig wären ca. ${h(hoursSehrGut)} h).`; }
  else if (needFaelle <= usable) { status = 'knapp'; message = `Für ein Sehr gut bräuchtest du ca. ${h(hoursSehrGut)} h pro Lerntag (eingeplant: ${exam.hoursPerDay} h). Für „Fälle sicher lösen“ reicht deine Zeit (ca. ${h(hoursFaelle)} h nötig) – darauf ist der Plan ausgerichtet.`; }
  else { status = 'eng'; message = `Für ein Sehr gut bräuchtest du ca. ${h(hoursSehrGut)} h, für „Fälle sicher lösen“ ca. ${h(hoursFaelle)} h pro Lerntag (eingeplant: ${exam.hoursPerDay} h). Ich habe priorisiert: Das Wichtigste ist voll eingeplant, der Rest nur, wenn Zeit bleibt.`; }

  const todayOff = offReason(todayIso());
  return { pace, chapters, inScope, need, needFaelle, hoursSehrGut, hoursFaelle, readiness, available: avail.minutes, usable, days: avail.days, studyDays: avail.studyDays, offDays: avail.off, offList: avail.offList || [], ratio, status, message, todayOff, today: todayOff ? [] : todaySuggestions(sorted, exam) };
}

export function todaySuggestions(sorted, exam) {
  const now = Date.now();
  const cand = sorted.filter(c => c.plan === 'voll' || c.plan === 'kurz')
    .filter(c => now - c.lastStudied > 30 * 3600 * 1000)
    .sort((a, b) => b.prio * (1.05 - b.readiness) - a.prio * (1.05 - a.readiness));
  const budget = (Number(exam.hoursPerDay) || 2) * 60;
  const out = [];
  let used = 0;
  for (const c of cand) {
    let action, min;
    if (!c.assessed) { action = 'Einstufen: kurzer Test, ob du das schon kannst'; min = 10; }
    else if (c.levels && c.levels.basis != null && c.levels.basis < 0.7) { action = 'Basis festigen: Zusammenfassung, Schemata, dann Basis-Test'; min = Math.min(c.remaining, 90); }
    else if (c.levels && c.levels.basis >= 0.75 && (c.levels.vertiefung == null || c.levels.vertiefung < 0.6) && c.mastery < 0.8) { action = 'Basis sitzt – jetzt Vertiefung üben (Spezialfragen)'; min = Math.min(c.remaining, 45); }
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
