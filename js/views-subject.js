// Ansichten innerhalb eines Fachs
import { store, allChapters, findChapter, textGet, syncExam, currentAttempt, isStudyChapter } from './store.js';
import { esc, md, enrich, toast, busy, errorBox, fmtDate, daysUntil, fmtMin, ampel, confirmDialog, openModal, closeModal } from './ui.js';
import { setTitle, render, autoUpdate, queueProcessing } from './app.js';
import { computePlan, activeExams, subjectMastery, PRIO_LABEL } from './planner.js';
import { runJob, activeJobs, jobs } from './jobs.js';
import { processBook, analyzeUnit, analyzeAltklausur, altklausurOverview, summarizeChapter, chapterText, checkNewRulings, addCitedRuling, loadRulingTexts, summarizeRuling, mapScope, markStudied, getFileText, CATEGORIES } from './processing.js';
import { mountChat } from './chat.js';
import { mountQuiz, mountFreeQuestion, mountChapterCards } from './views-learn.js';
import { isSignedIn } from './drive.js';

const TABS = [['plan', 'Übersicht'], ['stoff', 'Lehrbuch'], ['einheiten', 'Einheiten'], ['falltraining', 'Falltraining'], ['altklausuren', 'Altklausuren'], ['ogh', 'OGH-Urteile'], ['muendlich', 'Mündlich'], ['dateien', 'Dateien']];

export function renderJobBar(bar) {
  const subId = bar.dataset.jobs;
  const list = activeJobs(subId);
  bar.innerHTML = list.length ? `<div class="notice small">${list.map(([, j]) => `<div>${j.done ? (j.error ? '⚠' : '✓') : '<span class="spinner"></span>'} <strong>${esc(j.label)}</strong> – ${esc(j.status)}</div>`).join('')}</div>` : '';
}

function header(sub, active) {
  return `<div data-jobs="${sub.id}"></div>
  <div class="tabs">${TABS.map(([k, l]) => `<a class="tab ${k === active ? 'active' : ''}" href="#/fach/${sub.id}/${k}">${l}${badge(sub, k)}</a>`).join('')}</div>`;
}
function badge(sub, tab) {
  let n = 0;
  if (tab === 'einheiten') n = sub.units.filter(u => sub.files[u.fileId]?.isNew).length;
  if (tab === 'ogh') n = sub.rulings.filter(r => r.isNew).length;
  return n ? ` <span class="pill gold">${n}</span>` : '';
}
function mountJobBar(el) { const b = el.querySelector('[data-jobs]'); if (b) renderJobBar(b); }
const notFound = el => { el.innerHTML = '<div class="card">Nicht gefunden. <a href="#/faecher">Zu den Fächern</a></div>'; };

export function subjectView(el, subId, tab = 'plan') {
  const sub = store.subject(subId);
  if (!sub) return notFound(el);
  setTitle(sub.name);
  el.innerHTML = header(sub, tab) + '<div id="tabBody"></div>';
  mountJobBar(el);
  const body = el.querySelector('#tabBody');
  ({ plan: tabPlan, stoff: tabStoff, einheiten: tabUnits, falltraining: tabCases, altklausuren: tabAlt, ogh: tabOgh, muendlich: tabOral, dateien: tabFiles }[tab] || tabPlan)(body, sub);
}

// ---------- Übersicht ----------
function tabPlan(el, sub) {
  const exams = sub.exams;
  let html = '';
  if (!sub.books.length) html += `<div class="notice warn">Noch keine Lehrbücher gefunden. ${isSignedIn() ? `Prüf unter <a href="#/fach/${sub.id}/dateien">Dateien</a>, ob der Lehrbuch-Ordner gewählt ist.` : 'Bitte mit Google verbinden.'}</div>`;
  else if (sub.books.some(b => b.status !== 'fertig')) html += `<div class="notice">Lehrbücher werden noch verarbeitet – Zusammenfassungen und Plan werden laufend vollständiger.</div>`;
  const m = subjectMastery(sub);
  html += `<div class="grid3"><div class="stat"><div class="num">${Math.round(m.avg * 100)} %</div><div class="lbl">beherrscht</div></div><div class="stat"><div class="num">${m.assessed}/${m.total}</div><div class="lbl">Kapitel eingestuft</div></div><div class="stat"><div class="num">${sub.units.length}</div><div class="lbl">Einheiten</div></div></div><div style="height:14px"></div>`;
  for (const e of exams) {
    const plan = computePlan(sub, e);
    const d = daysUntil(e.date);
    const cls = { gut: 'green', knapp: 'yellow', eng: 'red' }[plan.status] || 'blue';
    html += `<div class="card"><div class="row between"><div><div class="item-title">${esc(e.name)}</div><div class="small muted">${e.type === 'muendlich' ? 'mündlich' : 'schriftlich'}${e.date ? ' · ' + fmtDate(e.date) + (d != null && d >= 0 ? ` · noch ${d} Tage` : '') : ' · kein Termin'}</div></div>
      ${e.status === 'aktiv' ? `<span class="pill ${cls}">${{ gut: 'Zeit reicht', knapp: 'knapp', eng: 'priorisiert', offen: 'offen', vorbei: 'vorbei' }[plan.status]}</span>` : `<span class="pill ${e.status === 'bestanden' ? 'green' : ''}">${{ bestanden: 'bestanden ✓', nicht_bestanden: 'nicht bestanden', archiviert: 'pausiert' }[e.status]}</span>`}</div>
      ${(e.attempts || []).length > 1 ? `<div class="tiny muted" style="margin-top:4px">${e.attempts.map((a, j) => `${j === 0 ? 'Haupttermin' : j + '. Ersatztermin'}: ${a.date ? fmtDate(a.date) : 'offen'}${a.result === 'bestanden' ? ' ✓' : a.result === 'nicht_bestanden' ? ' ✗' : ''}`).join(' · ')}</div>` : ''}
      ${e.status === 'aktiv' && plan.status === 'vorbei' && currentAttempt(e) ? `<div class="notice gold"><strong>Wie ist die Prüfung am ${fmtDate(e.date)} gelaufen?</strong><div class="row" style="margin-top:8px"><button class="btn small" data-res="bestanden" data-ex="${e.id}">Bestanden 🎉</button><button class="btn secondary small" data-res="nicht_bestanden" data-ex="${e.id}">Nicht bestanden</button></div></div>` : ''}
      ${e.status === 'nicht_bestanden' || (e.status === 'aktiv' && currentAttempt(e) && !e.date) ? `<div class="notice"><div class="small"><strong>${e.status === 'nicht_bestanden' ? 'Ersatztermin eintragen' : 'Ersatztermin noch offen'}</strong> – sobald du ihn weißt, hier eintragen. Dein Lernstand bleibt erhalten.</div>
        <div class="row" style="margin-top:8px"><input type="date" data-newdate="${e.id}" style="flex:1;min-width:150px"><button class="btn small" data-savedate="${e.id}">Speichern</button></div>
        ${e.status === 'nicht_bestanden' ? `<button class="btn ghost small" data-unknown="${e.id}" style="margin-top:4px">Termin noch nicht bekannt</button>` : ''}</div>` : ''}
      ${e.status === 'aktiv' ? `<p class="small">${esc(plan.message)}</p>
      ${e.assessment ? '' : `<div class="notice small">Tipp: Mach zuerst den <strong>Einstufungstest</strong>. Dann weiß die App, was du schon kannst, und plant realistisch.</div>`}
      ${plan.todayOff ? `<div class="notice ok small">${plan.todayOff.icon} Heute ist lernfrei (${esc(plan.todayOff.label)}).</div>` : ''}
      ${plan.today.length ? `<h4>Heute sinnvoll</h4><ul class="list">${plan.today.map(t => `<li><a class="item" href="#/fach/${sub.id}/kapitel/${t.id}"><span class="dot ${ampel(t.mastery, t.assessed)}"></span><div><div>${esc(t.title)}</div><div class="small muted">${esc(t.action)} · ca. ${fmtMin(t.min)}</div></div><span class="chev">›</span></a></li>`).join('')}</ul>` : ''}
      <div class="row" style="margin-top:10px"><a class="btn small" href="#/fach/${sub.id}/pruefung/${e.id}">Lernplan & Stoff</a><a class="btn secondary small" href="#/fach/${sub.id}/einstufung/${e.id}">${e.assessment ? 'Einstufung wiederholen' : 'Einstufungstest'}</a>
      ${e.type === 'muendlich' ? `<a class="btn secondary small" href="#/fach/${sub.id}/simulation/${e.id}">Prüfung simulieren</a>` : `<a class="btn secondary small" href="#/fach/${sub.id}/fall">Fall üben</a>`}</div>` : ''}
    </div>`;
  }
  if (!exams.length) html += `<div class="card muted">Keine Prüfungen eingetragen. <a href="#/fach/${sub.id}/bearbeiten">Prüfungen anlegen</a></div>`;
  html += `<div class="row"><a class="btn secondary small" href="#/fach/${sub.id}/bearbeiten">Fach, Prüfungen & Ordner bearbeiten</a></div>`;
  el.innerHTML = html;
  const setRetake = (examId, date) => store.update(s => {
    const ex = s.subjects.find(x => x.id === sub.id).exams.find(x => x.id === examId);
    const open = currentAttempt(ex);
    if (open && !open.date) open.date = date; else ex.attempts.push({ date, result: 'offen' });
    if (ex.status === 'nicht_bestanden') ex.status = 'aktiv';
    syncExam(ex);
  });
  el.querySelectorAll('[data-savedate]').forEach(b => b.onclick = () => {
    const v = el.querySelector(`[data-newdate="${b.dataset.savedate}"]`).value;
    if (!v) { toast('Bitte ein Datum wählen'); return; }
    setRetake(b.dataset.savedate, v); toast('Ersatztermin gespeichert – der Plan rechnet jetzt damit.'); render();
  });
  el.querySelectorAll('[data-unknown]').forEach(b => b.onclick = () => { setRetake(b.dataset.unknown, ''); toast('Vorgemerkt. Trag den Termin ein, sobald du ihn weißt.'); render(); });
  el.querySelectorAll('[data-res]').forEach(b => b.onclick = () => {
    store.update(s => {
      const ex = s.subjects.find(x => x.id === sub.id).exams.find(x => x.id === b.dataset.ex);
      const att = currentAttempt(ex); if (att) att.result = b.dataset.res;
      syncExam(ex);
    });
    if (b.dataset.res === 'bestanden') toast('Gratuliere! 🎉');
    else if (!currentAttempt(store.subject(sub.id).exams.find(x => x.id === b.dataset.ex))) { render(); return; }
    else toast(currentAttempt(store.subject(sub.id).exams.find(x => x.id === b.dataset.ex)) ? 'Der Plan rechnet jetzt mit dem Ersatztermin. Dein Lernstand bleibt erhalten.' : 'Trag einen Ersatztermin ein, dann plant die App weiter.', 5000);
    render();
  });
}

// ---------- Lehrbuch / Stoffgebiete ----------
function tabStoff(el, sub) {
  const prog = store.state.progress.chapters;
  if (!sub.books.length) { el.innerHTML = `<div class="card empty">Noch keine Lehrbücher. Wähle den Lehrbuch-Ordner unter <a href="#/fach/${sub.id}/bearbeiten">Fach bearbeiten</a>.</div>`; return; }
  const exam = activeExams(sub)[0];
  el.innerHTML = sub.books.map(b => {
    const job = jobs.get('book:' + b.fileId);
    const done = b.chapters.filter(c => c.summary).length;
    return `<div class="card"><div class="row between"><div><div class="item-title">📘 ${esc(b.title)}</div><div class="small muted">${b.numPages ? b.numPages + ' Seiten · ' : ''}${b.chapters.length} Kapitel · ${done} zusammengefasst</div></div>
      ${b.status === 'fertig' ? '' : job && !job.done ? '<span class="spinner"></span>' : `<button class="btn small" data-proc="${b.fileId}">${b.status === 'fehler' ? 'Erneut versuchen' : 'Verarbeiten'}</button>`}</div>
      ${b.error ? `<div class="notice err small">${esc(b.error)}</div>` : ''}
      <ul class="list">${b.chapters.map(c => {
        const p = prog[c.id];
        const scope = exam?.scopeMap?.[c.id];
        if (!isStudyChapter(c)) return `<li><a class="item" href="#/fach/${sub.id}/kapitel/${c.id}" style="opacity:.55"><span class="dot"></span><div style="flex:1"><div>${esc(c.title)}</div><div class="tiny muted">kein Lernstoff – ausgeblendet</div></div><span class="chev">›</span></a></li>`;
        return `<li><a class="item" href="#/fach/${sub.id}/kapitel/${c.id}"><span class="dot ${ampel(p?.mastery || 0, p?.assessed)}"></span>
          <div style="flex:1"><div>${esc(c.title)}</div><div class="tiny muted">S. ${esc(c.startLabel || c.startPage)}–${esc(c.endLabel || c.endPage)}${p?.assessed ? ` · ${Math.round(p.mastery * 100)} %` : ''}${scope ? ` · ${PRIO_LABEL[scope]}` : ''}${c.summary ? '' : ' · noch nicht zusammengefasst'}</div></div><span class="chev">›</span></a></li>`;
      }).join('')}</ul></div>`;
  }).join('') + `<p class="tiny muted">Ampel: grün = sitzt, gelb = teilweise, rot = Lücken, grau = noch nicht eingestuft.</p>`;
  el.querySelectorAll('[data-proc]').forEach(btn => btn.onclick = () => {
    const fid = btn.dataset.proc;
    const b = sub.books.find(x => x.fileId === fid);
    runJob('book:' + fid, `Lehrbuch „${b.title}“ verarbeiten`, st => processBook(sub.id, fid, st), { subId: sub.id });
    render();
  });
}

export function chapterView(el, subId, chId, part = 'zusammenfassung') {
  const sub = store.subject(subId);
  const f = sub && findChapter(sub, chId);
  if (!f) return notFound(el);
  const { book, chapter: ch } = f;
  setTitle(ch.title);
  markStudied(chId);
  const p = store.state.progress.chapters[chId];
  const parts = [['zusammenfassung', 'Zusammenfassung'], ['test', 'Multiple Choice'], ['fragen', 'Freie Fragen'], ['karten', 'Karteikarten'], ['chat', 'Chat'], ['text', 'Lehrbuchtext']];
  el.innerHTML = `<div class="small muted">${esc(sub.name)} · ${esc(book.title)} · S. ${esc(ch.startLabel || ch.startPage)}–${esc(ch.endLabel || ch.endPage)}</div>
    <div class="row" style="margin:6px 0 10px"><span class="dot ${ampel(p?.mastery || 0, p?.assessed)}"></span><span class="small">${p?.assessed ? `Kenntnisstand ${Math.round(p.mastery * 100)} %` : 'noch nicht eingestuft'}</span></div>
    ${isStudyChapter(ch) ? '' : `<div class="notice warn small">Dieses Kapitel zählt nicht als Lernstoff (z. B. Verzeichnis oder Übersicht) und kommt in Plan, Einstufung und Tests nicht vor. <button class="btn ghost small" data-vis="show">Doch als Lernstoff zählen</button></div>`}
    <div class="tabs">${parts.map(([k, l]) => `<a class="tab ${k === part ? 'active' : ''}" href="#/fach/${subId}/kapitel/${chId}/${k}">${l}</a>`).join('')}</div><div id="part"></div>
    ${isStudyChapter(ch) ? `<div style="margin-top:16px"><button class="btn ghost small" data-vis="hide">Kein Lernstoff – Kapitel ausblenden</button></div>` : ''}`;
  el.querySelectorAll('[data-vis]').forEach(b => b.onclick = () => {
    store.update(s => { findChapter(s.subjects.find(x => x.id === subId), chId).chapter.hidden = b.dataset.vis === 'hide'; });
    toast(b.dataset.vis === 'hide' ? 'Ausgeblendet – zählt nicht mehr als Lernstoff' : 'Zählt wieder als Lernstoff');
    render();
  });
  const body = el.querySelector('#part');

  if (part === 'zusammenfassung') {
    const s = ch.summary;
    if (!s) {
      const job = jobs.get('book:' + book.fileId);
      body.innerHTML = job && !job.done ? busy('Das Lehrbuch wird gerade verarbeitet …') : `<div class="card">Noch keine Zusammenfassung. <button class="btn small" data-a="sum">Jetzt erstellen</button></div>`;
    } else {
      body.innerHTML = `<div class="card"><h3>Worum geht es?</h3>${md(s.kurzfassung)}</div>
      ${(s.themen || []).map(t => `<details class="card" open><summary>${esc(t.titel)} <span class="cite">${esc(t.seiten || '')}</span></summary>${md(t.inhalt)}</details>`).join('')}
      ${s.definitionen?.length ? `<div class="card"><h3>Definitionen</h3><ul class="list">${s.definitionen.map(d => `<li><strong>${esc(d.begriff)}</strong> ${d.seite ? `<span class="cite">[S. ${esc(String(d.seite).replace(/^S\.?\s*/, ''))}]</span>` : ''}<div class="small">${enrich(esc(d.definition))}</div></li>`).join('')}</ul></div>` : ''}
      ${s.schemata?.length ? `<div class="card"><h3>Prüfungsschemata</h3>${s.schemata.map(sc => `<h4>${esc(sc.titel)}</h4><ol>${(sc.schritte || []).map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ol>`).join('')}</div>` : ''}
      ${s.stolperfallen?.length ? `<div class="card" style="border-color:var(--hl)"><h3>⚠ Stolperfallen</h3><ul>${s.stolperfallen.map(x => `<li>${enrich(esc(x.text || x))} ${x.seite ? `<span class="cite">[S. ${esc(String(x.seite).replace(/^S\.?\s*/, ''))}]</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${s.normen?.length ? `<div class="card"><h3>Normen</h3>${s.normen.map(n => `<span class="pill blue" style="margin:2px">${enrich(esc(n))}</span>`).join(' ')}</div>` : ''}
      ${s.entscheidungen?.length ? `<div class="card"><h3>Im Kapitel zitierte Entscheidungen</h3><div class="row">${s.entscheidungen.map(g => `<button class="btn secondary small" data-gz="${esc(g)}">${esc(g)}</button>`).join('')}</div><p class="tiny muted">Antippen: Entscheidung im RIS öffnen und aufbereiten lassen.</p></div>` : ''}
      <div class="row"><a class="btn" href="#/fach/${subId}/kapitel/${chId}/test">Wissen testen</a><button class="btn ghost small" data-a="sum">Neu zusammenfassen</button></div>`;
    }
    body.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'sum') {
        body.innerHTML = busy('Erstelle Zusammenfassung … (kann 1–2 Minuten dauern)');
        try { await summarizeChapter(subId, book.fileId, chId); render(); } catch (err) { body.innerHTML = errorBox(err); }
      }
      const gz = e.target.closest('[data-gz]')?.dataset.gz;
      if (gz) {
        const clean = gz.replace(/^OGH\s*/i, '').trim();
        toast('Suche im RIS …');
        try { const r = await addCitedRuling(subId, clean); location.hash = `#/fach/${subId}/urteil/${encodeURIComponent(r.id)}`; } catch (err) { toast(err.message, 6000); }
      }
    };
  }
  if (part === 'test') mountQuiz(body, sub, [chId], { title: ch.title });
  if (part === 'fragen') mountFreeQuestion(body, sub, ch);
  if (part === 'karten') mountChapterCards(body, sub, ch);
  if (part === 'chat') {
    store.update(s => { const c = findChapter(s.subjects.find(x => x.id === subId), chId).chapter; c.chat = c.chat || []; }, { silent: true });
    const chRef = findChapter(store.subject(subId), chId).chapter;
    body.innerHTML = '<div id="chat"></div>';
    mountChat(body.querySelector('#chat'), {
      history: chRef.chat,
      onSave: () => store.update(() => {}, { silent: true }),
      system: async () => `Du besprichst mit der Studentin das Lehrbuchkapitel „${ch.title}“ aus „${book.title}“. Beantworte Fragen ausschließlich auf Grundlage dieses Kapiteltexts mit Seitenangaben. Wenn sie dich bittet, sie abzufragen, stelle eine Frage nach der anderen, warte auf ihre Antwort und gib dann Feedback.\n\nKAPITELTEXT:\n${await chapterText(store.subject(subId), chId)}`,
      placeholder: 'Frage zum Kapitel …',
      emptyText: 'Frag mich alles zu diesem Kapitel – oder lass dich abfragen.',
      quickPrompts: [
        { label: 'Frag mich ab', prompt: 'Frag mich zu diesem Kapitel ab: eine Frage nach der anderen, wie in einer Prüfung. Warte jeweils auf meine Antwort.' },
        { label: 'Einfach erklären', prompt: 'Erklär mir die Kernpunkte dieses Kapitels so einfach wie möglich, mit einem Beispiel.' },
        { label: 'Abgrenzungen', prompt: 'Welche Abgrenzungen und Stolperfallen muss ich in diesem Kapitel unbedingt kennen?' }
      ]
    });
  }
  if (part === 'text') {
    body.innerHTML = busy('Lade Lehrbuchtext …');
    chapterText(sub, chId).then(t => { body.innerHTML = `<div class="card sachverhalt" style="font-size:.95rem">${enrich(esc(t))}</div>`; }).catch(e => body.innerHTML = errorBox(e));
  }
}

// ---------- Einheiten ----------
function tabUnits(el, sub) {
  if (!sub.units.length) { el.innerHTML = `<div class="card empty">Noch keine Transkripte. Wähle den Transkript-Ordner unter <a href="#/fach/${sub.id}/bearbeiten">Fach bearbeiten</a>.</div>`; return; }
  const units = [...sub.units].sort((a, b) => a.title.localeCompare(b.title, 'de', { numeric: true }));
  el.innerHTML = `<div class="card"><ul class="list">${units.map(u => {
    const isNew = sub.files[u.fileId]?.isNew;
    const job = jobs.get('unit:' + u.fileId);
    return `<li><a class="item" href="#/fach/${sub.id}/einheit/${u.fileId}"><div style="flex:1"><div class="item-title">${esc(u.title)} ${isNew ? '<span class="pill gold">neu</span>' : ''}</div>
      <div class="small muted">${u.analysis ? esc(u.analysis.thema || '') : job && !job.done ? 'wird analysiert …' : u.status === 'fehler' ? '⚠ ' + esc(u.error || 'Fehler') : 'noch nicht analysiert'}${u.path ? ' · ' + esc(u.path) : ''}</div></div><span class="chev">›</span></a></li>`;
  }).join('')}</ul></div>`;
}

export function unitView(el, subId, fileId, part = 'analyse') {
  const sub = store.subject(subId);
  const u = sub?.units.find(x => x.fileId === fileId);
  if (!u) return notFound(el);
  setTitle(u.title);
  if (sub.files[fileId]?.isNew) store.update(s => { s.subjects.find(x => x.id === subId).files[fileId].isNew = false; }, { silent: true });
  el.innerHTML = `<div class="tabs">${[['analyse', 'Durcharbeiten'], ['chat', 'Diskutieren'], ['text', 'Transkript']].map(([k, l]) => `<a class="tab ${k === part ? 'active' : ''}" href="#/fach/${subId}/einheit/${fileId}/${k}">${l}</a>`).join('')}</div><div id="part"></div>`;
  const body = el.querySelector('#part');
  if (part === 'analyse') {
    const a = u.analysis;
    if (!a) {
      const job = jobs.get('unit:' + fileId);
      body.innerHTML = job && !job.done ? busy(job.status) : `<div class="card">${u.error ? errorBox(u.error) : ''}Diese Einheit ist noch nicht analysiert. <button class="btn small" data-a="run">Jetzt analysieren</button></div>`;
    } else {
      const chs = (a.kapitelIds || []).map(id => findChapter(sub, id)).filter(Boolean);
      body.innerHTML = `<div class="card"><h3>${esc(a.thema || u.title)}</h3>${md(a.ueberblick)}</div>
        ${a.profBetont?.length ? `<div class="card" style="border-color:var(--hl);background:var(--hl-soft)"><h3>★ Das wurde betont</h3><ul>${a.profBetont.map(p => `<li><strong>${enrich(esc(p.hinweis))}</strong>${p.kontext ? `<div class="small muted">„${esc(p.kontext)}“</div>` : ''}</li>`).join('')}</ul></div>` : ''}
        <div class="card"><h3>Die wichtigsten Themen</h3>${(a.kernthemen || []).map(k => `<details><summary>${esc(k.titel)}</summary>${md(k.erklaerung)}</details>`).join('')}</div>
        ${a.stolperfallen?.length ? `<div class="card"><h3>⚠ Stolperfallen</h3><ul>${a.stolperfallen.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul></div>` : ''}
        ${a.faelle?.length ? `<div class="card"><h3>Besprochene Fälle</h3>${a.faelle.map(f => `<details><summary>${esc(f.kurz)}</summary>${md(f.loesung)}</details>`).join('')}</div>` : ''}
        ${a.begriffe?.length ? `<div class="card"><h3>Begriffe</h3><ul class="list">${a.begriffe.map(b => `<li><strong>${esc(b.begriff)}</strong><div class="small">${enrich(esc(b.erklaerung))}</div></li>`).join('')}</ul></div>` : ''}
        ${chs.length ? `<div class="card"><h3>Dazu im Lehrbuch</h3><ul class="list">${chs.map(c => `<li><a class="item" href="#/fach/${subId}/kapitel/${c.chapter.id}">📘 ${esc(c.chapter.title)}<span class="chev">›</span></a></li>`).join('')}</ul></div>` : ''}
        <div class="row"><a class="btn" href="#/fach/${subId}/einheit/${fileId}/chat">Über die Einheit diskutieren</a><button class="btn ghost small" data-a="run">Neu analysieren</button></div>`;
    }
    body.onclick = async e => {
      if (e.target.closest('[data-a=run]')) {
        runJob('unit:' + fileId, `Einheit „${u.title}“ analysieren`, st => analyzeUnit(subId, fileId, st), { subId });
        body.innerHTML = busy('Analysiere Einheit …');
      }
    };
  }
  if (part === 'chat') {
    store.update(s => { const x = s.subjects.find(y => y.id === subId).units.find(y => y.fileId === fileId); x.chat = x.chat || []; }, { silent: true });
    const ref = store.subject(subId).units.find(y => y.fileId === fileId);
    mountChat(body, {
      history: ref.chat, onSave: () => store.update(() => {}, { silent: true }),
      system: async () => {
        const t = await getFileText(store.subject(subId), fileId);
        const chs = (ref.analysis?.kapitelIds || []).map(id => findChapter(store.subject(subId), id)).filter(Boolean);
        let lb = '';
        for (const c of chs.slice(0, 3)) lb += `\n\n### Lehrbuchkapitel „${c.chapter.title}“\n` + (await chapterText(store.subject(subId), c.chapter.id)).slice(0, 120000);
        return `Du diskutierst mit der Studentin die Lehrveranstaltungseinheit „${ref.title}“. Grundlage sind das Transkript und die zugehörigen Lehrbuchkapitel. Unterscheide klar, was aus der Einheit und was aus dem Lehrbuch stammt.\n\nTRANSKRIPT:\n${t.text.slice(0, 200000)}${lb ? '\n\nLEHRBUCH:' + lb : ''}`;
      },
      placeholder: 'Frage zur Einheit …',
      emptyText: 'Diskutiere die Einheit: Fragen, Unklarheiten, Fälle aus der Einheit.',
      quickPrompts: [{ label: 'Was war am wichtigsten?', prompt: 'Was waren die drei wichtigsten Punkte dieser Einheit und warum?' }, { label: 'Frag mich ab', prompt: 'Frag mich zum Inhalt dieser Einheit ab, eine Frage nach der anderen.' }]
    });
  }
  if (part === 'text') {
    body.innerHTML = busy('Lade Transkript …');
    getFileText(sub, fileId).then(t => body.innerHTML = `<div class="card" style="white-space:pre-wrap;font-size:.92rem">${esc(t.text)}</div>`).catch(e => body.innerHTML = errorBox(e));
  }
}

// ---------- Falltraining (Tab) ----------
function tabCases(el, sub) {
  const cases = (store.state.progress.cases || []).filter(c => c.subId === sub.id).slice(-15).reverse();
  el.innerHTML = `<div class="card"><h3>Fall üben</h3><p class="small muted">Die App erstellt einen Fall aus den Stoffgebieten deiner Lehrbücher. Du kannst nur die Anspruchsgrundlagen suchen oder den ganzen Fall lösen.</p>
    <a class="btn" href="#/fach/${sub.id}/fall">Neuen Fall starten</a></div>
    ${cases.length ? `<div class="card"><h3>Bisherige Fälle</h3><ul class="list">${cases.map(c => `<li><div class="row between"><div><div>${esc(c.title)}</div><div class="tiny muted">${fmtDate(c.at)} · ${c.mode === 'ansprueche' ? 'Anspruchstraining' : 'Falllösung'}</div></div><span class="pill ${c.score >= 0.75 ? 'green' : c.score >= 0.45 ? 'yellow' : 'red'}">${Math.round(c.score * 100)} %</span></div></li>`).join('')}</ul></div>` : ''}`;
}

// ---------- Altklausuren ----------
function tabAlt(el, sub) {
  if (!sub.altklausuren.length) { el.innerHTML = `<div class="card empty">Noch keine Altklausuren. Wähle den Ordner unter <a href="#/fach/${sub.id}/bearbeiten">Fach bearbeiten</a>.</div>`; return; }
  const ov = sub.altOverview;
  const done = sub.altklausuren.filter(k => k.analysis).length;
  let html = `<div class="card"><div class="row between"><h3 style="margin:0">Gesamtauswertung</h3><button class="btn small" data-a="ov" ${done < 1 ? 'disabled' : ''}>${ov ? 'Aktualisieren' : 'Erstellen'}</button></div>`;
  if (ov) {
    html += `<p class="tiny muted">aus ${ov.count} Klausuren · ${fmtDate(ov.at)}</p>
      ${ov.dauerbrenner?.length ? `<h4>Dauerbrenner</h4><ul class="list">${ov.dauerbrenner.map(d => `<li><div class="row between"><strong>${esc(d.thema)}</strong><span class="pill gold">${d.haeufigkeit}×</span></div><div class="small">${enrich(esc(d.typischeKonstellation || ''))}</div>${(d.kapitelIds || []).map(id => findChapter(sub, id)).filter(Boolean).map(c => `<a class="tiny" href="#/fach/${sub.id}/kapitel/${c.chapter.id}">📘 ${esc(c.chapter.title)}</a>`).join(' · ')}</li>`).join('')}</ul>` : ''}
      ${ov.anspruchsgrundlagen?.length ? `<h4>Häufige Anspruchsgrundlagen</h4>${ov.anspruchsgrundlagen.map(a => `<span class="pill blue" style="margin:2px">${enrich(esc(a.grundlage))} · ${a.haeufigkeit}×</span>`).join(' ')}` : ''}
      ${ov.stolperfallen?.length ? `<h4>⚠ Wiederkehrende Stolperfallen</h4><ul>${ov.stolperfallen.map(s => `<li>${enrich(esc(s))}</li>`).join('')}</ul>` : ''}
      ${ov.muster ? `<h4>Aufbau der Klausuren</h4>${md(ov.muster)}` : ''}
      ${ov.empfehlungen?.length ? `<h4>Empfehlungen</h4><ul>${ov.empfehlungen.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}`;
  } else html += `<p class="small muted">Wertet alle analysierten Klausuren gemeinsam aus: Was kommt immer wieder?</p>`;
  html += `</div><div class="card"><h3>Klausuren</h3><ul class="list">${sub.altklausuren.map(k => {
    const job = jobs.get('alt:' + k.fileId);
    return `<li><a class="item" href="#/fach/${sub.id}/altklausur/${k.fileId}"><div style="flex:1"><div class="item-title">${esc(k.title)}</div><div class="small muted">${k.analysis ? (k.analysis.faelle || []).map(f => esc(f.kurz)).join(' · ') : job && !job.done ? 'wird analysiert …' : k.status === 'fehler' ? '⚠ ' + esc(k.error || '') : 'noch nicht analysiert'}</div></div><span class="chev">›</span></a></li>`;
  }).join('')}</ul></div>`;
  el.innerHTML = html;
  el.querySelector('[data-a=ov]')?.addEventListener('click', () => { runJob('altov:' + sub.id, 'Gesamtauswertung der Altklausuren', () => altklausurOverview(sub.id), { subId: sub.id }); toast('Auswertung läuft …'); });
}

export function altklausurView(el, subId, fileId) {
  const sub = store.subject(subId);
  const k = sub?.altklausuren.find(x => x.fileId === fileId);
  if (!k) return notFound(el);
  setTitle(k.title);
  const a = k.analysis;
  if (!a) {
    el.innerHTML = `<div class="card">${k.error ? errorBox(k.error) : ''}Noch nicht analysiert. <button class="btn small" data-a="run">Jetzt analysieren</button></div>`;
  } else {
    el.innerHTML = `<div class="card"><h3>${esc(a.titel || k.title)}</h3><div class="small muted">${[a.datum, a.dauer].filter(Boolean).map(esc).join(' · ')}</div>
      ${a.schwerpunkte?.length ? `<div style="margin-top:8px">${a.schwerpunkte.map(s => `<span class="pill blue" style="margin:2px">${esc(s)}</span>`).join(' ')}</div>` : ''}</div>
      ${(a.faelle || []).map((f, i) => `<div class="card"><h3>Fall ${esc(f.nr || i + 1)}: ${esc(f.kurz)}</h3>
        <details><summary>Sachverhalt</summary><div class="sachverhalt">${esc(f.sachverhalt)}</div>${f.fragen?.length ? `<ol>${f.fragen.map(q => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}</details>
        <details><summary>Anspruchsgrundlagen</summary><ul>${(f.ansprueche || []).map(x => `<li><strong>${esc(x.wer)} gegen ${esc(x.gegen)}</strong>: ${esc(x.was)} – ${enrich(esc(x.grundlage))}</li>`).join('')}</ul></details>
        <details><summary>Lösung ${f.loesungQuelle === 'KI' ? '<span class="pill yellow">KI-Skizze</span>' : '<span class="pill green">Musterlösung</span>'}</summary>${md(f.loesung)}</details>
        ${f.stolperfallen?.length ? `<h4>⚠ Stolperfallen</h4><ul>${f.stolperfallen.map(s => `<li>${enrich(esc(s))}</li>`).join('')}</ul>` : ''}
        ${(f.kapitelIds || []).map(id => findChapter(sub, id)).filter(Boolean).map(c => `<a class="small" href="#/fach/${subId}/kapitel/${c.chapter.id}">📘 ${esc(c.chapter.title)}</a>`).join(' · ')}
        <div class="row" style="margin-top:10px"><a class="btn small" href="#/fach/${subId}/fall/${encodeURIComponent('alt:' + fileId + ':' + i)}">Diesen Fall selbst lösen</a></div></div>`).join('')}
      ${a.stolperfallen?.length ? `<div class="card"><h3>⚠ Übergreifende Stolperfallen</h3><ul>${a.stolperfallen.map(s => `<li>${enrich(esc(s))}</li>`).join('')}</ul></div>` : ''}
      <button class="btn ghost small" data-a="run">Neu analysieren</button>`;
  }
  el.onclick = e => {
    if (e.target.closest('[data-a=run]')) { runJob('alt:' + fileId, `Altklausur „${k.title}“ analysieren`, st => analyzeAltklausur(subId, fileId, st), { subId }); el.innerHTML = busy('Analysiere Klausur …'); }
  };
}

// ---------- OGH-Urteile ----------
function tabOgh(el, sub, state = { filter: 'alle', q: '' }) {
  const citedAll = new Map();
  for (const b of sub.books) for (const [gz, n] of b.citations?.gz || []) citedAll.set(gz, (citedAll.get(gz) || 0) + n);
  const meta = sub.rulingMeta || {};
  const draw = () => {
    let list = [...sub.rulings];
    if (state.filter === 'neu') list = list.filter(r => r.isNew);
    if (state.filter === 'eigene') list = list.filter(r => r.source === 'upload');
    if (state.filter === 'zitiert') list = list.filter(r => r.cited);
    if (state.q) { const q = state.q.toLowerCase(); list = list.filter(r => [r.gz, r.title, r.schlagworte, (r.normen || []).join(' '), r.summary?.kernaussagen?.join(' ')].join(' ').toLowerCase().includes(q)); }
    list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const citedNotAdded = state.filter === 'zitiert' ? [...citedAll.entries()].filter(([gz]) => !sub.rulings.some(r => r.gz && r.gz.replace(/\s+/g, '') === gz.replace(/\s+/g, ''))).sort((a, b) => b[1] - a[1]) : [];
    const job = jobs.get('ogh:' + sub.id);
    el.innerHTML = `<div class="card"><div class="row between"><div class="small muted">${meta.lastCheck ? 'Zuletzt im RIS gesucht: ' + fmtDate(meta.lastCheck) + ` · anhand von ${meta.norms?.length || 0} Normen aus deinen Lehrbüchern` : 'Noch nicht im RIS gesucht.'}</div>
      <button class="btn small" data-a="check" ${job && !job.done ? 'disabled' : ''}>${job && !job.done ? '<span class="spinner"></span> sucht …' : 'Neue Urteile suchen'}</button></div>
      <p class="tiny muted">Ergänzung, kein Lehrbuchstoff. Quelle: RIS (Bundeskanzleramt), CC BY 4.0.</p></div>
      <div class="tabs">${[['alle', 'Alle'], ['neu', 'Neu'], ['zitiert', 'Im Lehrbuch zitiert'], ['eigene', 'Eigene Uploads']].map(([k, l]) => `<button class="tab ${state.filter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
      <input type="text" id="q" placeholder="Suchen (GZ, Norm, Stichwort) …" value="${esc(state.q)}" style="margin-bottom:12px">
      <div class="card"><ul class="list">${list.slice(0, 300).map(r => `<li><a class="item" href="#/fach/${sub.id}/urteil/${encodeURIComponent(r.id)}"><div style="flex:1"><div class="item-title">${r.source === 'upload' ? '📄 ' + esc(r.title || r.gz) : 'OGH ' + esc(r.gz)} ${r.isNew ? '<span class="pill gold">neu</span>' : ''} ${r.cited ? '<span class="pill blue">im Lehrbuch</span>' : ''}</div>
        <div class="small muted">${r.date ? fmtDate(r.date) + ' · ' : ''}${esc((r.summary?.kernaussagen?.[0] || r.schlagworte || (r.normen || []).slice(0, 4).join(', ')).slice(0, 200))}</div></div><span class="chev">›</span></a></li>`).join('') || '<li class="muted small">Keine Einträge.</li>'}</ul></div>
      ${citedNotAdded.length ? `<div class="card"><h3>Im Lehrbuch zitiert, noch nicht geladen</h3><p class="tiny muted">Je öfter zitiert, desto wichtiger. Antippen zum Laden.</p><div class="row">${citedNotAdded.slice(0, 80).map(([gz, n]) => `<button class="btn secondary small" data-gz="${esc(gz)}">${esc(gz)} <span class="tiny">(${n}×)</span></button>`).join('')}</div></div>` : ''}`;
    el.querySelector('#q').oninput = e => { state.q = e.target.value; clearTimeout(el._t); el._t = setTimeout(() => { draw(); const q = el.querySelector('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 350); };
  };
  el.onclick = async e => {
    const f = e.target.closest('[data-f]'); if (f) { state.filter = f.dataset.f; draw(); return; }
    if (e.target.closest('[data-a=check]')) { runJob('ogh:' + sub.id, `Suche neue OGH-Urteile für „${sub.name}“`, st => checkNewRulings(sub.id, st).then(n => toast(n ? `${n} neue Entscheidung(en) gefunden` : 'Keine neuen Entscheidungen')), { subId: sub.id }); draw(); return; }
    const gz = e.target.closest('[data-gz]')?.dataset.gz;
    if (gz) { toast('Suche ' + gz + ' im RIS …'); try { const r = await addCitedRuling(sub.id, gz); location.hash = `#/fach/${sub.id}/urteil/${encodeURIComponent(r.id)}`; } catch (err) { toast(err.message, 6000); } }
  };
  draw();
}

export function rulingView(el, subId, rid, part = 'kern') {
  const sub = store.subject(subId);
  const r = sub?.rulings.find(x => x.id === rid);
  if (!r) return notFound(el);
  setTitle(r.source === 'upload' ? (r.title || 'Urteil') : 'OGH ' + r.gz);
  if (r.isNew) store.update(s => { s.subjects.find(x => x.id === subId).rulings.find(x => x.id === rid).isNew = false; }, { silent: true });
  el.innerHTML = `<div class="small muted">${r.date ? fmtDate(r.date) + ' · ' : ''}${(r.normen || []).slice(0, 6).map(n => esc(n)).join(', ')}</div>
    <div class="tabs" style="margin-top:8px">${[['kern', 'Kernaussagen'], ['zusammenfassung', 'Zusammenfassung'], ['volltext', 'Volltext'], ['chat', 'Diskutieren']].map(([k, l]) => `<a class="tab ${k === part ? 'active' : ''}" href="#/fach/${subId}/urteil/${encodeURIComponent(rid)}/${k}">${l}</a>`).join('')}</div><div id="part"></div>
    ${r.url ? `<p class="small"><a href="${esc(r.url)}" target="_blank" rel="noopener">Im RIS öffnen ↗</a></p>` : ''}`;
  const body = el.querySelector('#part');
  const ensureSummary = async () => {
    if (r.summary) return r.summary;
    body.innerHTML = busy('Lade Entscheidung und bereite sie auf …');
    return summarizeRuling(subId, rid);
  };
  if (part === 'kern' || part === 'zusammenfassung') {
    ensureSummary().then(s => {
      if (part === 'kern') {
        body.innerHTML = `<div class="card"><h3>Kernaussagen</h3><ol>${(s.kernaussagen || []).map(k => `<li>${enrich(esc(k))}</li>`).join('')}</ol></div>
          <div class="card"><h3>Bedeutung für dich</h3>${md(s.bedeutung)}</div>
          ${(s.kapitelIds || []).map(id => findChapter(store.subject(subId), id)).filter(Boolean).map(c => `<a class="small" href="#/fach/${subId}/kapitel/${c.chapter.id}">📘 ${esc(c.chapter.title)}</a>`).join(' · ')}`;
      } else {
        body.innerHTML = `<div class="card"><h3>Sachverhalt</h3>${md(s.sachverhalt)}<h3>Rechtsfrage</h3>${md(s.rechtsfrage)}<h3>Entscheidung</h3>${md(s.entscheidung)}<h3>Begründung</h3>${md(s.begruendung)}<h3>Bedeutung</h3>${md(s.bedeutung)}</div>`;
      }
    }).catch(e => body.innerHTML = errorBox(e) + (r.url ? `<p class="small">Du kannst die Entscheidung <a href="${esc(r.url)}" target="_blank" rel="noopener">direkt im RIS öffnen</a>.</p>` : ''));
  }
  if (part === 'volltext') {
    body.innerHTML = busy('Lade Volltext …');
    loadRulingTexts(subId, rid).then(t => {
      body.innerHTML = (t.rs.length ? `<div class="card"><h3>Rechtssätze</h3>${t.rs.map(x => `<div class="small" style="white-space:pre-wrap;margin-bottom:10px">${enrich(esc(x))}</div>`).join('<hr>')}</div>` : '') +
        `<div class="card sachverhalt" style="font-size:.93rem">${t.full ? enrich(esc(t.full)) : 'Kein Volltext verfügbar.'}</div>`;
    }).catch(e => body.innerHTML = errorBox(e));
  }
  if (part === 'chat') {
    store.update(s => { const x = s.subjects.find(y => y.id === subId).rulings.find(y => y.id === rid); x.chat = x.chat || []; }, { silent: true });
    const ref = store.subject(subId).rulings.find(y => y.id === rid);
    mountChat(body, {
      history: ref.chat, onSave: () => store.update(() => {}, { silent: true }),
      system: async () => { const t = await loadRulingTexts(subId, rid); return `Du diskutierst mit der Studentin die OGH-Entscheidung ${ref.gz || ref.title}. Grundlage ist der Entscheidungstext. Ordne sie in die österreichische Lehre ein, kennzeichne aber, was aus der Entscheidung stammt.\n\n${t.rs.length ? 'RECHTSSÄTZE:\n' + t.rs.join('\n---\n').slice(0, 30000) + '\n\n' : ''}ENTSCHEIDUNG:\n${(t.full || '').slice(0, 200000)}`; },
      placeholder: 'Frage zur Entscheidung …',
      quickPrompts: [{ label: 'Warum wichtig?', prompt: 'Warum ist diese Entscheidung für die Prüfung wichtig, und wie würde ich sie in einer Falllösung verwenden?' }, { label: 'Abweichung zur Lehre?', prompt: 'Weicht die Entscheidung von der herrschenden Lehre oder früherer Rechtsprechung ab?' }]
    });
  }
}

// ---------- Mündlich ----------
function tabOral(el, sub) {
  const oralExams = sub.exams.filter(e => e.type === 'muendlich');
  const sims = (store.state.progress.orals || []).filter(o => o.subId === sub.id).slice(-10).reverse();
  const protocols = Object.values(sub.files).filter(f => f.category === 'protocols');
  el.innerHTML = `<div class="card"><h3>Prüfungssimulation</h3><p class="small muted">Eine KI-Prüferin fragt dich wie in der echten mündlichen Prüfung, hakt nach und gibt am Ende Feedback. Antworten am besten per Mikrofon.</p>
    ${oralExams.length ? oralExams.map(e => `<a class="btn" style="margin:4px 4px 0 0" href="#/fach/${sub.id}/simulation/${e.id}">${esc(e.name)} simulieren</a>`).join('') : `<a class="btn" href="#/fach/${sub.id}/simulation/frei">Simulation starten</a><p class="tiny muted">Tipp: Lege unter „Fach bearbeiten“ eine mündliche Prüfung an, dann bezieht die Simulation die Stoffeingrenzung ein.</p>`}</div>
    <div class="card"><h3>Prüferprotokolle</h3>${protocols.length ? `<ul class="list">${protocols.map(p => `<li class="small">📄 ${esc(p.name)}</li>`).join('')}</ul><p class="tiny muted">Werden in der Simulation berücksichtigt: Die KI fragt bevorzugt, was laut Protokollen oft drankommt.</p>` : `<p class="small muted">Keine Protokolle. Ordner unter <a href="#/fach/${sub.id}/bearbeiten">Fach bearbeiten</a> wählen.</p>`}</div>
    ${sims.length ? `<div class="card"><h3>Bisherige Simulationen</h3><ul class="list">${sims.map(s => `<li><div class="row between"><span>${fmtDate(s.at)}</span><span class="pill ${s.note <= 2 ? 'green' : s.note <= 3 ? 'yellow' : 'red'}">Note ${s.note}</span></div><div class="small muted">${esc(s.summary || '')}</div></li>`).join('')}</ul></div>` : ''}`;
}

// ---------- Dateien ----------
function tabFiles(el, sub) {
  const files = Object.values(sub.files);
  const byCat = cat => files.filter(f => f.category === cat);
  el.innerHTML = `<div class="card"><div class="row"><button class="btn small" data-a="scan">Nach neuen Dateien suchen</button><button class="btn secondary small" data-a="proc">Alles Offene verarbeiten</button><a class="btn ghost small" href="#/fach/${sub.id}/bearbeiten">Ordner ändern</a></div>
    <p class="tiny muted">${sub.lastScan ? 'Zuletzt gesucht: ' + new Date(sub.lastScan).toLocaleString('de-AT') : 'Noch nicht gesucht.'}</p></div>
    ${Object.entries(CATEGORIES).map(([k, c]) => `<div class="card"><h3>${esc(c.label)} <span class="muted small">(${byCat(k).length})</span></h3>
      <div class="small muted">Ordner: ${(sub.folders[k] || []).map(f => esc(f.name)).join(', ') || 'nicht gewählt'}</div>
      <ul class="list">${byCat(k).slice(0, 200).map(f => `<li class="small">${esc(f.name)} ${f.isNew ? '<span class="pill gold">neu</span>' : ''} ${f.changed ? '<span class="pill yellow">geändert</span>' : ''}${f.path ? `<div class="tiny muted">${esc(f.path)}</div>` : ''}</li>`).join('')}</ul></div>`).join('')}`;
  el.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'scan') { autoUpdate({ subjects: [sub.id] }); toast('Suche läuft …'); }
    if (a === 'proc') {
      store.update(s => { const sb = s.subjects.find(x => x.id === sub.id); sb.books.forEach(b => { if (b.status === 'fehler') b.status = 'neu'; }); sb.units.forEach(u => { if (u.status === 'fehler') u.status = 'neu'; }); sb.altklausuren.forEach(k => { if (k.status === 'fehler') k.status = 'neu'; }); sb.rulings.forEach(r => { if (r.status === 'fehler') r.status = 'neu'; }); });
      queueProcessing(sub.id); toast('Verarbeitung läuft im Hintergrund');
    }
  };
}

// ---------- Prüfung: Lernplan & Stoffeingrenzung ----------
export function examView(el, subId, examId) {
  const sub = store.subject(subId);
  const exam = sub?.exams.find(e => e.id === examId);
  if (!exam) return notFound(el);
  setTitle(exam.name);
  const plan = computePlan(sub, exam);
  const scopeFiles = Object.values(sub.files).filter(f => f.category === 'scope');
  const cls = { gut: 'green', knapp: 'yellow', eng: 'red' }[plan.status] || 'blue';
  const groups = [['voll', 'Voll eingeplant'], ['kurz', 'Als Überblick eingeplant'], ['wenn-zeit', 'Nur wenn Zeit bleibt'], ['raus', 'Kein Prüfungsstoff']];
  el.innerHTML = `<div class="card"><div class="row between"><div><div class="item-title">${esc(sub.name)} · ${esc(exam.name)}</div><div class="small muted">${exam.date ? fmtDate(exam.date) : 'kein Termin'} · ${exam.hoursPerDay} h pro Lerntag</div></div><span class="pill ${cls}">${{ gut: 'Zeit reicht', knapp: 'knapp', eng: 'priorisiert', offen: 'offen', vorbei: 'vorbei' }[plan.status]}</span></div>
    <p>${esc(plan.message)}</p>
    <div class="grid3"><div class="stat"><div class="num">${fmtMin(plan.need)}</div><div class="lbl">Lernaufwand noch</div></div><div class="stat"><div class="num">${isFinite(plan.available) ? fmtMin(plan.available) : '–'}</div><div class="lbl">Lernzeit bis zur Prüfung</div></div><div class="stat"><div class="num">${plan.studyDays ?? '–'}</div><div class="lbl">Lerntage</div></div></div>
    <details style="margin-top:10px"><summary class="small">So rechnet die App</summary><div class="small">
      <p><strong>Verfügbare Zeit:</strong> alle Tage ab heute bis zum Tag vor der Prüfung, nur an deinen Lerntagen (${(exam.studyDays || []).map(d => ['So','Mo','Di','Mi','Do','Fr','Sa'][d]).join(', ')}). Abgezogen werden Feiertage und alle Einträge im <a href="#/kalender">Lernkalender</a>${plan.offDays ? ` – derzeit <strong>${plan.offDays} Tag(e)</strong>: ${plan.offList.slice(0, 8).map(o => `${o.icon} ${fmtDate(o.date)}`).join(', ')}${plan.offList.length > 8 ? ' …' : ''}` : ''}. Das ergibt ${plan.studyDays ?? '–'} Lerntage × ${exam.hoursPerDay} h. Davon bleiben 10 % als Puffer für die Schlusswiederholung.</p>
      <p><strong>Nötige Zeit:</strong> pro Kapitel die geschätzte Lernzeit aus der Zusammenfassung (sonst ca. 6 Min. pro Seite), bei schriftlichen Prüfungen +25 % fürs Falltraining. Was du laut Einstufung, Tests und Fällen schon kannst, wird abgezogen.</p>
      <p>Noch nicht zusammengefasste Kapitel werden grob nach Seitenzahl geschätzt – die Rechnung wird genauer, sobald alle Lehrbücher verarbeitet sind.</p></div></details>
    <div class="row" style="margin-top:8px"><a class="btn secondary small" href="#/kalender">📅 Lernkalender: freie Tage, Krankheit, Schließtage</a></div></div>

  <div class="card"><h3>Stoffeingrenzung</h3>
    ${exam.scopeMap ? `<div class="notice ok small">Eingrenzung ist den Kapiteln zugeordnet. Du kannst jede Zuordnung unten ändern.</div>${exam.scopeNotes ? md(exam.scopeNotes) : ''}` : '<p class="small muted">Ohne Eingrenzung gilt der gesamte Lehrbuchstoff.</p>'}
    ${scopeFiles.length ? `<div class="small">Dateien für diese Prüfung:</div>${scopeFiles.map(f => `<label class="checkline small"><input type="checkbox" data-scopefile="${f.id}" ${exam.scopeFileIds?.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}` : ''}
    <label class="field"><span>oder Eingrenzung hier hineinkopieren</span><textarea id="scopeText" placeholder="z. B. „Prüfungsstoff: Allgemeiner Teil, Schuldrecht AT, Gewährleistung, Schadenersatz …“">${esc(exam.scopeText || '')}</textarea></label>
    <div class="row"><button class="btn small" data-a="scope">Eingrenzung anwenden</button>${exam.scopeMap ? '<button class="btn ghost small" data-a="noscope">Eingrenzung entfernen</button>' : ''}</div></div>

  ${groups.map(([g, l]) => { const items = plan.chapters.filter(c => c.plan === g); return items.length ? `<div class="card"><h3>${l} <span class="muted small">(${items.length})</span></h3><ul class="list">${items.map(c => `<li><div class="row"><span class="dot ${ampel(c.mastery, c.assessed)}"></span><a href="#/fach/${subId}/kapitel/${c.id}" style="flex:1;text-decoration:none;color:inherit"><div>${esc(c.title)}</div><div class="tiny muted">${c.assessed ? Math.round(c.mastery * 100) + ' % · ' : ''}noch ca. ${fmtMin(c.remaining)}${c.altCount ? ` · ${c.altCount}× in Altklausuren` : ''}${c.profCount ? ' · in der LV betont' : ''}</div></a>
    <select data-prio="${c.id}" style="width:auto;min-height:32px;padding:4px 8px;font-size:.8rem">${['muss', 'wichtig', 'optional', 'raus'].map(p => `<option value="${p}" ${c.scope === p ? 'selected' : ''}>${PRIO_LABEL[p]}</option>`).join('')}</select></div></li>`).join('')}</ul></div>` : ''; }).join('')}
  <div class="row"><a class="btn" href="#/fach/${subId}/einstufung/${examId}">Einstufungstest</a><a class="btn secondary" href="#/fach/${subId}/bearbeiten">Termin & Lernzeit ändern</a></div>`;

  el.onchange = e => {
    const sel = e.target.closest('[data-prio]');
    if (sel) {
      store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); if (!ex.scopeMap) { ex.scopeMap = {}; allChapters(sub).forEach(c => ex.scopeMap[c.id] = 'wichtig'); } ex.scopeMap[sel.dataset.prio] = sel.value; });
      render();
    }
    const sf = e.target.closest('[data-scopefile]');
    if (sf) store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.scopeFileIds = [...el.querySelectorAll('[data-scopefile]')].filter(c => c.checked).map(c => c.dataset.scopefile); }, { silent: true });
  };
  el.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'scope') {
      store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.scopeText = el.querySelector('#scopeText').value; }, { silent: true });
      const btn = e.target.closest('[data-a]'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ordne zu …';
      try { await mapScope(subId, examId); toast('Eingrenzung angewendet'); render(); } catch (err) { toast(err.message, 6000); btn.disabled = false; btn.textContent = 'Eingrenzung anwenden'; }
    }
    if (a === 'noscope') { store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.scopeMap = null; ex.scopeNotes = ''; }); render(); }
  };
}
