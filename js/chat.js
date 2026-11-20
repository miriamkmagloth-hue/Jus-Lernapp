// Wiederverwendbarer KI-Chat (mit Spracheingabe)
import { complete } from './ai.js';
import { esc, md, toast } from './ui.js';
import { store } from './store.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// opts: { history: [] (wird verändert), onSave(history), system: () => Promise<string>|string, placeholder, starter, voice, speak, model, maxTokens, quickPrompts: [] }
export function mountChat(el, opts) {
  const history = opts.history;
  el.setAttribute('data-no-rerender', '');
  el.innerHTML = `
    <div class="chat" data-r="msgs"></div>
    ${opts.quickPrompts?.length ? `<div class="row" style="margin-top:10px" data-r="quick">${opts.quickPrompts.map((q, i) => `<button class="btn secondary small" data-q="${i}">${esc(q.label)}</button>`).join('')}</div>` : ''}
    <div class="chat-input">
      ${SR && opts.voice !== false ? '<button class="btn secondary mic" data-r="mic" title="Spracheingabe">🎤</button>' : ''}
      <textarea data-r="input" rows="1" placeholder="${esc(opts.placeholder || 'Frage stellen …')}"></textarea>
      <button class="btn" data-r="send">➤</button>
    </div>
    <div class="row between tiny muted"><span>${SR && opts.voice !== false ? 'Mikrofon: sprechen statt tippen' : ''}</span><button class="btn ghost small" data-r="clear">Verlauf leeren</button></div>`;
  const msgs = el.querySelector('[data-r=msgs]');
  const input = el.querySelector('[data-r=input]');
  const sendBtn = el.querySelector('[data-r=send]');
  let busy = false;

  const render = () => {
    const visible = history.filter(m => !m.hidden);
    msgs.innerHTML = visible.length ? visible.map(m => `<div class="msg ${m.role}">${m.role === 'assistant' ? md(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div>`).join('')
      : `<div class="muted small">${esc(opts.emptyText || 'Stell eine Frage, um zu beginnen.')}</div>`;
  };
  render();

  async function send(text, { hidden = false } = {}) {
    if (busy || !text.trim()) return;
    busy = true; sendBtn.disabled = true;
    history.push({ role: 'user', content: text, hidden });
    render();
    const waiting = document.createElement('div');
    waiting.className = 'msg assistant'; waiting.innerHTML = '<span class="spinner"></span>';
    msgs.appendChild(waiting);
    waiting.scrollIntoView({ behavior: 'smooth', block: 'end' });
    try {
      const system = typeof opts.system === 'function' ? await opts.system() : opts.system;
      const msgsForApi = history.map(m => ({ role: m.role, content: m.content }));
      const answer = await complete({ system, messages: msgsForApi, model: opts.model || 'smart', maxTokens: opts.maxTokens || 3000, purpose: opts.purpose || 'Chat' });
      history.push({ role: 'assistant', content: answer });
      opts.onSave && opts.onSave(history);
      render();
      msgs.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (opts.speak && store.state.settings.speakQuestions) speak(answer);
      opts.onAnswer && opts.onAnswer(answer, history);
    } catch (e) {
      history.pop();
      waiting.remove();
      toast(e.message, 6000);
      input.value = text;
    } finally { busy = false; sendBtn.disabled = false; }
  }

  sendBtn.onclick = () => { const t = input.value; input.value = ''; autoGrow(); send(t); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBtn.click(); } });
  const autoGrow = () => { input.style.height = 'auto'; input.style.height = Math.min(180, input.scrollHeight) + 'px'; };
  input.addEventListener('input', autoGrow);
  el.querySelector('[data-r=clear]').onclick = () => { history.length = 0; opts.onSave && opts.onSave(history); render(); };
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => send(opts.quickPrompts[+b.dataset.q].prompt));

  const mic = el.querySelector('[data-r=mic]');
  if (mic) {
    let rec = null;
    mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'de-AT'; rec.interimResults = true; rec.continuous = true;
      const base = input.value ? input.value + ' ' : '';
      rec.onresult = ev => {
        let t = '';
        for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
        input.value = base + t; autoGrow();
      };
      rec.onend = () => { mic.classList.remove('on'); rec = null; };
      rec.onerror = ev => { toast('Spracheingabe: ' + ev.error); };
      rec.start(); mic.classList.add('on');
    };
  }
  return { send, render };
}

export function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const clean = text.replace(/[#*_`>\[\]]/g, '').slice(0, 1500);
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'de-AT';
  const v = speechSynthesis.getVoices().find(v => v.lang.startsWith('de'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
