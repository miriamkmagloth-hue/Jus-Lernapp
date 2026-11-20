// Hauptansichten: Übersicht, Fächer, Fach anlegen, Statistik, Fehlerbuch, Einstellungen, Einrichtung
import { store, local, uid, newExam, normalizeSubject, allChapters } from './store.js';
import { signIn, signOut, isSignedIn, syncOnStart } from './drive.js';
import { esc, md, toast, pickFolders, confirmDialog, fmtDate, daysUntil, fmtMin, barChart, ampel } from './ui.js';
import { setTitle, render, autoUpdate } from './app.js';
import { computePlan, activeExams, subjectMastery } from './planner.js';
import { CATEGORIES } from './processing.js';
import { aiReady } from './ai.js';
import { activeJobs } from './jobs.js';
import { dueCards } from './views-learn.js';
import { PRESETS, FONTS, ACCENTS, COLOR_FIELDS, UI_COLORS, INK_COLORS, BG_COLORS, design, saveDesign, glassValues, setGlass, setAppBgImage, overlayCss, imageFileToDataUrl } from './theme.js';

const WEEKDAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];

function setupNeeded() {
  const missing = [];
  if (!local.googleClientId) missing.push('Google-Verbindung (Client-ID)');
  if (!aiReady()) missing.push('KI-Schlüssel');
  return missing;
}

// ---------------- Übersicht ----------------
export function dashboard(el) {
  setTitle('Übersicht');
  const st = store.state;
  const missing = setupNeeded();
  let html = '';
  if (missing.length) html += `<div class="notice gold"><strong>Einrichtung fehlt noch:</strong> ${missing.map(esc).join(', ')}.<br><a href="#/einrichtung">Zur Schritt-für-Schritt-Anleitung →</a></div>`;
  else if (!isSignedIn()) html += `<div class="notice"><div class="row between"><span>Mit Google Drive verbinden, um Unterlagen zu laden und zu synchronisieren.</span><button class="btn small" data-a="login">Verbinden</button></div></div>`;

  if (!st.subjects.length) {
    html += `<div class="card empty"><h2>Willkommen!</h2><p>Leg dein erstes Fach an. Die App fragt dich dabei, welche Prüfungen es gibt und wo in Google Drive die Unterlagen liegen.</p><a class="btn" href="#/fach/neu">+ Fach anlegen</a></div>`;
    el.innerHTML = html; bind(el); return;
  }

  // nächste Prüfungen
  const exams = st.subjects.flatMap(s => activeExams(s).map(e => ({ s, e }))).sort((a, b) => (a.e.date || '9999').localeCompare(b.e.date || '9999'));
  html += `<h2>Nächste Prüfungen</h2>`;
  if (!exams.length) html += `<div class="card muted">Keine aktiven Prüfungen eingetragen.</div>`;
  for (const { s, e } of exams.slice(0, 4)) {
    const plan = computePlan(s, e);
    const d = daysUntil(e.date);
    const cls = { gut: 'green', knapp: 'yellow', eng: 'red' }[plan.status] || 'blue';
    html += `<div class="card"><div class="row between"><div><div class="item-title">${esc(s.name)} · ${esc(e.name)}</div><div class="small muted">${e.type === 'muendlich' ? 'mündlich' : 'schriftlich'}${e.date ? ' · ' + fmtDate(e.date) : ''}</div></div>
      <div style="text-align:right">${d != null ? `<div class="stat-num" style="font-size:1.4rem;font-weight:700">${d}</div><div class="tiny muted">Tage</div>` : ''}</div></div>
      <div class="row" style="margin-top:8px"><span class="pill ${cls}">${{ gut: 'Zeit reicht', knapp: 'knapp', eng: 'priorisiert', offen: 'offen', vorbei: 'vorbei' }[plan.status]}</span><span class="small muted">${esc(plan.message)}</span></div>`;
    if (plan.today.length) {
      html += `<h4>Heute sinnvoll</h4><ul class="list">` + plan.today.map(t => `<li><a class="item" href="#/fach/${s.id}/kapitel/${t.id}"><span class="dot ${ampel(t.mastery, t.assessed)}"></span><div><div>${esc(t.title)}</div><div class="small muted">${esc(t.action)} · ca. ${fmtMin(t.min)}</div></div><span class="chev">›</span></a></li>`).join('') + `</ul>`;
    }
    html += `<div class="row" style="margin-top:8px"><a class="btn secondary small" href="#/fach/${s.id}/pruefung/${e.id}">Lernplan</a>${e.type === 'muendlich' ? `<a class="btn secondary small" href="#/fach/${s.id}/simulation/${e.id}">Prüfung simulieren</a>` : `<a class="btn secondary small" href="#/fach/${s.id}/fall">Fall üben</a>`}</div></div>`;
  }

  // Neuigkeiten
  const news = [];
  for (const s of st.subjects) {
    const nu = s.units.filter(u => st.subjects && s.files[u.fileId]?.isNew);
    if (nu.length) news.push(`<a href="#/fach/${s.id}/einheiten">${nu.length} neue Einheit(en) in ${esc(s.name)}</a>`);
    const nr = s.rulings.filter(r => r.isNew);
    if (nr.length) news.push(`<a href="#/fach/${s.id}/ogh">${nr.length} neue OGH-Entscheidung(en) in ${esc(s.name)}</a>`);
  }
  const due = dueCards().length;
  if (due) news.push(`<a href="#/karten">${due} Karteikarte(n) fällig</a>`);
  if (news.length) html += `<h2>Neu für dich</h2><div class="card"><ul class="list">${news.map(n => `<li>${n}</li>`).join('')}</ul></div>`;

  const jobsNow = activeJobs();
  if (jobsNow.length) html += `<h2>Läuft im Hintergrund</h2><div class="card"><ul class="list">${jobsNow.map(([, j]) => `<li class="small"><strong>${esc(j.label)}</strong><br><span class="muted">${esc(j.status)}</span></li>`).join('')}</ul></div>`;

  html += `<h2>Fächer</h2><div class="grid2">` + st.subjects.map(s => subjectCard(s)).join('') + `</div>`;
  el.innerHTML = html; bind(el);
}

function subjectCard(s) {
  const m = subjectMastery(s);
  const ex = activeExams(s)[0];
  return `<a class="card" style="text-decoration:none;color:inherit;display:block" href="#/fach/${s.id}">
    <div class="item-title">${esc(s.name)}</div>
    <div class="small muted">${ex ? esc(ex.name) + (ex.date ? ' · ' + fmtDate(ex.date) : '') : 'keine aktive Prüfung'}</div>
    <div class="progress green" style="margin-top:10px"><div style="width:${Math.round(m.avg * 100)}%"></div></div>
    <div class="tiny muted" style="margin-top:4px">${Math.round(m.avg * 100)} % beherrscht · ${m.assessed}/${m.total} Kapitel eingestuft</div></a>`;
}

function bind(el) {
  el.querySelector('[data-a=login]')?.addEventListener('click', async () => {
    try { await signIn(true); await syncOnStart(); render(); autoUpdate(); } catch (e) { toast(e.message, 5000); }
  });
}

// ---------------- Fächerliste ----------------
export function subjectList(el) {
  setTitle('Fächer');
  const subs = store.state.subjects;
  el.innerHTML = `<div class="row between"><h2>Deine Fächer</h2><a class="btn" href="#/fach/neu">+ Fach anlegen</a></div>
    ${subs.length ? `<div class="grid2">${subs.map(subjectCard).join('')}</div>` : '<div class="card empty">Noch keine Fächer angelegt.</div>'}`;
}

// ---------------- Fach anlegen / bearbeiten ----------------
export function subjectEditor(el, subId) {
  const existing = subId ? store.subject(subId) : null;
  setTitle(existing ? 'Fach bearbeiten' : 'Neues Fach');
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : normalizeSubject({ id: uid('f_'), name: '' });
  if (!existing && !draft.exams.length) draft.exams.push(newExam({ name: 'Schriftliche Abschlussklausur 1', type: 'schriftlich' }));

  const draw = () => {
    el.innerHTML = `<div data-no-rerender>
    <div class="card"><label class="field"><span>Name des Fachs</span><input type="text" id="fname" value="${esc(draft.name)}" placeholder="z. B. Bürgerliches Recht"></label></div>

    <div class="card"><h3>Prüfungen in diesem Fach</h3>
      <p class="small muted">Leg alle Prüfungen an, für die du lernst – z. B. Klausur 1, Klausur 2 (falls nötig), mündliche Prüfung. Jede bekommt ihren eigenen Plan.</p>
      ${draft.exams.map((e, i) => `
        <div class="card" style="background:var(--bg)" data-exam="${i}">
          <div class="grid2">
            <label class="field"><span>Bezeichnung</span><input type="text" data-f="name" value="${esc(e.name)}"></label>
            <label class="field"><span>Art</span><select data-f="type"><option value="schriftlich" ${e.type === 'schriftlich' ? 'selected' : ''}>schriftlich (Klausur)</option><option value="muendlich" ${e.type === 'muendlich' ? 'selected' : ''}>mündlich</option></select></label>
            <label class="field"><span>Termin</span><input type="date" data-f="date" value="${esc(e.date)}"></label>
            <label class="field"><span>Lernzeit pro Lerntag (Stunden)</span><input type="number" min="0.5" max="14" step="0.5" data-f="hoursPerDay" value="${e.hoursPerDay}"></label>
            <label class="field"><span>Status</span><select data-f="status">${[['aktiv', 'ich lerne dafür'], ['bestanden', 'bestanden'], ['nicht_bestanden', 'nicht bestanden'], ['archiviert', 'pausiert / später']].map(([v, l]) => `<option value="${v}" ${e.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          <div class="small muted">Lerntage</div>
          <div class="row">${WEEKDAYS.map(([d, l]) => `<label class="checkline"><input type="checkbox" data-day="${d}" ${e.studyDays.includes(d) ? 'checked' : ''}>${l}</label>`).join('')}</div>
          <div class="row" style="justify-content:flex-end"><button class="btn danger small" data-a="delExam">Entfernen</button></div>
        </div>`).join('')}
      <div class="row"><button class="btn secondary small" data-a="addExam" data-type="schriftlich">+ schriftliche Prüfung</button><button class="btn secondary small" data-a="addExam" data-type="muendlich">+ mündliche Prüfung</button></div>
    </div>

    <div class="card"><h3>Wo liegen die Unterlagen?</h3>
      <p class="small muted">Wähle in Google Drive die Ordner aus. Unterordner werden mitdurchsucht. Neue Dateien erkennt die App automatisch.</p>
      ${!isSignedIn() ? `<div class="notice">Dafür bitte zuerst mit Google verbinden. <button class="btn small" data-a="login">Verbinden</button></div>` : ''}
      <ul class="list">${Object.entries(CATEGORIES).map(([k, c]) => `<li><div class="row between"><div><div class="item-title">${esc(c.label)}</div><div class="small muted">${esc(c.hint)}</div>
        <div>${(draft.folders[k] || []).map(f => `<span class="pill blue">${f.isFolder === false ? '📄' : '📁'} ${esc(f.name)}</span> `).join('') || '<span class="tiny muted">nicht gewählt</span>'}</div></div>
        <button class="btn secondary small" data-a="pick" data-cat="${k}" ${!isSignedIn() ? 'disabled' : ''}>Wählen</button></div></li>`).join('')}</ul>
    </div>

    <div class="row" style="justify-content:space-between">
      ${existing ? '<button class="btn danger" data-a="delete">Fach löschen</button>' : '<span></span>'}
      <div class="row"><a class="btn secondary" href="${existing ? '#/fach/' + existing.id : '#/faecher'}">Abbrechen</a><button class="btn" data-a="save">Speichern</button></div>
    </div></div>`;
  };

  const collect = () => {
    draft.name = el.querySelector('#fname').value.trim();
    el.querySelectorAll('[data-exam]').forEach(box => {
      const e = draft.exams[+box.dataset.exam];
      box.querySelectorAll('[data-f]').forEach(inp => { e[inp.dataset.f] = inp.type === 'number' ? Number(inp.value) : inp.value; });
      e.studyDays = [...box.querySelectorAll('[data-day]')].filter(c => c.checked).map(c => +c.dataset.day);
    });
  };

  el.onclick = async e => {
    const btn = e.target.closest('[data-a]'); if (!btn) return;
    const a = btn.dataset.a;
    if (a === 'addExam') { collect(); const t = btn.dataset.type; const n = draft.exams.filter(x => x.type === t).length + 1; draft.exams.push(newExam({ type: t, name: t === 'muendlich' ? 'Mündliche Prüfung' : `Schriftliche Abschlussklausur ${n}` })); draw(); }
    if (a === 'delExam') { collect(); draft.exams.splice(+btn.closest('[data-exam]').dataset.exam, 1); draw(); }
    if (a === 'login') { collect(); try { await signIn(true); await syncOnStart(); draw(); } catch (err) { toast(err.message, 5000); } }
    if (a === 'pick') {
      collect();
      const cat = btn.dataset.cat;
      const res = await pickFolders({ title: CATEGORIES[cat].label, selected: draft.folders[cat] || [], allowFiles: cat === 'scope' || cat === 'books' || cat === 'protocols' });
      if (res) { draft.folders[cat] = res; draw(); }
    }
    if (a === 'delete') {
      if (await confirmDialog(`„${existing.name}“ mit allen Zusammenfassungen und Auswertungen löschen? Deine Dateien in Google Drive bleiben unberührt.`, 'Löschen')) {
        store.update(s => { s.subjects = s.subjects.filter(x => x.id !== existing.id); });
        location.hash = '#/faecher';
      }
    }
    if (a === 'save') {
      collect();
      if (!draft.name) { toast('Bitte einen Namen eingeben'); return; }
      store.update(s => {
        const i = s.subjects.findIndex(x => x.id === draft.id);
        if (i >= 0) s.subjects[i] = draft; else s.subjects.push(draft);
      });
      toast('Gespeichert');
      location.hash = '#/fach/' + draft.id;
      autoUpdate({ subjects: [draft.id] });
    }
  };
  draw();
}

// ---------------- Statistik ----------------
export function statsView(el) {
  setTitle('Statistik');
  const st = store.state;
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); days.push(d.toISOString().slice(0, 10)); }
  const perDay = days.map(d => st.progress.sessions.filter(s => s.day === d).reduce((a, s) => a + s.minutes, 0));
  const total7 = perDay.slice(-7).reduce((a, b) => a + b, 0);
  const quizzes = st.progress.quizzes || [];
  const qAvg = quizzes.length ? quizzes.reduce((a, q) => a + q.score, 0) / quizzes.length : null;
  const cases = st.progress.cases || [];
  const cAvg = cases.length ? cases.reduce((a, c) => a + (c.score || 0), 0) / cases.length : null;
  let streak = 0;
  for (let i = perDay.length - 1; i >= 0; i--) { if (perDay[i] >= 10) streak++; else if (i !== perDay.length - 1) break; }

  let html = `<div class="grid3">
    <div class="stat"><div class="num">${fmtMin(total7)}</div><div class="lbl">Lernzeit letzte 7 Tage</div></div>
    <div class="stat"><div class="num">${streak}</div><div class="lbl">Tage in Folge gelernt</div></div>
    <div class="stat"><div class="num">${qAvg == null ? '–' : Math.round(qAvg * 100) + ' %'}</div><div class="lbl">Trefferquote Tests (${quizzes.length})</div></div>
    <div class="stat"><div class="num">${cAvg == null ? '–' : Math.round(cAvg * 100) + ' %'}</div><div class="lbl">Ø Falllösungen (${cases.length})</div></div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Lernzeit pro Tag (Minuten)</h3>${barChart(perDay, days.map(d => d.slice(8, 10)))}</div>`;

  for (const s of st.subjects) {
    const m = subjectMastery(s);
    const mins = st.progress.sessions.filter(x => x.subId === s.id).reduce((a, x) => a + x.minutes, 0);
    const chs = allChapters(s).map(c => ({ ...c, p: st.progress.chapters[c.id] })).filter(c => c.p?.assessed).sort((a, b) => a.p.mastery - b.p.mastery);
    html += `<div class="card"><div class="row between"><h3 style="margin:0">${esc(s.name)}</h3><span class="small muted">${fmtMin(mins)} gesamt</span></div>
      <div class="progress green" style="margin:10px 0 4px"><div style="width:${Math.round(m.avg * 100)}%"></div></div>
      <div class="tiny muted">${Math.round(m.avg * 100)} % beherrscht · ${m.assessed} von ${m.total} Kapiteln eingestuft</div>
      ${chs.length ? `<h4>Schwächste Kapitel</h4><ul class="list">${chs.slice(0, 5).map(c => `<li><a class="item" href="#/fach/${s.id}/kapitel/${c.id}"><span class="dot ${ampel(c.p.mastery, true)}"></span>${esc(c.title)}<span class="chev">${Math.round(c.p.mastery * 100)} %</span></a></li>`).join('')}</ul>` : ''}
      ${activeExams(s).map(e => { const p = computePlan(s, e); return `<div class="small" style="margin-top:8px"><strong>${esc(e.name)}:</strong> noch ca. ${fmtMin(p.need)} Lernaufwand${isFinite(p.available) ? `, ${fmtMin(p.available)} verfügbar` : ''}</div>`; }).join('')}
    </div>`;
  }
  html += `<a class="btn secondary block" href="#/fehlerbuch">Fehlerbuch öffnen (${st.progress.mistakes.length})</a>`;
  el.innerHTML = html;
}

// ---------------- Fehlerbuch ----------------
export function mistakesView(el) {
  setTitle('Fehlerbuch');
  const list = store.state.progress.mistakes;
  if (!list.length) { el.innerHTML = '<div class="card empty">Noch keine Fehler gesammelt. Falsche Antworten aus Tests und Fällen landen automatisch hier.</div>'; return; }
  el.innerHTML = `<p class="small muted">Alles, was du falsch hattest. Antwort aufdecken, nochmal überlegen, dann als erledigt markieren.</p>` + list.map(m => {
    const sub = store.subject(m.subId);
    return `<div class="card" data-id="${m.id}"><div class="tiny muted">${esc(sub?.name || '')} · ${esc(m.chapterTitle || '')} · ${fmtDate(m.at)}</div>
      <div class="item-title" style="margin:6px 0">${esc(m.question)}</div>
      ${m.yourAnswer ? `<div class="small">Deine Antwort: <span style="color:var(--red)">${esc(m.yourAnswer)}</span></div>` : ''}
      <details><summary class="small">Lösung zeigen</summary><div class="small"><strong>${esc(m.correct || '')}</strong></div>${m.explanation ? md(m.explanation) : ''}</details>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost small" data-a="done">✓ erledigt</button></div></div>`;
  }).join('');
  el.onclick = e => {
    if (e.target.closest('[data-a=done]')) {
      const id = e.target.closest('[data-id]').dataset.id;
      store.update(s => { s.progress.mistakes = s.progress.mistakes.filter(x => x.id !== id); }, { silent: true });
      e.target.closest('[data-id]').remove();
    }
  };
}

// ---------------- Einstellungen ----------------
export function settingsView(el) {
  setTitle('Einstellungen');
  const s = store.state.settings;
  const prov = s.provider;
  el.innerHTML = `<div data-no-rerender>
  <a class="card" href="#/design" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit"><span style="font-size:1.6rem">🎨</span><div><div class="item-title">Farben &amp; Design</div><div class="small muted">Vorlagen, Schriftart, Hell/Dunkel, Akzentfarbe, Hintergrundfoto</div></div><span class="chev">›</span></a>
  <div class="card"><h3>Google Drive</h3>
    <label class="field"><span>Google-Client-ID (aus der Einrichtung)</span><input type="text" id="clientId" value="${esc(local.googleClientId)}" placeholder="….apps.googleusercontent.com"></label>
    <div class="row">${isSignedIn() ? '<span class="pill green">verbunden</span><button class="btn secondary small" data-a="logout">Trennen</button>' : '<button class="btn small" data-a="login">Mit Google verbinden</button>'}
    <button class="btn secondary small" data-a="scan">Jetzt nach neuen Dateien suchen</button></div>
  </div>

  <div class="card"><h3>KI</h3>
    <label class="field"><span>Anbieter</span><select id="provider">
      <option value="anthropic" ${prov === 'anthropic' ? 'selected' : ''}>Claude (Anthropic) – empfohlen</option>
      <option value="gemini" ${prov === 'gemini' ? 'selected' : ''}>Gemini (Google)</option>
      <option value="openai" ${prov === 'openai' ? 'selected' : ''}>ChatGPT (OpenAI)</option></select></label>
    ${['anthropic', 'gemini', 'openai'].map(p => `<div data-prov="${p}" ${p !== prov ? 'hidden' : ''}>
      <label class="field"><span>API-Schlüssel</span><input type="password" data-key="${p}" value="${esc(s.keys[p])}" autocomplete="off"></label>
      <div class="grid2"><label class="field"><span>Modell für Gründliches (Zusammenfassungen, Korrektur, Chat)</span><input type="text" data-model="${p}.smart" value="${esc(s.models[p].smart)}"></label>
      <label class="field"><span>Modell für Schnelles</span><input type="text" data-model="${p}.fast" value="${esc(s.models[p].fast)}"></label></div></div>`).join('')}
    <p class="tiny muted">Der Schlüssel wird in deinem privaten App-Datenbereich in Google Drive gespeichert, damit er auf Handy und Laptop gleich ist.</p>
    <button class="btn secondary small" data-a="testai">Verbindung testen</button>
  </div>

  <div class="card"><h3>Verhalten</h3>
    <label class="checkline"><input type="checkbox" id="autoProcess" ${s.autoProcess !== false ? 'checked' : ''}> Neue Dateien automatisch verarbeiten</label>
    <label class="checkline"><input type="checkbox" id="speak" ${s.speakQuestions ? 'checked' : ''}> Fragen in der mündlichen Simulation vorlesen</label>
    <label class="field" style="margin-top:10px"><span>RIS-Weiterleitung (nur nötig, wenn die App nicht über Netlify läuft)</span><input type="url" id="risProxy" value="${esc(s.risProxy)}" placeholder="https://…"></label>
  </div>

  <div class="card"><h3>Sicherung</h3>
    <div class="row"><button class="btn secondary small" data-a="export">Sicherung herunterladen</button><label class="btn secondary small">Sicherung einspielen<input type="file" id="importFile" accept=".json" hidden></label></div>
  </div>
  <div class="row" style="justify-content:space-between"><a href="#/einrichtung" class="btn ghost">Einrichtungsanleitung</a><button class="btn" data-a="save">Speichern</button></div></div>`;

  el.querySelector('#provider').onchange = e => el.querySelectorAll('[data-prov]').forEach(d => d.hidden = d.dataset.prov !== e.target.value);
  const save = () => {
    local.googleClientId = el.querySelector('#clientId').value.trim();
    store.update(st => {
      st.settings.provider = el.querySelector('#provider').value;
      el.querySelectorAll('[data-key]').forEach(i => st.settings.keys[i.dataset.key] = i.value.trim());
      el.querySelectorAll('[data-model]').forEach(i => { const [p, k] = i.dataset.model.split('.'); st.settings.models[p][k] = i.value.trim(); });
      st.settings.autoProcess = el.querySelector('#autoProcess').checked;
      st.settings.speakQuestions = el.querySelector('#speak').checked;
      st.settings.risProxy = el.querySelector('#risProxy').value.trim();
    });
  };
  el.querySelector('#importFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.subjects) throw new Error('Keine gültige Sicherung');
      if (await confirmDialog('Aktuellen Stand durch die Sicherung ersetzen?', 'Ersetzen')) { data.updatedAt = Date.now(); store.replace(data); store.update(() => {}); toast('Sicherung eingespielt'); render(); }
    } catch (err) { toast(err.message); }
  };
  el.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'save') { save(); toast('Gespeichert'); }
    if (a === 'login') { save(); try { await signIn(true); await syncOnStart(); toast('Verbunden'); render(); autoUpdate(); } catch (err) { toast(err.message, 6000); } }
    if (a === 'logout') { signOut(); render(); }
    if (a === 'scan') { save(); autoUpdate(); toast('Suche läuft im Hintergrund'); }
    if (a === 'testai') {
      save();
      const { complete } = await import('./ai.js');
      try { const r = await complete({ model: 'fast', maxTokens: 50, messages: [{ role: 'user', content: 'Antworte nur mit: Verbindung steht.' }] }); toast('✓ ' + r.trim()); }
      catch (err) { toast(err.message, 8000); }
    }
    if (a === 'export') {
      const blob = new Blob([JSON.stringify(store.state)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `jus-lernapp-sicherung-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  };
}

// ---------------- Einrichtung ----------------
export function setupView(el) {
  setTitle('Einrichtung');
  const origin = location.origin;
  el.innerHTML = `<div class="card prose">
  <h2>Einmalige Einrichtung (ca. 20–30 Minuten)</h2>
  <p>Du brauchst das nur einmal. Danach funktioniert die App auf Handy und Laptop.</p>
  <h3>1. Google-Zugang (damit die App deine Unterlagen lesen darf)</h3>
  <ol>
    <li>Öffne <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> und lege ein neues Projekt an (Name z. B. „Jus-Lernapp“).</li>
    <li>Menü → <strong>APIs &amp; Dienste → Bibliothek</strong> → „Google Drive API“ suchen → <strong>Aktivieren</strong>.</li>
    <li>Menü → <strong>APIs &amp; Dienste → OAuth-Zustimmungsbildschirm</strong> (bzw. „Google Auth Platform“): App-Name eintragen, deine E-Mail als Support- und Kontaktadresse, Zielgruppe <strong>Extern</strong>. Unter <strong>Testnutzer</strong> deine eigene Gmail-Adresse hinzufügen.</li>
    <li>Menü → <strong>Clients</strong> (bzw. „Anmeldedaten → OAuth-Client-ID erstellen“): Typ <strong>Webanwendung</strong>. Bei <strong>Autorisierte JavaScript-Quellen</strong> eintragen:<br><code>${esc(origin)}</code></li>
    <li>Die angezeigte <strong>Client-ID</strong> kopieren (endet auf <code>.apps.googleusercontent.com</code>) und unten bzw. in den Einstellungen eintragen.</li>
  </ol>
  <p class="small muted">Beim ersten Verbinden zeigt Google eventuell „Google hat diese App nicht überprüft“ – das ist normal bei eigenen Apps. Auf „Weiter“ tippen.</p>
  <h3>2. KI-Schlüssel</h3>
  <ol>
    <li>Öffne <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>, registriere dich und lade unter „Billing“ ein kleines Guthaben auf (z. B. 10 €).</li>
    <li>Unter „API Keys“ einen Schlüssel erstellen und kopieren.</li>
    <li>In den Einstellungen bei „KI“ eintragen und „Verbindung testen“ drücken.</li>
  </ol>
  <h3>3. Am Handy installieren</h3>
  <p>Diese Seite in Chrome am Handy öffnen → Menü (⋮) → <strong>„Zum Startbildschirm hinzufügen“</strong> bzw. „App installieren“. Dann hast du das Icon wie bei einer normalen App.</p>
  </div>
  <div class="card"><label class="field"><span>Google-Client-ID</span><input type="text" id="cid" value="${esc(local.googleClientId)}"></label>
  <label class="field"><span>Claude-API-Schlüssel</span><input type="password" id="akey" value="${esc(store.state.settings.keys.anthropic)}"></label>
  <button class="btn" data-a="save">Speichern und mit Google verbinden</button></div>`;
  el.querySelector('[data-a=save]').onclick = async () => {
    local.googleClientId = el.querySelector('#cid').value.trim();
    const k = el.querySelector('#akey').value.trim();
    store.update(s => { if (k) { s.settings.keys.anthropic = k; s.settings.provider = 'anthropic'; } });
    try { await signIn(true); await syncOnStart(); toast('Eingerichtet!'); location.hash = '#/'; autoUpdate(); }
    catch (e) { toast(e.message, 6000); }
  };
}

// ---------------- Farben & Design ----------------
function swatchRow(colors, current, onPick, { noneLabel = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'swatches';
  const draw = cur => {
    wrap.innerHTML = (noneLabel ? `<button type="button" class="swatch none ${!cur ? 'on' : ''}" data-c="" title="${esc(noneLabel)}"></button>` : '') +
      colors.map(c => `<button type="button" class="swatch ${cur === c ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('') +
      `<label class="swatch" title="Eigene Farbe" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);position:relative"><input type="color" value="${cur || '#ffffff'}" style="opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer"></label>`;
    wrap.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { onPick(b.dataset.c || null); draw(b.dataset.c || null); });
    wrap.querySelector('input[type=color]').onchange = e => { onPick(e.target.value); draw(e.target.value); };
  };
  draw(current);
  return wrap;
}
function segmented(options, current, onPick) {
  const w = document.createElement('div');
  w.className = 'seg';
  const draw = cur => {
    w.innerHTML = options.map(o => `<button type="button" class="${o.value === cur ? 'on' : ''}" data-v="${o.value}">${esc(o.label)}</button>`).join('');
    w.querySelectorAll('button').forEach(b => b.onclick = () => { onPick(b.dataset.v); draw(b.dataset.v); });
  };
  draw(current);
  return w;
}

export function designView(el) {
  setTitle('Farben & Design');
  el.innerHTML = `<div data-no-rerender>
    <div class="card"><h3>Vorlagen</h3><div class="preset-row" id="presets"></div></div>
    <div class="card"><h3>Schriftart</h3><div class="font-row" id="fonts"></div></div>
    <div class="card"><h3>Hell oder dunkel</h3><div id="mode"></div></div>
    <div class="card"><h3>Akzentfarbe</h3><p class="small muted">Knöpfe, Reiter, Markierungen</p><div id="accent"></div></div>
    <div class="card" id="customSec"><h3>Eigene Farben</h3><div id="custom"></div><button type="button" class="btn secondary small" id="resetColors">Farben der Vorlage wiederherstellen</button></div>
    <div class="card"><h3>App-Hintergrund</h3><p class="small muted">Farbe oder Foto hinter allen Seiten</p><div id="bgType" style="margin-bottom:12px"></div><div id="bgPanel"></div></div>
    <div class="card"><h3>Durchsichtigkeit</h3><p class="small muted">Wie stark der Hintergrund durchscheint. 0 % = ganz durchsichtig, 100 % = deckend. Wirkt, wenn ein App-Hintergrund gewählt ist.</p><div id="glass"></div></div>
    <p class="small muted">Gilt auf allen deinen Geräten.</p></div>`;

  const renderPresets = () => {
    const p = design();
    const box = el.querySelector('#presets');
    box.innerHTML = PRESETS.map(pr => {
      const c = pr.colors || { bg: '#1c1b1a', side: '#232120', card: '#2c2a27' };
      return `<button type="button" class="preset ${(p.preset || 'creme') === pr.id ? 'on' : ''}" data-id="${pr.id}"><div class="pv" style="background:${c.bg}"><i style="background:${c.side}"></i><b style="background:${c.card};border-top:3px solid ${pr.accent}"></b></div><span>${esc(pr.name)}</span></button>`;
    }).join('');
    box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
      const pr = PRESETS.find(x => x.id === b.dataset.id);
      saveDesign({ preset: pr.id, themeMode: pr.mode, accent: null, colors: null });
      renderAll();
    });
  };
  const renderFonts = () => {
    const box = el.querySelector('#fonts');
    const cur = design().font || FONTS[0].id;
    box.innerHTML = FONTS.map(f => `<button type="button" class="font-opt ${f.id === cur ? 'on' : ''}" data-id="${f.id}"><span class="fo-big" style="font-family:${esc(f.display)}">Aa</span><span style="font-family:${esc(f.body)}">${esc(f.name)}</span><small>${esc(f.hint)}</small></button>`).join('');
    box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { saveDesign({ font: b.dataset.id }); renderFonts(); });
  };
  const renderMode = () => {
    const box = el.querySelector('#mode'); box.innerHTML = '';
    box.append(segmented([{ value: 'light', label: 'Hell' }, { value: 'dark', label: 'Dunkel' }, { value: 'auto', label: 'Wie das Gerät' }], design().themeMode || 'light', v => { saveDesign({ themeMode: v }); renderColors(); }));
  };
  const renderAccent = () => {
    const box = el.querySelector('#accent'); box.innerHTML = '';
    box.append(swatchRow(ACCENTS, design().accent || null, c => saveDesign({ accent: c }), { noneLabel: 'Standard der Vorlage' }));
  };
  const renderColors = () => {
    const p = design();
    el.querySelector('#customSec').hidden = (p.themeMode || 'light') !== 'light';
    const box = el.querySelector('#custom'); box.innerHTML = '';
    const base = (PRESETS.find(x => x.id === p.preset) || PRESETS[0]).colors || PRESETS[0].colors;
    const cur = { ...base, ...(p.colors || {}) };
    for (const f of COLOR_FIELDS) {
      const row = document.createElement('div'); row.className = 'color-field';
      row.innerHTML = `<span>${esc(f.label)}</span>`;
      row.append(swatchRow(f.key === 'ink' ? INK_COLORS : UI_COLORS, cur[f.key], c => saveDesign({ colors: { ...(design().colors || {}), [f.key]: c || base[f.key] } })));
      box.append(row);
    }
  };
  el.querySelector('#resetColors').onclick = () => { saveDesign({ colors: null }); renderColors(); };

  let bg = { ...(design().appBg || { type: 'none' }) };
  const saveBg = () => saveDesign({ appBg: { ...bg } });
  const renderBg = () => {
    const panel = el.querySelector('#bgPanel'); panel.innerHTML = '';
    if (bg.type === 'color') panel.append(swatchRow(BG_COLORS, bg.color, c => { bg.color = c || BG_COLORS[4]; saveBg(); }));
    if (bg.type === 'image') {
      panel.innerHTML = `<div class="row" style="align-items:flex-start"><div class="bg-thumb" id="thumb"></div><div style="flex:1;min-width:180px">
        <label class="btn secondary small">${bg.image ? 'Anderes Foto' : 'Foto wählen'}<input type="file" accept="image/*" id="pick" hidden></label>
        <label class="field" style="margin-top:10px"><span>Abdunkeln ↔ Aufhellen</span><input type="range" min="-70" max="70" step="5" id="dim"></label>
        <label class="field"><span>Deckkraft <b id="opVal"></b></span><input type="range" min="10" max="100" step="5" id="op"></label></div></div>`;
      const thumb = panel.querySelector('#thumb');
      const upd = () => {
        thumb.style.background = bg.image ? `linear-gradient(${overlayCss(bg.dim)}, ${overlayCss(bg.dim)}), url("${bg.image}") center / cover` : 'var(--grey-soft)';
        thumb.style.opacity = typeof bg.opacity === 'number' ? Math.max(0.25, bg.opacity) : 1;
      };
      upd();
      const dim = panel.querySelector('#dim'), op = panel.querySelector('#op'), opVal = panel.querySelector('#opVal');
      dim.value = Math.round((bg.dim || 0) * 100);
      op.value = Math.round((typeof bg.opacity === 'number' ? bg.opacity : 1) * 100); opVal.textContent = op.value + ' %';
      dim.oninput = () => { bg.dim = Number(dim.value) / 100; upd(); if (bg.image) setAppBgImage(bg); };
      op.oninput = () => { bg.opacity = Number(op.value) / 100; opVal.textContent = op.value + ' %'; upd(); if (bg.image) setAppBgImage(bg); };
      dim.onchange = op.onchange = saveBg;
      panel.querySelector('#pick').onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try { bg = { ...bg, type: 'image', image: await imageFileToDataUrl(f) }; saveBg(); renderBg(); }
        catch { toast('Das Foto konnte nicht geladen werden'); }
      };
    }
  };
  el.querySelector('#bgType').append(segmented([{ value: 'none', label: 'Keiner' }, { value: 'color', label: 'Farbe' }, { value: 'image', label: 'Foto' }], bg.type || 'none', v => {
    if (v === 'none') bg = { type: 'none' };
    if (v === 'color') bg = { type: 'color', color: bg.color || BG_COLORS[4] };
    if (v === 'image') bg = { type: 'image', image: bg.image || '', dim: bg.dim || 0, opacity: bg.opacity ?? 1 };
    if (v !== 'image' || bg.image) saveBg();
    renderBg();
  }));

  const renderGlass = () => {
    const box = el.querySelector('#glass');
    const vals = glassValues();
    box.innerHTML = [['bars', 'Kopfzeile & Navigation'], ['cards', 'Karten']].map(([k, l]) => `<label class="field"><span>${l} <b data-out="${k}">${vals[k]} %</b></span><input type="range" min="0" max="100" step="5" value="${vals[k]}" data-k="${k}"></label>`).join('');
    box.querySelectorAll('[data-k]').forEach(inp => {
      inp.oninput = () => { vals[inp.dataset.k] = Number(inp.value); box.querySelector(`[data-out=${inp.dataset.k}]`).textContent = inp.value + ' %'; setGlass(vals); };
      inp.onchange = () => saveDesign({ glass: { ...vals } });
    });
  };
  const renderAll = () => { renderPresets(); renderFonts(); renderMode(); renderAccent(); renderColors(); };
  renderAll(); renderBg(); renderGlass();
}
