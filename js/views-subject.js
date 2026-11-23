// Ansichten innerhalb eines Fachs
import { store, allChapters, findChapter, textGet, syncExam, currentAttempt, isStudyChapter, bookRole, bookInExam, collectionCases } from './store.js';
import { esc, md, enrich, toast, busy, errorBox, fmtDate, daysUntil, fmtMin, ampel, confirmDialog, openModal, closeModal } from './ui.js';
import { setTitle, render, autoUpdate, queueProcessing } from './app.js';
import { computePlan, activeExams, subjectMastery, PRIO_LABEL, paceText } from './planner.js';
import { runJob, activeJobs, jobs } from './jobs.js';
import { levelText, processBook, analyzeUnit, analyzeAltklausur, altklausurOverview, summarizeChapter, chapterText, checkNewRulings, subjectContext, buildPools, poolEstimate, buildVisuals, visualsEstimate, buildSkript, skriptEstimate, addCitedRuling, prepareRulings, chaptersByNorm, migrateRulings, loadRulingTexts, summarizeRuling, mapScope, markStudied, getFileText, CATEGORIES } from './processing.js';
import { mountChat } from './chat.js';
import { clip, cancelBatch } from './ai.js';
import { mountQuiz, mountFreeQuestion, mountChapterCards } from './views-learn.js';
import { isSignedIn } from './drive.js';

const TABS = [['plan', 'Übersicht'], ['chat', 'Chat'], ['stoff', 'Lehrbuch'], ['schemata', 'Falllösungsschemata'], ['begriffe', 'Begriffe'], ['einheiten', 'Einheiten'], ['falltraining', 'Falltraining'], ['altklausuren', 'Altklausuren'], ['ogh', 'OGH-Urteile'], ['muendlich', 'Mündlich'], ['dateien', 'Dateien']];

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
// Bearbeitungsstand und Aktionen eines Buchs (Kostenvoranschlag, Freigabe, Hintergrund)
function bookAction(b, job) {
  const role = bookRole(b);
  const verb = role === 'faelle' ? 'Fälle aufbereiten' : 'Zusammenfassen';
  if (b.batch) {
    const pc = b.batch.progress || {};
    const done = (pc.succeeded || 0) + (pc.errored || 0);
    return `<div class="notice small" style="margin-top:8px">⏳ <strong>Läuft im Hintergrund</strong> (${b.batch.n} Kapitel, gestartet ${new Date(b.batch.at).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}${done ? `, ${done} fertig` : ''}). Du kannst die App schließen – die Ergebnisse werden beim nächsten Öffnen abgeholt. Meist dauert das unter einer Stunde.
      <div style="margin-top:6px"><button class="btn ghost small" data-cancelbatch="${b.fileId}">Abbrechen</button></div></div>`;
  }
  if (job && !job.done) return `<div class="small muted" style="margin-top:8px"><span class="spinner"></span> ${esc(job.status)}</div>`;
  if (b.status === 'bereit' && b.estimate) {
    return `<div class="notice gold small" style="margin-top:8px"><strong>Bereit.</strong> ${verb}: ${b.estimate.chapters} Kapitel, kostet ca. <strong>${b.estimate.usd.toLocaleString('de-AT', { minimumFractionDigits: 2 })} $</strong>${b.estimate.batch ? ' (Hintergrund-Modus, halber Preis)' : ''}. Einmalig – danach kostet das Lesen der Zusammenfassungen nichts mehr.
      <div class="tiny" style="margin-top:4px">Bitte vorher kurz die Kapitelliste prüfen: Passen Titel, Seiten und Leseprobe? Wenn etwas nicht stimmt, bitte nicht freigeben.</div>
      <div style="margin-top:6px"><button class="btn small" data-approve="${b.fileId}">${verb} freigeben</button></div></div>`;
  }
  if (b.status === 'fertig') return '';
  return `<div style="margin-top:8px"><button class="btn secondary small" data-proc="${b.fileId}">${b.status === 'fehler' ? 'Erneut vorbereiten' : 'Vorbereiten (kostenlos)'}</button></div>`;
}

function bookNotes(b, sub) {
  let h = '';
  const study = b.chapters.filter(c => isStudyChapter(c) && c.summary);
  const noPool = study.filter(c => !c.pool?.length).length;
  const pj = jobs.get('pool:' + b.fileId);
  if (study.length && !b.batch) {
    h += noPool ? `<div class="notice gold small" style="margin-top:8px">🎯 <strong>Fragenpool</strong>: ${study.length - noPool} von ${study.length} Kapiteln haben schon feste Prüfungsfragen. Für die übrigen ${noPool} einmalig erstellen – danach sind Multiple Choice und Einstufungstest <strong>kostenlos und beliebig oft</strong> möglich.
      <div style="margin-top:6px">${pj && !pj.done ? `<span class="spinner"></span> ${esc(pj.status)}` : `<button class="btn small" data-pool="${b.fileId}">Fragenpool erstellen</button>`}</div></div>`
      : `<div class="small muted" style="margin-top:6px">🎯 Fragenpool vollständig – Multiple Choice und Einstufung kosten bei diesem Buch nichts.</div>`;
  }
  if (b.notice) h += `<div class="notice small" style="margin-top:8px">${esc(b.notice)}</div>`;
  if (b.structWarn?.length) h += `<div class="notice err small" style="margin-top:8px">⚠️ Kapitelerkennung unsicher: ${b.structWarn.map(esc).join(' · ')}. Bitte nicht freigeben.</div>`;
  return h;
}
function chapterPreviewList(sub, b) {
  return `<details style="margin-top:8px"><summary class="small">Abschnitte ansehen (${b.chapters.length})</summary><ul class="list">${b.chapters.map(c => `<li class="item" style="display:block"><div>${esc(c.title)}</div><div class="tiny muted">S. ${esc(c.startLabel || c.startPage)}–${esc(c.endLabel || c.endPage)}${c.cases ? ` · ${c.cases.length} Fälle` : ''}</div>${c.preview && !c.cases ? `<div class="tiny muted" style="font-style:italic">„${esc(c.preview.slice(0, 160))} …“</div>` : ''}</li>`).join('')}</ul></details>`;
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
  ({ plan: tabPlan, chat: tabChat, schemata: tabSchemata, begriffe: tabBegriffe, stoff: tabStoff, einheiten: tabUnits, falltraining: tabCases, altklausuren: tabAlt, ogh: tabOgh, muendlich: tabOral, dateien: tabFiles }[tab] || tabPlan)(body, sub);
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
      ${e.status === 'aktiv' ? `<span class="pill ${cls}">${{ gut: 'Sehr gut erreichbar', knapp: 'Fälle sicher', eng: 'priorisiert', offen: 'offen', vorbei: 'vorbei' }[plan.status]}</span>` : `<span class="pill ${e.status === 'bestanden' ? 'green' : ''}">${{ bestanden: 'bestanden ✓', nicht_bestanden: 'nicht bestanden', archiviert: 'pausiert' }[e.status]}</span>`}</div>
      ${(e.attempts || []).length > 1 ? `<div class="tiny muted" style="margin-top:4px">${e.attempts.map((a, j) => `${j === 0 ? 'Haupttermin' : j + '. Ersatztermin'}: ${a.date ? fmtDate(a.date) : 'offen'}${a.result === 'bestanden' ? ' ✓' : a.result === 'nicht_bestanden' ? ' ✗' : ''}`).join(' · ')}</div>` : ''}
      ${e.status === 'aktiv' && plan.status === 'vorbei' && currentAttempt(e) ? `<div class="notice gold"><strong>Wie ist die Prüfung am ${fmtDate(e.date)} gelaufen?</strong><div class="row" style="margin-top:8px"><button class="btn small" data-res="bestanden" data-ex="${e.id}">Bestanden 🎉</button><button class="btn secondary small" data-res="nicht_bestanden" data-ex="${e.id}">Nicht bestanden</button></div></div>` : ''}
      ${e.status === 'nicht_bestanden' || (e.status === 'aktiv' && currentAttempt(e) && !e.date) ? `<div class="notice"><div class="small"><strong>${e.status === 'nicht_bestanden' ? 'Ersatztermin eintragen' : 'Ersatztermin noch offen'}</strong> – sobald du ihn weißt, hier eintragen. Dein Lernstand bleibt erhalten.</div>
        <div class="row" style="margin-top:8px"><input type="date" data-newdate="${e.id}" style="flex:1;min-width:150px"><button class="btn small" data-savedate="${e.id}">Speichern</button></div>
        ${e.status === 'nicht_bestanden' ? `<button class="btn ghost small" data-unknown="${e.id}" style="margin-top:4px">Termin noch nicht bekannt</button>` : ''}</div>` : ''}
      ${e.status === 'aktiv' && plan.inScope.length ? `<div class="row" style="margin-top:8px"><div class="progress green" style="flex:1"><div style="width:${Math.round(plan.readiness * 100)}%"></div></div><span class="small"><strong>${Math.round(plan.readiness * 100)} %</strong> prüfungsreif</span></div>` : ''}
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

// ---------- Chat über den gesamten Stoff ----------
function tabChat(el, sub) {
  const ref = store.subject(sub.id);
  el.innerHTML = `<div class="card"><p class="small muted" style="margin-top:0">Frag alles zum Stoff dieses Fachs. Die App sucht dafür die passenden Stellen aus allen Lehrbüchern heraus – du musst nichts vorher zusammenfassen. Antworten mit Seitenangaben.</p><div id="fchat"></div></div>`;
  mountChat(el.querySelector('#fchat'), {
    history: ref.chat,
    onSave: () => store.update(s => { const x = s.subjects.find(y => y.id === sub.id); x.chat = ref.chat.slice(-60); }, { silent: true }),
    maxTokens: 2500,
    purpose: 'Fach-Chat',
    system: async () => {
      const lastUser = [...ref.chat].reverse().filter(m => m.role === 'user').slice(0, 2).map(m => m.content).join(' ');
      const ctx = await subjectContext(sub.id, lastUser);
      return `Du bist Lerncoach für das Fach „${sub.name}“ (österreichisches Recht). Beantworte Fragen auf Grundlage der LEHRBUCHAUSZÜGE unten und gib die Fundstelle an (Buch, S. x). Steht etwas nicht in den Auszügen, sag das ehrlich und nenne, in welchem Kapitel laut Inhaltsübersicht es vermutlich steht. Erfinde nichts. Wenn die Studentin abgefragt werden will: eine Frage nach der anderen, auf die Antwort warten, dann Feedback. Keine Fragen nach Paragraphennummern oder Gliederung. Bei Fällen: Anspruchsprüfung (Wer will was von wem woraus?).

INHALTSÜBERSICHT DER BÜCHER:
${ctx.toc}
${ctx.units ? `\nIN DEN EINHEITEN BETONT:\n${ctx.units}\n` : ''}
LEHRBUCHAUSZÜGE (passend zur Frage ausgewählt):
${ctx.text || '(keine passenden Stellen gefunden)'}`;
    },
    placeholder: 'Frage zum Stoff …',
    emptyText: 'Z. B. „Was ist der Unterschied zwischen Gewährleistung und Schadenersatz?“ oder „Frag mich zum Verzug ab“.',
    quickPrompts: [
      { label: 'Frag mich ab', prompt: 'Frag mich zu einem wichtigen Thema dieses Fachs ab: eine Frage nach der anderen, wie in einer Prüfung.' },
      { label: 'Kleiner Fall', prompt: 'Gib mir einen kurzen Klausurfall zu einem zentralen Thema. Ich löse ihn, dann korrigierst du mich nach der Anspruchsprüfung.' }
    ]
  });
}

// ---------- Falllösungsschemata ----------
const schemaState = {};
function stepHtml(st, depth = 0) {
  const sw = (st.sonderwissen || []).filter(x => x && (x.text || typeof x === 'string'));
  return `<li style="margin:6px 0"><div><strong>${enrich(esc(st.schritt || ''))}</strong>${st.erklaerung ? `<div class="small">${enrich(esc(st.erklaerung))}</div>` : ''}</div>
    ${sw.length ? `<ul class="small" style="margin:4px 0 0 0;padding-left:18px">${sw.map(x => `<li>💡 ${enrich(esc(x.text || x))}${x.seite ? ` <span class="cite">[${esc(String(x.seite).replace(/^\[|\]$/g, ''))}]</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${(st.unterschritte || []).length ? `<ol type="${depth ? 'i' : 'a'}" style="padding-left:20px">${st.unterschritte.map(u => stepHtml(u, depth + 1)).join('')}</ol>` : ''}</li>`;
}
function tabSchemata(el, sub) {
  const state = schemaState[sub.id] ||= { book: '' };
  const draw = () => {
    sub = store.subject(sub.id);
    const books = sub.books.filter(b => bookRole(b) === 'stoff' && b.chapters?.length);
    const shown = state.book ? books.filter(b => b.fileId === state.book) : books;
    const totalVis = books.reduce((a, b) => a + (b.visuals || []).filter(v => v.schema).length, 0);
    const running = books.filter(b => b.batch?.kind === 'vis');
    let html = `<div class="card"><p class="small" style="margin-top:0">Die <strong>Visualisierungen</strong> aus deinen Lehrbüchern als Schritt-für-Schritt-Schema – jeder Schritt ergänzt um das <strong>Sonderwissen</strong> aus dem Kapitel (Ausnahmen, Abgrenzungen, Stolperfallen) mit Seitenangaben. Darunter je Kapitel die Prüfungsschemata aus dem Text.</p>
      ${running.length ? `<div class="notice small">⏳ Grafiken werden im Hintergrund gelesen: ${running.map(b => esc(b.title)).join(', ')} – erscheinen hier automatisch (meist unter einer Stunde).</div>` : ''}
      ${books.some(b => !b.batch && !(b.visuals || []).length || (b.visuals || []).some(v => !v.schema) && !b.batch) ? `<button class="btn small" data-a="allvis">Grafiken aus allen Büchern einlesen</button> <span class="tiny muted">einmalig, Kosten werden vorher angezeigt</span>` : totalVis ? `<div class="small muted">🧭 ${totalVis} Schemata aus Visualisierungen vorhanden.</div>` : ''}
      <div style="margin-top:10px"><select id="sbook"><option value="">Alle Bücher</option>${books.map(b => `<option value="${b.fileId}" ${state.book === b.fileId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select></div></div>`;
    for (const b of shown) {
      const byCh = new Map();
      for (const v of (b.visuals || []).filter(v => v.schema)) (byCh.get(v.chapterId) || byCh.set(v.chapterId, []).get(v.chapterId)).push(v);
      const chs = b.chapters.filter(c => isStudyChapter(c) && (byCh.has(c.id) || (c.summary?.schemata || []).length));
      if (!chs.length) continue;
      html += `<h3 style="margin:18px 4px 8px">${esc(b.title)}</h3>`;
      for (const c of chs) {
        html += `<div class="card"><div class="small muted">${esc(c.title)}</div>`;
        for (const v of byCh.get(c.id) || []) {
          const sc = v.schema;
          html += `<div style="margin:10px 0 14px"><div class="row between"><div class="item-title">🧭 ${esc(sc.titel || v.title)}</div><button class="btn ghost small" data-orig="${b.fileId}|${v.page}">Originalgrafik (S. ${esc(v.label)})</button></div>
            ${sc.einleitung ? `<div class="small muted">${enrich(esc(sc.einleitung))}</div>` : ''}
            <ol style="padding-left:20px">${(sc.schritte || []).map(st => stepHtml(st)).join('')}</ol>
            ${(sc.hinweise || []).length ? `<div class="notice small">${sc.hinweise.map(h => '✓ ' + enrich(esc(h))).join('<br>')}</div>` : ''}</div>`;
        }
        const ts = c.summary?.schemata || [];
        if (ts.length) html += `<details ${byCh.has(c.id) ? '' : 'open'}><summary class="small">Prüfungsschemata aus dem Text (${ts.length})</summary>${ts.map(x => `<div style="margin:8px 0"><strong class="small">${esc(x.titel || '')}</strong><ol class="small" style="padding-left:20px">${(x.schritte || []).map(st => `<li>${enrich(esc(String(st).replace(/^\d+\.\s*/, '')))}</li>`).join('')}</ol></div>`).join('')}</details>`;
        html += `</div>`;
      }
    }
    el.innerHTML = html;
    el.querySelector('#sbook').onchange = e => { state.book = e.target.value; draw(); };
  };
  el.onclick = async e => {
    const o = e.target.closest('[data-orig]');
    if (o) {
      const [fid, page] = o.dataset.orig.split('|');
      const card = openModal(`<div class="row between"><h3 style="margin:0">Originalgrafik</h3><button class="btn ghost small" data-close>✕</button></div><div id="origimg">${busy('Lade die Seite aus dem Lehrbuch …')}</div>`, c => c.querySelector('[data-close]').onclick = closeModal);
      try {
        const { downloadFile } = await import('./drive.js'); const { renderPdfPages } = await import('./extract.js');
        const f = sub.files[fid];
        const dl = await downloadFile({ id: fid, mimeType: f?.mimeType || 'application/pdf', name: f?.name });
        const img = await renderPdfPages(dl.buffer, [+page], { scale: 2, quality: 0.85 });
        card.querySelector('#origimg').innerHTML = `<img src="data:image/jpeg;base64,${img[page]}" style="width:100%;border-radius:8px">`;
      } catch (err) { card.querySelector('#origimg').innerHTML = errorBox(err); }
      return;
    }
    if (e.target.closest('[data-a=allvis]')) {
      const btn = e.target.closest('button'); btn.disabled = true; btn.textContent = 'Suche Grafiken und berechne Kosten …';
      const books = sub.books.filter(b => bookRole(b) === 'stoff' && b.chapters?.length && !b.batch);
      let n = 0, usd = 0; const todo = [];
      for (const b of books) { try { const t = await getFileText(sub, b.fileId); const est = await visualsEstimate(b, t.pages); if (est.n) { todo.push(b); n += est.n; usd += est.usd; } } catch (err) { console.warn(err); } }
      if (!n) { toast('Keine neuen Visualisierungen gefunden.'); draw(); return; }
      const ok = await confirmDialog(`${n} Visualisierungen in ${todo.length} Büchern einlesen und um das Sonderwissen ergänzen – einmalig ca. ${usd.toLocaleString('de-AT', { minimumFractionDigits: 2 })} $ (Hintergrund-Modus, halber Preis). Danach kostenlos verfügbar.`, 'Ja, einlesen');
      if (!ok) { draw(); return; }
      for (const b of todo) runJob('vis:' + b.fileId, `Falllösungsschemata aus „${b.title}“`, st => buildVisuals(sub.id, b.fileId, st), { subId: sub.id });
      setTimeout(draw, 1500);
    }
  };
  draw();
}

// ---------- Lehrbuch / Stoffgebiete ----------
function tabStoff(el, sub) {
  const prog = store.state.progress.chapters;
  if (!sub.books.length) { el.innerHTML = `<div class="card empty">Noch keine Lehrbücher. Wähle den Lehrbuch-Ordner unter <a href="#/fach/${sub.id}/bearbeiten">Fach bearbeiten</a>.</div>`; return; }
  const exam = activeExams(sub)[0];
  const roleOrder = { stoff: 0, faelle: 1, nachschlag: 2, aus: 3 };
  const books = [...sub.books].sort((a, b) => roleOrder[bookRole(a)] - roleOrder[bookRole(b)]);
  const romanV = t => { const m = String(t).match(/^Zivilrecht\s+([IVX]+)\b/); if (!m) return 99; const v = { I: 1, V: 5, X: 10 }; let n = 0; const r = m[1]; for (let i = 0; i < r.length; i++) { const a = v[r[i]], b2 = v[r[i + 1]] || 0; n += a < b2 ? -a : a; } return n; };
  const navBooks = books.filter(b => bookRole(b) !== 'aus' && !(bookRole(b) === 'stoff' && !b.chapters.some(c => c.summary) && books.some(o => o !== b && o.title === b.title && o.chapters.some(c => c.summary))))
    .sort((a, b) => roleOrder[bookRole(a)] - roleOrder[bookRole(b)] || romanV(a.title) - romanV(b.title));
  const shortT = t => { const m = String(t).match(/^Zivilrecht\s+([IVX]+)\b/); return m ? 'ZR ' + m[1] : String(t).replace(/\s+–.*$/, '').slice(0, 28); };
  el.innerHTML = `<div class="card" style="position:sticky;top:0;z-index:5;padding:10px 12px"><div class="row" style="gap:6px;flex-wrap:wrap">${navBooks.map(b => `<button class="tab" data-goto="${b.fileId}">${bookRole(b) === 'faelle' ? '📝' : bookRole(b) === 'stoff' ? '📘' : '📖'} ${esc(shortT(b.title))}</button>`).join('')}</div></div>
  <div class="notice small">Leg pro Buch fest, wofür es da ist: <strong>Lernstoff</strong> wird zusammengefasst und abgefragt, <strong>Fallsammlung</strong>: Fälle samt Buchlösung werden herausgelöst und den Lehrbuchkapiteln zugeordnet, <strong>Nachschlagewerk</strong> (z. B. Gesetzestext) wird nur eingelesen, damit du Paragraphen antippen kannst, <strong>Nicht verwenden</strong> wird ignoriert. Welche Bücher zu welcher Prüfung gehören, stellst du im Lernplan der Prüfung ein.</div>` + books.map(b => {
    const job = jobs.get('book:' + b.fileId);
    const role = bookRole(b);
    const done = b.chapters.filter(c => c.summary).length;
    const roleSel = `<select data-role="${b.fileId}" style="width:auto;min-height:34px;padding:4px 8px;font-size:.85rem"><option value="stoff" ${role === 'stoff' ? 'selected' : ''}>📘 Lernstoff</option><option value="faelle" ${role === 'faelle' ? 'selected' : ''}>📝 Fallsammlung</option><option value="nachschlag" ${role === 'nachschlag' ? 'selected' : ''}>📖 Nachschlagewerk</option><option value="aus" ${role === 'aus' ? 'selected' : ''}>⛔ Nicht verwenden</option></select>`;
    if (role === 'faelle') {
      const nCases = b.chapters.reduce((a, c) => a + (c.cases?.length || 0), 0);
      const doneF = b.chapters.filter(c => c.cases).length;
      return `<div class="card" id="buch-${b.fileId}"><div class="row between"><div><div class="item-title">📝 ${esc(b.title)} <button class="btn ghost small" data-rename="${b.fileId}" title="Umbenennen">✎</button></div><div class="small muted">Fallsammlung · ${nCases} Fälle aus ${doneF} von ${b.chapters.length} Abschnitten${job && !job.done ? ' · wird verarbeitet …' : ''}</div></div><div class="row">${roleSel}</div></div>${bookAction(b, job)}${bookNotes(b, sub)}
        ${b.chapters.length ? chapterPreviewList(sub, b) : ''}
        ${nCases ? `<a class="btn secondary small" href="#/fach/${sub.id}/falltraining" style="margin-top:8px">Fälle ansehen und lösen</a>` : ''}</div>`;
    }
    if (role !== 'stoff') return `<div class="card" id="buch-${b.fileId}" style="${role === 'aus' ? 'opacity:.6' : ''}"><div class="row between"><div><div class="item-title">${role === 'aus' ? '⛔' : '📖'} ${esc(b.title)} <button class="btn ghost small" data-rename="${b.fileId}" title="Umbenennen">✎</button></div><div class="small muted">${role === 'aus' ? (b.dupOf ? `ältere Auflage von „${esc(sub.books.find(x => x.fileId === b.dupOf)?.title || '')}“ – wird nicht verwendet` : 'wird nicht verwendet') : b.status === 'nachschlagbar' ? 'eingelesen – Paragraphen können darin nachgeschlagen werden' : job && !job.done ? 'wird eingelesen …' : 'wird beim nächsten Durchlauf eingelesen'}</div></div>${roleSel}</div></div>`;
    return `<div class="card" id="buch-${b.fileId}"><div class="row between"><div><div class="item-title">📘 ${esc(b.title)} <button class="btn ghost small" data-rename="${b.fileId}" title="Umbenennen">✎</button></div>${b.authors?.length ? `<div class="small">${esc(b.authors.join(' / '))}${b.edition ? ' · ' + esc(b.edition) : ''}</div>` : ''}<div class="small muted">${b.numPages ? b.numPages + ' Seiten · ' : ''}${b.chapters.length} Kapitel · ${done} zusammengefasst${b.status === 'pausiert' ? ' · angehalten' : ''}</div></div>
      <div class="row">${roleSel}</div></div>${bookAction(b, job)}${bookNotes(b, sub)}
      ${b.chapters.some(c => c.summary) ? `<div style="margin-top:8px"><a class="btn secondary small" href="#/fach/${sub.id}/skript/${b.fileId}">📄 Falllösungs-Skript zum ganzen Buch</a></div>` : ''}
      ${b.error ? `<div class="notice err small">${esc(b.error)}</div>` : ''}
      <ul class="list">${b.chapters.map(c => {
        const p = prog[c.id];
        const scope = exam?.scopeMap?.[c.id];
        if (!isStudyChapter(c)) return `<li><a class="item" href="#/fach/${sub.id}/kapitel/${c.id}" style="opacity:.55"><span class="dot"></span><div style="flex:1"><div>${esc(c.title)}</div><div class="tiny muted">kein Lernstoff – ausgeblendet</div></div><span class="chev">›</span></a></li>`;
        return `<li><a class="item" href="#/fach/${sub.id}/kapitel/${c.id}"><span class="dot ${ampel(p?.mastery || 0, p?.assessed)}"></span>
          <div style="flex:1"><div>${esc(c.title)}</div><div class="tiny muted">S. ${esc(c.startLabel || c.startPage)}–${esc(c.endLabel || c.endPage)}${p?.assessed ? ` · ${Math.round(p.mastery * 100)} %${p.levels?.basis != null ? ` (Basis ${Math.round(p.levels.basis * 100)} %)` : ''}` : ''}${scope ? ` · ${PRIO_LABEL[scope]}` : ''}${c.summary ? '' : ' · noch nicht zusammengefasst'}</div>${!c.summary && c.preview ? `<div class="tiny muted" style="font-style:italic">„${esc(c.preview.slice(0, 140))} …“</div>` : ''}</div><span class="chev">›</span></a></li>`;
      }).join('')}</ul></div>`;
  }).join('') + `<p class="tiny muted">Ampel: grün = sitzt, gelb = teilweise, rot = Lücken, grau = noch nicht eingestuft.</p>`;
  el.querySelectorAll('[data-goto]').forEach(btn => btn.onclick = () => { const t = el.querySelector('#buch-' + CSS.escape(btn.dataset.goto)); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' }); });
  el.querySelectorAll('[data-rename]').forEach(btn => btn.onclick = e => {
    e.preventDefault();
    const b = sub.books.find(x => x.fileId === btn.dataset.rename);
    openModal(`<h3 style="margin-top:0">Buch umbenennen</h3><label class="field"><span>Titel</span><input type="text" id="bt" value="${esc(b.title)}"></label>
      <div class="tiny muted" style="margin-bottom:10px">Datei: ${esc(b.fileTitle || b.title)}</div>
      <div class="row" style="justify-content:flex-end"><button class="btn secondary" data-m="c">Abbrechen</button><button class="btn" data-m="ok">Speichern</button></div>`, m => {
      m.querySelector('[data-m=c]').onclick = closeModal;
      m.querySelector('[data-m=ok]').onclick = () => {
        const v = m.querySelector('#bt').value.trim(); if (!v) return;
        store.update(s => { const x = s.subjects.find(y => y.id === sub.id).books.find(y => y.fileId === b.fileId); if (!x.role) x.role = bookRole(x); x.fileTitle = x.fileTitle || x.title; x.title = v; x.titleManual = true; x.titleDetected = true; });
        closeModal(); render();
      };
    });
  });
  el.querySelectorAll('[data-role]').forEach(sel => sel.onchange = () => {
    const fid = sel.dataset.role, role = sel.value;
    store.update(s => { const b = s.subjects.find(x => x.id === sub.id).books.find(x => x.fileId === fid); const before = bookRole(b); b.role = role; b.roleManual = true; if (role !== 'aus') b.dupOf = null;
      if (role === 'nachschlag') { if (b.status !== 'nachschlagbar') b.status = 'neu'; }
      else if (role !== 'aus' && (before !== role || ['nachschlagbar', 'pausiert'].includes(b.status))) b.status = b.chapters?.length ? 'gegliedert' : 'neu'; });
    toast({ aus: 'Wird nicht verwendet – eine laufende Verarbeitung stoppt nach dem aktuellen Kapitel.', nachschlag: 'Nachschlagewerk – wird nur eingelesen, nicht zusammengefasst.', faelle: 'Fallsammlung – Fälle werden herausgelöst und den Lehrbuchkapiteln zugeordnet.', stoff: 'Lernstoff – wird verarbeitet.' }[role], 5000);
    queueProcessing(sub.id);
    render();
  });
  el.querySelectorAll('[data-proc]').forEach(btn => btn.onclick = () => {
    const fid = btn.dataset.proc;
    store.update(s => { const b = s.subjects.find(x => x.id === sub.id).books.find(x => x.fileId === fid); if (['pausiert', 'fehler'].includes(b.status)) b.status = 'gegliedert'; b.error = null; });
    const b = sub.books.find(x => x.fileId === fid);
    runJob('book:' + fid, `„${b.title}“ vorbereiten`, st => processBook(sub.id, fid, st), { subId: sub.id });
    render();
  });
  el.querySelectorAll('[data-approve]').forEach(btn => btn.onclick = async () => {
    const fid = btn.dataset.approve;
    const b = sub.books.find(x => x.fileId === fid);
    const ok = await confirmDialog(`„${b.title}“: ${b.estimate.chapters} Kapitel ${bookRole(b) === 'faelle' ? 'aufbereiten' : 'zusammenfassen'} für ca. ${b.estimate.usd.toLocaleString('de-AT', { minimumFractionDigits: 2 })} $ von deinem Claude-Guthaben?`, 'Ja, starten');
    if (!ok) return;
    store.update(s => { const x = s.subjects.find(y => y.id === sub.id).books.find(y => y.fileId === fid); x.approved = true; x.error = null; });
    runJob('book:' + fid, `„${b.title}“ ${bookRole(b) === 'faelle' ? 'aufbereiten' : 'zusammenfassen'}`, st => processBook(sub.id, fid, st), { subId: sub.id });
    render();
  });
  el.querySelectorAll('[data-pool]').forEach(btn => btn.onclick = async () => {
    const fid = btn.dataset.pool;
    const b = sub.books.find(x => x.fileId === fid);
    btn.disabled = true; btn.textContent = 'Berechne Kosten …';
    let est;
    try { est = poolEstimate(b, (await getFileText(sub, fid)).pages); } catch (e) { toast(e.message, 6000); render(); return; }
    const ok = await confirmDialog(`Fragenpool für ${est.chapters} Kapitel von „${b.title}“ erstellen – einmalig ca. ${est.usd.toLocaleString('de-AT', { minimumFractionDigits: 2 })} $ von deinem Claude-Guthaben (Hintergrund-Modus, halber Preis). Danach kosten Multiple Choice und Einstufung bei diesem Buch nichts mehr.`, 'Ja, erstellen');
    if (!ok) { render(); return; }
    runJob('pool:' + fid, `Fragenpool für „${b.title}“`, st => buildPools(sub.id, fid, st), { subId: sub.id });
    render();
  });
  el.querySelectorAll('[data-cancelbatch]').forEach(btn => btn.onclick = async () => {
    const b = sub.books.find(x => x.fileId === btn.dataset.cancelbatch);
    if (!(await confirmDialog('Hintergrund-Auftrag abbrechen? Bereits fertige Kapitel bleiben erhalten und werden abgeholt.', 'Abbrechen'))) return;
    try { await cancelBatch(b.batch.id); toast('Wird abgebrochen – fertige Kapitel werden gleich abgeholt.'); } catch (e) { toast(e.message, 6000); }
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
    <div class="row" style="margin:6px 0 10px"><span class="dot ${ampel(p?.mastery || 0, p?.assessed)}"></span><span class="small">${p?.assessed ? `Kenntnisstand ${Math.round(p.mastery * 100)} %${p.levels ? ' (' + levelText(p) + ')' : ''}` : 'noch nicht eingestuft'}</span></div>
    ${isStudyChapter(ch) ? '' : `<div class="notice warn small">Dieses Kapitel zählt nicht als Lernstoff (z. B. Verzeichnis oder Übersicht) und kommt in Plan, Einstufung und Tests nicht vor. <button class="btn ghost small" data-vis="show">Doch als Lernstoff zählen</button></div>`}
    ${(() => { const n = sub.rulings.filter(r => ((r.chapterIds || []).includes(chId)) || (!(r.chapterIds || []).length && chaptersByNorm(sub, r).includes(chId))).length; return n ? `<div style="margin:-4px 0 8px"><a class="small" href="#/fach/${subId}/ogh" data-ogh="${chId}">⚖️ ${n} OGH-Rechtssätze zu diesem Kapitel</a></div>` : ''; })()}
    <div class="tabs">${parts.map(([k, l]) => `<a class="tab ${k === part ? 'active' : ''}" href="#/fach/${subId}/kapitel/${chId}/${k}">${l}</a>`).join('')}</div><div id="part"></div>
    ${isStudyChapter(ch) ? `<div class="row" style="margin-top:16px">${(() => { const ex = activeExams(sub)[0]; return ex && ch.summary ? `<a class="btn secondary small" href="#/fach/${subId}/einstufung/${ex.id}/${chId}">${p?.assessed ? 'Kapitel neu einstufen' : 'Dieses Kapitel einstufen'}</a>` : ''; })()}<button class="btn ghost small" data-vis="hide">Kein Lernstoff – Kapitel ausblenden</button></div>` : ''}`;
  el.querySelectorAll('[data-ogh]').forEach(a => a.onclick = () => { oghState[subId] = { ...(oghState[subId] || { filter: 'alle', q: '' }), filter: 'alle', q: '', book: book.fileId, chapter: chId }; });
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
      body.innerHTML = book.batch ? `<div class="notice small">⏳ Dieses Kapitel wird gerade im Hintergrund zusammengefasst (zum halben Preis) und erscheint hier automatisch, sobald es fertig ist – meist innerhalb einer Stunde. Bis dahin kannst du im Reiter <strong>Lehrbuchtext</strong> lesen oder ein schon fertiges Kapitel lernen.</div>`
        : job && !job.done ? busy('Das Lehrbuch wird gerade verarbeitet …') : `<div class="card">Noch keine Zusammenfassung. <button class="btn small" data-a="sum">Jetzt erstellen</button></div>`;
    } else {
      body.innerHTML = `<div class="card"><h3>Worum geht es?</h3>${md(s.kurzfassung)}</div>
      ${(s.themen || []).map(t => `<details class="card" open><summary>${esc(t.titel)} <span class="cite">${esc(t.seiten || '')}</span> ${String(t.ebene || '').startsWith('vert') ? '<span class="pill gold">Vertiefung</span>' : ''}</summary>${md(t.inhalt)}</details>`).join('')}
      ${s.definitionen?.length ? `<div class="card"><h3>Definitionen</h3><ul class="list">${s.definitionen.map(d => `<li><strong>${esc(d.begriff)}</strong> ${String(d.ebene || '').startsWith('vert') ? '<span class="pill gold">Vertiefung</span> ' : ''}${d.seite ? `<span class="cite">[S. ${esc(String(d.seite).replace(/^S\.?\s*/, ''))}]</span>` : ''}<div class="small">${enrich(esc(d.definition))}</div></li>`).join('')}</ul></div>` : ''}
      ${s.schemata?.length ? `<div class="card"><h3>Prüfungsschemata</h3>${s.schemata.map(sc => `<h4>${esc(sc.titel)}</h4><ol>${(sc.schritte || []).map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ol>`).join('')}</div>` : ''}
      ${s.stolperfallen?.length ? `<div class="card" style="border-color:var(--hl)"><h3>⚠ Stolperfallen</h3><ul>${s.stolperfallen.map(x => `<li>${enrich(esc(x.text || x))} ${x.seite ? `<span class="cite">[S. ${esc(String(x.seite).replace(/^S\.?\s*/, ''))}]</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${s.normen?.length ? `<div class="card"><h3>Normen</h3>${s.normen.map(n => `<span class="pill blue" style="margin:2px">${enrich(esc(n))}</span>`).join(' ')}</div>` : ''}
      ${s.entscheidungen?.length ? `<div class="card"><h3>Im Kapitel zitierte Entscheidungen</h3><div class="row">${s.entscheidungen.map(g => `<button class="btn secondary small" data-gz="${esc(g)}">${esc(g)}</button>`).join('')}</div><p class="tiny muted">Antippen: Entscheidung im RIS öffnen und aufbereiten lassen.</p></div>` : ''}
      ${(() => {
        const all = collectionCases(sub);
        const rel = all.filter(x => (x.fall.kapitelIds || []).includes(chId) || (x.fall.aussagen || []).some(a => a.kapitelId === chId));
        const st = all.flatMap(x => (x.fall.aussagen || []).filter(a => a.kapitelId === chId).map(a => ({ ...a, src: x })));
        if (!rel.length && !st.length) return '';
        return `<div class="card"><h3>📝 Aus deinen Fallsammlungen</h3>
          ${st.length ? `<h4>Das zeigen die Falllösungen zu diesem Kapitel</h4><ul>${st.slice(0, 25).map(a => `<li>${enrich(esc(a.aussage))} ${String(a.ebene || '').startsWith('vert') ? '<span class="pill gold">Vertiefung</span>' : ''}<span class="tiny muted"> – ${esc(a.src.fall.titel || '')}</span></li>`).join('')}</ul>` : ''}
          ${rel.length ? `<h4>Fälle zu diesem Kapitel</h4><ul class="list">${rel.slice(0, 20).map(x => `<li><a class="item" href="#/fach/${subId}/fall/${encodeURIComponent('fs:' + x.book.fileId + ':' + x.chapter.id + ':' + x.idx)}"><div style="flex:1"><div>${esc(x.fall.titel || 'Fall')}</div><div class="tiny muted">${esc(x.book.title)}${x.fall.schwierigkeit ? ' · ' + esc(x.fall.schwierigkeit) : ''}</div></div><span class="chev">lösen ›</span></a></li>`).join('')}</ul>` : ''}</div>`;
      })()}
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
      system: async () => `Du besprichst mit der Studentin das Lehrbuchkapitel „${ch.title}“ aus „${book.title}“. Beantworte Fragen ausschließlich auf Grundlage dieses Kapiteltexts mit Seitenangaben. Wenn sie dich bittet, sie abzufragen, stelle eine Frage nach der anderen, warte auf ihre Antwort und gib dann Feedback.\n\nKAPITELTEXT:\n${clip(await chapterText(store.subject(subId), chId), 100000)}`,
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
        for (const c of chs.slice(0, 2)) lb += `\n\n### Lehrbuchkapitel „${c.chapter.title}“\n` + (await chapterText(store.subject(subId), c.chapter.id)).slice(0, 40000);
        return `Du diskutierst mit der Studentin die Lehrveranstaltungseinheit „${ref.title}“. Grundlage sind das Transkript und die zugehörigen Lehrbuchkapitel. Unterscheide klar, was aus der Einheit und was aus dem Lehrbuch stammt.\n\nTRANSKRIPT:\n${t.text.slice(0, 120000)}${lb ? '\n\nLEHRBUCH:' + lb : ''}`;
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
    ${(() => {
      const fs = collectionCases(sub);
      if (!fs.length) return '';
      const byBook = {};
      fs.forEach(x => { (byBook[x.book.title] = byBook[x.book.title] || []).push(x); });
      return `<div class="card"><h3>📝 Fälle aus deinen Fallsammlungen</h3><p class="small muted">Mit der Lösung aus dem Buch als Maßstab für die Korrektur.</p>${Object.entries(byBook).map(([t, list]) => `<details><summary>${esc(t)} (${list.length})</summary><ul class="list">${list.map(x => `<li><a class="item" href="#/fach/${sub.id}/fall/${encodeURIComponent('fs:' + x.book.fileId + ':' + x.chapter.id + ':' + x.idx)}"><div style="flex:1"><div>${esc(x.fall.titel || 'Fall')}</div><div class="tiny muted">${(x.fall.kapitelIds || []).map(id => findChapter(sub, id)?.chapter.title).filter(Boolean).map(esc).join(' · ')}${x.fall.schwierigkeit ? ' · ' + esc(x.fall.schwierigkeit) : ''}</div></div><span class="chev">›</span></a></li>`).join('')}</ul></details>`).join('')}</div>`;
    })()}
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
const oghState = {};
function tabOgh(el, sub) {
  const state = oghState[sub.id] ||= { filter: 'alle', q: '', book: '', chapter: '' };
  if (sub.rulings.some(r => r.source === 'ris' && !r.kind)) store.update(s => migrateRulings(s.subjects.find(x => x.id === sub.id)), { silent: true });
  sub = store.subject(sub.id);
  const citedAll = new Map();
  for (const b of sub.books) for (const [gz, n] of b.citations?.gz || []) citedAll.set(gz, (citedAll.get(gz) || 0) + n);
  const meta = sub.rulingMeta || {};
  const chs = allChapters(sub);
  const chById = new Map(chs.map(c => [c.id, c]));
  const books = sub.books.filter(b => bookRole(b) === 'stoff' && b.chapters?.length);
  const chaptersOf = r => { const ok = (r.chapterIds || []).filter(id => chById.has(id)); return ok.length ? ok : chaptersByNorm(sub, r); };
  const pending = sub.rulings.filter(r => r.source === 'ris' && ((r.head == null && r.rsDocs?.length) || ((r.head || r.schlagworte) && !r.classified))).length;
  const prepJob = () => jobs.get('oghprep:' + sub.id);
  const startPrep = () => runJob('oghprep:' + sub.id, `OGH-Urteile für „${sub.name}“ aufbereiten`, st => prepareRulings(sub.id, st), { subId: sub.id });
  if (pending && !prepJob() && !state.autoStarted) { state.autoStarted = true; startPrep(); }

  const title = r => r.source === 'upload' ? '📄 ' + esc(r.title || r.gz)
    : r.kind === 'rs' ? `${esc(r.rsNr || 'Rechtssatz')} <span class="tiny muted" style="font-weight:400">· ${r.gzList?.length > 1 ? `${r.gzList.length} Entscheidungen, zuletzt ${esc(r.gz)}` : 'OGH ' + esc(r.gz)}</span>`
    : 'OGH ' + esc(r.gz);
  const draw = () => {
    sub = store.subject(sub.id);
    let list = [...sub.rulings];
    if (state.filter === 'neu') list = list.filter(r => r.isNew);
    if (state.filter === 'eigene') list = list.filter(r => r.source === 'upload');
    if (state.filter === 'zitiert') list = list.filter(r => r.cited);
    if (state.book) { const ids = new Set(sub.books.find(b => b.fileId === state.book)?.chapters.map(c => c.id) || []); list = list.filter(r => chaptersOf(r).some(id => ids.has(id))); }
    if (state.chapter) list = list.filter(r => chaptersOf(r).includes(state.chapter));
    if (state.q) { const q = state.q.toLowerCase(); list = list.filter(r => [r.gz, r.rsNr, r.title, r.head, r.schlagworte, (r.tags || []).join(' '), (r.normen || []).join(' '), r.summary?.kernaussagen?.join(' ')].join(' ').toLowerCase().includes(q)); }
    list.sort((a, b) => (b.gzList?.length || 1) - (a.gzList?.length || 1) || (b.date || '').localeCompare(a.date || ''));
    const citedNotAdded = state.filter === 'zitiert' ? [...citedAll.entries()].filter(([gz]) => !sub.rulings.some(r => (r.gzList || [r.gz]).some(g => g && g.replace(/\s+/g, '') === gz.replace(/\s+/g, '')))).sort((a, b) => b[1] - a[1]) : [];
    const job = jobs.get('ogh:' + sub.id), pj = prepJob();
    const bookChs = state.book ? (sub.books.find(b => b.fileId === state.book)?.chapters || []).filter(isStudyChapter) : [];
    // Anzahl je Kapitel für die Auswahlliste
    const perCh = new Map();
    for (const r of sub.rulings) for (const id of chaptersOf(r)) perCh.set(id, (perCh.get(id) || 0) + 1);
    const perBook = b => sub.rulings.filter(r => chaptersOf(r).some(id => b.chapters.some(c => c.id === id))).length;
    const item = r => {
      const cids = chaptersOf(r);
      const tags = (r.tags?.length ? r.tags : (r.schlagworte ? r.schlagworte.split(/[;,]\s*/).slice(0, 4) : [])).filter(Boolean);
      const sub2 = r.head || r.summary?.kernaussagen?.[0] || (r.normen || []).slice(0, 4).join(', ');
      return `<li><a class="item" href="#/fach/${sub.id}/urteil/${encodeURIComponent(r.id)}"><div style="flex:1;min-width:0"><div class="item-title">${title(r)} ${r.isNew ? '<span class="pill gold">neu</span>' : ''} ${r.cited ? '<span class="pill blue">im Lehrbuch</span>' : ''}</div>
        ${tags.length ? `<div style="margin:4px 0">${tags.map(t => `<span class="pill">${esc(t)}</span>`).join(' ')}</div>` : ''}
        <div class="small" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(String(sub2).slice(0, 400))}</div>
        <div class="tiny muted" style="margin-top:3px">${cids.map(id => chById.get(id)).filter(Boolean).map(c => '📘 ' + esc(c.title)).join(' · ') || 'noch keinem Kapitel zugeordnet'}${(r.normen || []).length ? ' · ' + esc(r.normen.slice(0, 3).join(', ')) : ''}</div></div><span class="chev">›</span></a></li>`;
    };
    el.innerHTML = `<div class="card"><div class="row between"><div class="small muted">${meta.lastCheck ? 'Zuletzt im RIS gesucht: ' + fmtDate(meta.lastCheck) + ` · anhand von ${meta.norms?.length || 0} Normen aus deinen Lehrbüchern` : 'Noch nicht im RIS gesucht.'}</div>
      <button class="btn small" data-a="check" ${job && !job.done ? 'disabled' : ''}>${job && !job.done ? '<span class="spinner"></span> sucht …' : 'Neue Urteile suchen'}</button></div>
      ${pj && !pj.done ? `<div class="small muted" style="margin-top:6px"><span class="spinner"></span> ${esc(pj.status || 'bereite auf …')}</div>` : ''}
      <p class="tiny muted">Ein Eintrag = ein Rechtssatz (der Leitsatz des OGH) samt allen Entscheidungen, die ihn anwenden. Je mehr Entscheidungen, desto gefestigter die Rechtsprechung – solche stehen oben. Ergänzung, kein Lehrbuchstoff. Quelle: RIS (Bundeskanzleramt), CC BY 4.0.</p></div>
      <div class="row" style="gap:8px;margin-bottom:8px">
        <select id="fbook" style="flex:1;min-width:160px"><option value="">Alle Bücher</option>${books.map(b => `<option value="${b.fileId}" ${state.book === b.fileId ? 'selected' : ''}>${esc(b.title)} (${perBook(b)})</option>`).join('')}</select>
        ${state.book ? `<select id="fch" style="flex:1;min-width:160px"><option value="">Alle Kapitel</option>${bookChs.map(c => `<option value="${c.id}" ${state.chapter === c.id ? 'selected' : ''}>${esc(c.title)} (${perCh.get(c.id) || 0})</option>`).join('')}</select>` : ''}
      </div>
      <div class="tabs">${[['alle', 'Alle'], ['neu', 'Neu'], ['zitiert', 'Im Lehrbuch zitiert'], ['eigene', 'Eigene Uploads']].map(([k, l]) => `<button class="tab ${state.filter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
      <input type="text" id="q" placeholder="Suchen (Schlagwort, Norm, GZ, RS-Nummer) …" value="${esc(state.q)}" style="margin-bottom:12px">
      <div class="tiny muted" style="margin-bottom:6px">${list.length} Einträge</div>
      <div class="card"><ul class="list">${list.slice(0, 300).map(item).join('') || '<li class="muted small">Keine Einträge.</li>'}</ul></div>
      ${citedNotAdded.length ? `<div class="card"><h3>Im Lehrbuch zitiert, noch nicht geladen</h3><p class="tiny muted">Je öfter zitiert, desto wichtiger. Antippen zum Laden.</p><div class="row">${citedNotAdded.slice(0, 80).map(([gz, n]) => `<button class="btn secondary small" data-gz="${esc(gz)}">${esc(gz)} <span class="tiny">(${n}×)</span></button>`).join('')}</div></div>` : ''}`;
    el.querySelector('#q').oninput = e => { state.q = e.target.value; clearTimeout(el._t); el._t = setTimeout(() => { draw(); const q = el.querySelector('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 350); };
    el.querySelector('#fbook').onchange = e => { state.book = e.target.value; state.chapter = ''; draw(); };
    const fch = el.querySelector('#fch'); if (fch) fch.onchange = e => { state.chapter = e.target.value; draw(); };
  };
  el.onclick = async e => {
    const f = e.target.closest('[data-f]'); if (f) { state.filter = f.dataset.f; draw(); return; }
    if (e.target.closest('[data-a=check]')) { runJob('ogh:' + sub.id, `Suche neue OGH-Urteile für „${sub.name}“`, st => checkNewRulings(sub.id, st).then(n => { toast(n ? `${n} neue Einträge gefunden` : 'Keine neuen Entscheidungen'); startPrep(); }), { subId: sub.id }); draw(); return; }
    const gz = e.target.closest('[data-gz]')?.dataset.gz;
    if (gz) { toast('Suche ' + gz + ' im RIS …'); try { const r = await addCitedRuling(sub.id, gz); location.hash = `#/fach/${sub.id}/urteil/${encodeURIComponent(r.id)}`; } catch (err) { toast(err.message, 6000); } }
  };
  draw();
  // Fortschritt der Aufbereitung live anzeigen
  clearInterval(el._poll);
  el._poll = setInterval(() => { if (!document.body.contains(el)) return clearInterval(el._poll); const pj = prepJob(); if (pj && !pj.done) draw(); else if (el._wasRunning) { el._wasRunning = false; draw(); } if (pj && !pj.done) el._wasRunning = true; }, 4000);
}

export function rulingView(el, subId, rid, part = 'kern') {
  const sub = store.subject(subId);
  const r = sub?.rulings.find(x => x.id === rid);
  if (!r) return notFound(el);
  setTitle(r.source === 'upload' ? (r.title || 'Urteil') : r.kind === 'rs' && r.rsNr ? r.rsNr : 'OGH ' + r.gz);
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
  el.innerHTML = `<div class="card"><div class="row between"><div><div class="item-title">${esc(sub.name)} · ${esc(exam.name)}</div><div class="small muted">${exam.date ? fmtDate(exam.date) : 'kein Termin'} · ${exam.hoursPerDay} h pro Lerntag</div></div><span class="pill ${cls}">${{ gut: 'Sehr gut erreichbar', knapp: 'Fälle sicher', eng: 'priorisiert', offen: 'offen', vorbei: 'vorbei' }[plan.status]}</span></div>
    <p>${esc(plan.message)}</p>
    <div class="grid3"><div class="stat"><div class="num">${Math.round(plan.readiness * 100)} %</div><div class="lbl">Prüfungsreife (Ziel Sehr gut)</div></div><div class="stat"><div class="num">${fmtMin(plan.need)}</div><div class="lbl">Lernaufwand bis Sehr gut</div></div><div class="stat"><div class="num">${isFinite(plan.available) ? fmtMin(plan.available) : '–'}</div><div class="lbl">Lernzeit bis zur Prüfung</div></div><div class="stat"><div class="num">${plan.studyDays ?? '–'}</div><div class="lbl">Lerntage</div></div></div>
    ${plan.hoursSehrGut != null && isFinite(plan.available) ? `<div class="card" style="background:var(--bg);margin-top:12px"><h4 style="margin-top:0">Empfohlene Lernzeit pro Lerntag</h4>
      <div class="row between small"><span>🏆 für ein <strong>Sehr gut</strong></span><strong>ca. ${(Math.ceil(plan.hoursSehrGut * 2) / 2).toLocaleString('de-AT')} h</strong></div>
      <div class="row between small" style="margin-top:4px"><span>✅ um <strong>Fälle sicher zu lösen</strong></span><strong>ca. ${(Math.ceil(plan.hoursFaelle * 2) / 2).toLocaleString('de-AT')} h</strong></div>
      <div class="row between small" style="margin-top:4px"><span>derzeit eingeplant</span><strong>${exam.hoursPerDay} h</strong></div>
      ${Math.ceil(plan.hoursSehrGut * 2) / 2 !== Number(exam.hoursPerDay) ? `<button class="btn secondary small" style="margin-top:8px" data-hours="${Math.max(0.5, Math.ceil(plan.hoursSehrGut * 2) / 2)}">Auf ${(Math.max(0.5, Math.ceil(plan.hoursSehrGut * 2) / 2)).toLocaleString('de-AT')} h pro Lerntag stellen</button>` : ''}
      <p class="tiny muted" style="margin:6px 0 0">Die Empfehlung sinkt, sobald du Einstufung und Tests machst – die App rechnet dann nur noch mit dem, was dir wirklich fehlt.</p>
      <p class="small" style="margin:8px 0 0">⏱ ${esc(paceText(plan.pace))}</p></div>` : ''}
    <details style="margin-top:10px"><summary class="small">So rechnet die App</summary><div class="small">
      <p><strong>Verfügbare Zeit:</strong> alle Tage ab heute bis zum Tag vor der Prüfung, nur an deinen Lerntagen (${(exam.studyDays || []).map(d => ['So','Mo','Di','Mi','Do','Fr','Sa'][d]).join(', ')}). Abgezogen werden Feiertage und alle Einträge im <a href="#/kalender">Lernkalender</a>${plan.offDays ? ` – derzeit <strong>${plan.offDays} Tag(e)</strong>: ${plan.offList.slice(0, 8).map(o => `${o.icon} ${fmtDate(o.date)}`).join(', ')}${plan.offList.length > 8 ? ' …' : ''}` : ''}. Das ergibt ${plan.studyDays ?? '–'} Lerntage × ${exam.hoursPerDay} h. Davon bleiben 10 % als Puffer für die Schlusswiederholung.</p>
      <p><strong>Ziel:</strong> Für ein <strong>Sehr gut</strong> soll das Basiswissen zu 90 % sitzen (bei „nur wenn Zeit“-Kapiteln 75 %), das Vertiefungswissen zu 75 % bei „muss sitzen“, 60 % bei „wichtig“ und 30 % bei „nur wenn Zeit“. Für <strong>„Fälle sicher lösen“</strong> reichen Basis 80–85 % und Vertiefung 20–40 % – das ist das Mindestziel, das der Plan absichert, wenn die Zeit knapp ist.</p>
      <p><strong>Nötige Zeit:</strong> pro Kapitel die geschätzte Lernzeit aus der Zusammenfassung (sonst ca. 6 Min. pro Seite), bei schriftlichen Prüfungen +25 % fürs Falltraining. Davon entfallen ca. zwei Drittel auf Basis-, ein Drittel auf Vertiefungswissen. Was du laut Einstufung, Tests und Fällen schon kannst, wird abgezogen.</p>
      <p><strong>Wichtigkeit eines Kapitels:</strong> aus der Stoffeingrenzung (muss sitzen / wichtig / nur wenn Zeit), wie oft es in Altklausuren vorkommt, wie viele Fälle deiner Fallsammlungen es betreffen, ob es in der Lehrveranstaltung betont wurde und ob es ein Prüfungsschema enthält. Ohne Stoffeingrenzung gilt jedes Kapitel als „wichtig“.</p>
      <p><strong>Persönliches Lerntempo:</strong> Die App misst, wie lange du in den Kapiteln eines Fachs lernst (Zusammenfassung, Tests, Karten, Chat, Falltraining) und wie stark dein Kenntnisstand seit dem Einstufungstest dabei steigt. Brauchst du in diesem Fach weniger Zeit als geschätzt, sinkt der Aufwand für alle restlichen Kapitel – brauchst du mehr, steigt er. Das wird pro Fach getrennt gerechnet und wiegt umso stärker, je mehr Lernzeit gemessen wurde.</p>
      <p><strong>Prüfungsreife:</strong> wie nah du insgesamt am Sehr-gut-Ziel bist, gewichtet nach dem Umfang der Kapitel.</p>
      <p>Noch nicht zusammengefasste Kapitel werden grob nach Seitenzahl geschätzt – die Rechnung wird genauer, sobald alle Lehrbücher verarbeitet sind.</p></div></details>
    <div class="row" style="margin-top:8px"><a class="btn secondary small" href="#/kalender">📅 Lernkalender: freie Tage, Krankheit, Schließtage</a></div></div>

  ${!exam.scopeMap && !Array.isArray(exam.bookIds) ? `<div class="notice warn small"><strong>Tipp:</strong> Im Moment zählen <strong>alle</strong> Lernstoff-Bücher vollständig als Prüfungsstoff. Hak unten nur die Bücher dieser Prüfung an und füg die Stoffeingrenzung ein – dann wird die Berechnung deutlich realistischer.</div>` : ''}
  <div class="card"><h3>Bücher für diese Prüfung</h3>
    <p class="small muted">Nur diese Bücher zählen für Lernplan, Einstufung und Tests dieser Prüfung. Die anderen bleiben für andere Prüfungen erhalten.</p>
    ${sub.books.filter(b => bookRole(b) === 'stoff').map(b => `<label class="checkline small"><input type="checkbox" data-book="${b.fileId}" ${bookInExam(b, exam) ? 'checked' : ''}> ${esc(b.title)}</label>`).join('') || '<p class="small muted">Noch keine Lernstoff-Bücher.</p>'}
  </div>

  <div class="card"><h3>Stoffeingrenzung</h3>
    ${exam.scopeMap ? `<div class="notice ok small">Eingrenzung ist den Kapiteln zugeordnet. Du kannst jede Zuordnung unten ändern.</div>${exam.scopeNotes ? md(exam.scopeNotes) : ''}` : '<p class="small muted">Ohne Eingrenzung gilt der gesamte Lehrbuchstoff.</p>'}
    ${scopeFiles.length ? `<div class="small">Dateien für diese Prüfung:</div>${scopeFiles.map(f => `<label class="checkline small"><input type="checkbox" data-scopefile="${f.id}" ${exam.scopeFileIds?.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')}` : ''}
    <label class="field"><span>oder Eingrenzung hier hineinkopieren</span><textarea id="scopeText" placeholder="z. B. „Prüfungsstoff: Allgemeiner Teil, Schuldrecht AT, Gewährleistung, Schadenersatz …“">${esc(exam.scopeText || '')}</textarea></label>
    <div class="row"><button class="btn small" data-a="scope">Eingrenzung anwenden</button>${exam.scopeMap ? '<button class="btn ghost small" data-a="noscope">Eingrenzung entfernen</button>' : ''}</div></div>

  ${groups.map(([g, l]) => { const items = plan.chapters.filter(c => c.plan === g); return items.length ? `<div class="card"><h3>${l} <span class="muted small">(${items.length})</span></h3><ul class="list">${items.map(c => `<li><div class="row"><span class="dot ${ampel(c.mastery, c.assessed)}"></span><a href="#/fach/${subId}/kapitel/${c.id}" style="flex:1;text-decoration:none;color:inherit"><div>${esc(c.title)}</div><div class="tiny muted">${c.levels ? `Basis ${Math.round((c.levels.basis || 0) * 100)}/${Math.round(c.target.basis * 100)} % · Vertiefung ${Math.round((c.levels.vertiefung || 0) * 100)}/${Math.round(c.target.vert * 100)} % · ` : c.assessed ? Math.round(c.mastery * 100) + ' % · ' : 'nicht eingestuft · '}noch ca. ${fmtMin(c.remaining)}${c.reasons.length ? ' · ' + c.reasons.map(esc).join(' · ') : ''}</div></a>
    <select data-prio="${c.id}" style="width:auto;min-height:32px;padding:4px 8px;font-size:.8rem">${['muss', 'wichtig', 'optional', 'raus'].map(p => `<option value="${p}" ${c.scope === p ? 'selected' : ''}>${PRIO_LABEL[p]}</option>`).join('')}</select></div></li>`).join('')}</ul></div>` : ''; }).join('')}
  <div class="row"><a class="btn" href="#/fach/${subId}/einstufung/${examId}">Einstufungstest</a><a class="btn secondary" href="#/fach/${subId}/bearbeiten">Termin & Lernzeit ändern</a></div>`;

  el.onchange = e => {
    const bk = e.target.closest('[data-book]');
    if (bk) {
      const ids = [...el.querySelectorAll('[data-book]')].filter(c => c.checked).map(c => c.dataset.book);
      store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.bookIds = ids.length === el.querySelectorAll('[data-book]').length ? null : ids; });
      queueProcessing(subId);
      render(); return;
    }
    const sel = e.target.closest('[data-prio]');
    if (sel) {
      store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); if (!ex.scopeMap) { ex.scopeMap = {}; allChapters(sub).forEach(c => ex.scopeMap[c.id] = 'wichtig'); } ex.scopeMap[sel.dataset.prio] = sel.value; });
      render();
    }
    const sf = e.target.closest('[data-scopefile]');
    if (sf) store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.scopeFileIds = [...el.querySelectorAll('[data-scopefile]')].filter(c => c.checked).map(c => c.dataset.scopefile); }, { silent: true });
  };
  el.onclick = async e => {
    const hb = e.target.closest('[data-hours]');
    if (hb) { store.update(s => { s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId).hoursPerDay = Number(hb.dataset.hours); }); toast('Lernzeit angepasst'); render(); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'scope') {
      store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.scopeText = el.querySelector('#scopeText').value; }, { silent: true });
      const btn = e.target.closest('[data-a]'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ordne zu …';
      try { await mapScope(subId, examId); toast('Eingrenzung angewendet'); render(); } catch (err) { toast(err.message, 6000); btn.disabled = false; btn.textContent = 'Eingrenzung anwenden'; }
    }
    if (a === 'noscope') { store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); ex.scopeMap = null; ex.scopeNotes = ''; }); render(); }
  };
}


// ---------- Falllösungs-Skript: ein Dokument pro Buch ----------
export function skriptView(el, subId, fileId) {
  const draw = () => {
    const sub = store.subject(subId);
    const b = sub?.books.find(x => x.fileId === fileId);
    if (!b) { el.innerHTML = '<div class="card">Buch nicht gefunden.</div>'; return; }
    setTitle('Falllösungs-Skript');
    const chs = b.chapters.filter(isStudyChapter);
    const missing = chs.filter(c => !c.skript).length;
    const running = sub.books.filter(x => x.batch?.kind === 'skript');
    const books = sub.books.filter(x => bookRole(x) === 'stoff' && x.chapters?.some(c => c.summary));
    const allMissing = books.reduce((a, x) => a + x.chapters.filter(c => isStudyChapter(c) && !c.skript).length, 0);
    const cite = x => x?.seite ? ` <span class="cite">[${esc(String(x.seite).replace(/^\[|\]$/g, ''))}]</span>` : '';
    const li = arr => (arr || []).map(x => `<li>${enrich(esc(x.text || x))}${cite(x)}</li>`).join('');
    let html = `<div class="card no-print"><div class="row between"><div><div class="item-title">📄 ${esc(b.title)}</div><div class="small muted">Alles, was du zum Lösen von Fällen brauchst – Kapitel für Kapitel, mit Fußnoten, Rechtsprechung und Beispielen aus dem Buch.</div></div>
      <div class="row"><a class="btn ghost small" href="#/fach/${subId}/stoff">‹ Lehrbuch</a>${!missing ? '<button class="btn secondary small" data-a="print">Drucken / PDF</button>' : ''}</div></div>
      ${running.length ? `<div class="notice small" style="margin-top:8px">⏳ Wird im Hintergrund erstellt: ${running.map(x => esc(x.title)).join(', ')} – erscheint hier automatisch (meist unter einer Stunde).</div>`
        : missing ? `<div class="notice gold small" style="margin-top:8px">Für ${missing} von ${chs.length} Kapiteln gibt es das Skript noch nicht. Es wird einmalig aus dem vollständigen Kapiteltext erstellt (inkl. Fußnoten) – danach kostenlos.<div style="margin-top:6px"><button class="btn small" data-a="make">Skripten für alle Bücher erstellen</button> <span class="tiny muted">${allMissing} Kapitel · Kosten werden vorher angezeigt</span></div></div>` : ''}</div>`;
    html += `<div class="card"><h3 style="margin-top:0">Inhalt</h3><ol class="small" style="padding-left:20px">${chs.map(c => `<li><a href="#" data-jump="${c.id}">${esc(c.title)}</a>${c.skript ? '' : ' <span class="muted">(noch offen)</span>'}</li>`).join('')}</ol></div>`;
    for (const c of chs) {
      const k = c.skript;
      const vis = (b.visuals || []).filter(v => v.chapterId === c.id && v.schema);
      html += `<div class="card skript-ch" id="sk-${c.id}"><h3 style="margin-top:0">${esc(c.title)} <span class="tiny muted">S. ${esc(c.startLabel || '')}–${esc(c.endLabel || '')}</span></h3>`;
      if (!k) { html += `<div class="small muted">Noch nicht erstellt.${c.summary?.kurzfassung ? ' Kurzfassung: ' + enrich(esc(c.summary.kurzfassung)) : ''}</div></div>`; continue; }
      if (k.kernaussage) html += `<p class="small"><strong>Worum es im Fall geht:</strong> ${enrich(esc(k.kernaussage))}</p>`;
      if ((k.anspruchsgrundlagen || []).length) html += `<div class="small"><strong>Anspruchsgrundlagen</strong><ul>${k.anspruchsgrundlagen.map(a => `<li>${enrich(esc(a.norm || ''))} – ${enrich(esc(a.wofuer || ''))}${cite(a)}</li>`).join('')}</ul></div>`;
      if ((k.pruefung || []).length) html += `<div class="small"><strong>Prüfung im Fall</strong><ol style="padding-left:20px">${k.pruefung.map(p => `<li style="margin:6px 0"><strong>${enrich(esc(p.punkt || ''))}</strong>${cite(p)}${(p.voraussetzungen || []).length ? `<ul>${p.voraussetzungen.map(v => `<li>${enrich(esc(v))}</li>`).join('')}</ul>` : ''}${p.details ? `<div>${enrich(esc(p.details))}</div>` : ''}</li>`).join('')}</ol></div>`;
      for (const v of vis) html += `<details class="small"><summary>🧭 Schema aus der Visualisierung: ${esc(v.schema.titel || v.title)}</summary><ol style="padding-left:20px">${(v.schema.schritte || []).map(st => `<li><strong>${enrich(esc(st.schritt || ''))}</strong>${st.erklaerung ? ' – ' + enrich(esc(st.erklaerung)) : ''}</li>`).join('')}</ol></details>`;
      if ((k.klausurfallen || []).length) html += `<div class="small"><strong>⚠️ Klausurfallen</strong><ul>${li(k.klausurfallen)}</ul></div>`;
      if ((k.rechtsprechung || []).length) html += `<div class="small"><strong>⚖️ Rechtsprechung, Fußnoten, Meinungsstreit</strong><ul>${li(k.rechtsprechung)}</ul></div>`;
      if ((k.beispiele || []).length) html += `<div class="small"><strong>💡 Beispiele aus dem Buch</strong><ul>${li(k.beispiele)}</ul></div>`;
      html += `</div>`;
    }
    el.innerHTML = html;
  };
  el.onclick = async e => {
    const j = e.target.closest('[data-jump]');
    if (j) { e.preventDefault(); const t = el.querySelector('#sk-' + CSS.escape(j.dataset.jump)); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 60, behavior: 'smooth' }); return; }
    if (e.target.closest('[data-a=print]')) { window.print(); return; }
    if (e.target.closest('[data-a=make]')) {
      const btn = e.target.closest('button'); btn.disabled = true; btn.textContent = 'Berechne Kosten …';
      const sub = store.subject(subId);
      const books = sub.books.filter(x => bookRole(x) === 'stoff' && x.chapters?.some(c => c.summary) && !x.batch && x.chapters.some(c => isStudyChapter(c) && !c.skript));
      const pages = {};
      for (const x of books) pages[x.fileId] = (await getFileText(sub, x.fileId)).pages;
      const est = skriptEstimate(books, pages);
      const ok = await confirmDialog(`Falllösungs-Skripten für ${est.n} Kapitel in ${books.length} Büchern erstellen – einmalig ca. ${Math.max(est.usd, 0.01).toLocaleString('de-AT', { minimumFractionDigits: 2 })} $ (günstiges Modell, Hintergrund-Modus). Danach kostenlos.`, 'Ja, erstellen');
      if (!ok) { draw(); return; }
      for (const x of books) runJob('skript:' + x.fileId, `Falllösungs-Skript „${x.title}“`, st => buildSkript(subId, x.fileId, st), { subId });
      setTimeout(draw, 2000);
    }
  };
  draw();
}


// ---------- Fachbegriffe als Karteikarten (aus den Definitionen der Zusammenfassungen, kostenlos) ----------
const termState = {};
const termKey = t => String(t).toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^a-zäöüß0-9]+/g, ' ').trim();
function collectTerms(sub) {
  const map = new Map();
  for (const b of sub.books.filter(x => bookRole(x) === 'stoff')) for (const c of b.chapters.filter(isStudyChapter)) for (const d of c.summary?.definitionen || []) {
    if (!d?.begriff || !d?.definition) continue;
    const k = termKey(d.begriff);
    if (!k || map.has(k)) continue;
    map.set(k, { key: k, begriff: d.begriff, definition: d.definition, seite: d.seite || '', ebene: d.ebene || 'basis', book: b.fileId, bookTitle: b.title, chapter: c.title, chId: c.id });
  }
  return [...map.values()];
}
const BOX_DAYS = [0, 1, 3, 7, 16, 35];
function tabBegriffe(el, sub) {
  const st = termState[sub.id] ||= { book: '', ebene: '', mode: 'lernen', q: '' };
  const prog = () => store.state.progress.terms || {};
  const hidden = () => store.state.progress.termsHidden || {};
  let queue = [], cur = null, shown = false;
  const pool = () => collectTerms(store.subject(sub.id)).filter(t => !hidden()[t.key] && (!st.book || t.book === st.book) && (!st.ebene || t.ebene === st.ebene));
  const due = list => { const now = Date.now(); return list.filter(t => !prog()[t.key] || (prog()[t.key].due || 0) <= now).sort((a, b) => (prog()[a.key]?.due || 0) - (prog()[b.key]?.due || 0)); };
  const header = list => {
    const books = store.subject(sub.id).books.filter(x => bookRole(x) === 'stoff' && x.chapters.some(c => c.summary?.definitionen?.length));
    const learned = list.filter(t => (prog()[t.key]?.box || 0) >= 3).length;
    return `<div class="card"><div class="row" style="gap:8px;flex-wrap:wrap">
      <select id="tbook" style="flex:1;min-width:150px"><option value="">Alle Bücher</option>${books.map(b => `<option value="${b.fileId}" ${st.book === b.fileId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select>
      <select id="tebene" style="width:auto"><option value="">Basis + Vertiefung</option><option value="basis" ${st.ebene === 'basis' ? 'selected' : ''}>nur Basis</option><option value="vertiefung" ${st.ebene === 'vertiefung' ? 'selected' : ''}>nur Vertiefung</option></select></div>
      <div class="small muted" style="margin-top:8px">${list.length} Fachbegriffe · ${due(list).length} jetzt dran · ${learned} sicher gelernt${Object.keys(hidden()).length ? ` · ${Object.keys(hidden()).length} ausgeblendet` : ''}</div>
      <div class="tabs" style="margin:8px 0 0"><button class="tab ${st.mode === 'lernen' ? 'active' : ''}" data-mode="lernen">Lernen</button><button class="tab ${st.mode === 'liste' ? 'active' : ''}" data-mode="liste">Liste / Nachschlagen</button></div></div>`;
  };
  const drawCard = () => {
    const list = pool();
    if (!queue.length) queue = due(list).slice(0, 20);
    cur = queue[0];
    let html = header(list);
    if (!cur) html += `<div class="card" style="text-align:center"><p>🎉 Für heute ist alles gelernt.</p><button class="btn secondary small" data-a="extra">Trotzdem weiter üben</button></div>`;
    else html += `<div class="card term-card"><div class="tiny muted">${esc(cur.bookTitle)} · ${esc(cur.chapter)} ${cur.ebene === 'vertiefung' ? '· <span class="pill gold">Vertiefung</span>' : ''}</div>
      <div class="term" style="margin:14px 0">${esc(cur.begriff)}</div>
      ${shown ? `<div style="text-align:left">${enrich(esc(cur.definition))}${cur.seite ? ` <span class="cite">[${esc(String(cur.seite).replace(/^\[|\]$/g, ''))}]</span>` : ''}</div>
        <div class="row" style="justify-content:center;margin-top:14px;gap:6px"><button class="btn secondary small" data-r="0">Nicht gewusst</button><button class="btn secondary small" data-r="1">Ungefähr</button><button class="btn small" data-r="2">Gewusst</button></div>`
        : `<div><button class="btn" data-a="show">Aufdecken</button></div><p class="tiny muted" style="margin-top:10px">Erst selbst erklären, dann aufdecken.</p>`}
      <div style="margin-top:12px"><button class="btn ghost small" data-a="hide" title="Kommt nicht mehr vor">Allgemeinwortschatz – ausblenden</button></div></div>
      <div class="tiny muted" style="text-align:center">${queue.length} Begriffe in dieser Runde</div>`;
    el.innerHTML = html;
    bindHeader();
  };
  const drawList = () => {
    const list = pool();
    const q = st.q.toLowerCase();
    const shownList = q ? list.filter(t => (t.begriff + ' ' + t.definition).toLowerCase().includes(q)) : list;
    el.innerHTML = header(list) + `<input type="text" id="tq" placeholder="Begriff suchen …" value="${esc(st.q)}" style="margin-bottom:10px">
      <div class="card"><ul class="list">${shownList.sort((a, b) => a.begriff.localeCompare(b.begriff, 'de')).slice(0, 400).map(t => `<li style="display:block;padding:8px 0"><strong>${esc(t.begriff)}</strong> <span class="tiny muted">${esc(t.chapter)}</span><div class="small">${enrich(esc(t.definition))}${t.seite ? ` <span class="cite">[${esc(String(t.seite).replace(/^\[|\]$/g, ''))}]</span>` : ''}</div></li>`).join('') || '<li class="muted small">Keine Treffer.</li>'}</ul></div>
      ${Object.keys(hidden()).length ? `<div class="card small"><details><summary>Ausgeblendete Begriffe (${Object.keys(hidden()).length})</summary>${Object.keys(hidden()).map(k => `<button class="btn ghost small" data-unhide="${esc(k)}">↺ ${esc(k)}</button>`).join(' ')}</details></div>` : ''}`;
    bindHeader();
    const tq = el.querySelector('#tq'); tq.oninput = () => { st.q = tq.value; clearTimeout(el._t); el._t = setTimeout(() => { drawList(); const x = el.querySelector('#tq'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }, 300); };
  };
  const draw = () => (st.mode === 'liste' ? drawList() : drawCard());
  const bindHeader = () => {
    el.querySelector('#tbook').onchange = e => { st.book = e.target.value; queue = []; shown = false; draw(); };
    el.querySelector('#tebene').onchange = e => { st.ebene = e.target.value; queue = []; shown = false; draw(); };
  };
  el.onclick = e => {
    const m = e.target.closest('[data-mode]'); if (m) { st.mode = m.dataset.mode; draw(); return; }
    const u = e.target.closest('[data-unhide]'); if (u) { store.update(s => { delete (s.progress.termsHidden ||= {})[u.dataset.unhide]; }); draw(); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'show') { shown = true; drawCard(); return; }
    if (a === 'extra') { queue = pool().sort((x, y) => (prog()[x.key]?.box || 0) - (prog()[y.key]?.box || 0)).slice(0, 20); shown = false; drawCard(); return; }
    if (a === 'hide' && cur) { store.update(s => { (s.progress.termsHidden ||= {})[cur.key] = true; }); queue.shift(); shown = false; drawCard(); return; }
    const r = e.target.closest('[data-r]');
    if (r && cur) {
      const grade = +r.dataset.r;
      store.update(s => {
        const p = (s.progress.terms ||= {})[cur.key] || { box: 0 };
        p.box = grade === 2 ? Math.min(5, (p.box || 0) + 1) : grade === 1 ? Math.max(1, p.box || 0) : 0;
        p.due = Date.now() + (grade === 0 ? 0 : BOX_DAYS[p.box] * 86400000);
        p.seen = (p.seen || 0) + 1;
        s.progress.terms[cur.key] = p;
      });
      queue.shift();
      if (grade === 0) queue.splice(Math.min(queue.length, 4), 0, cur); // gleich nochmal, nach ein paar anderen
      shown = false; drawCard();
    }
  };
  draw();
}
