// Google Drive: Anmeldung, Ordner durchsuchen, Dateien laden, Zustand synchronisieren
import { store, local } from './store.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
const STATE_FILE = 'jus-lernapp-state.json';
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let pendingToken = null;
let stateFileId = null;
let syncListeners = new Set();
export let syncStatus = 'offline';

function setSync(s) { syncStatus = s; syncListeners.forEach(f => f(s)); }
export function onSync(fn) { syncListeners.add(fn); fn(syncStatus); }

function waitForGis() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(t); resolve(); }
      else if (++n > 100) { clearInterval(t); reject(new Error('Google-Anmeldung konnte nicht geladen werden (keine Internetverbindung?)')); }
    }, 100);
  });
}

// ---------- Anmeldung ----------
// 1) Mit Server (Vercel): einmal anmelden, danach erneuert die App den Zugang selbst (Refresh-Token)
// 2) Ohne Server: Zugang gilt 1 Stunde; er wird auf dem Gerät gemerkt, damit ein Neustart keine neue Anmeldung braucht
const TOK_KEY = 'gTok', RT_KEY = 'gRefresh';
let serverAuth = null; // { enabled, clientId }

function saveToken(tok, expiresIn) {
  accessToken = tok;
  tokenExpiry = Date.now() + (expiresIn - 120) * 1000;
  try { localStorage.setItem(TOK_KEY, JSON.stringify({ t: tok, e: tokenExpiry })); } catch {}
  local.loggedInHint = true;
  needLogin(false);
}
(function restoreToken() {
  try { const v = JSON.parse(localStorage.getItem(TOK_KEY) || 'null'); if (v && v.e > Date.now()) { accessToken = v.t; tokenExpiry = v.e; } } catch {}
})();

export function isSignedIn() { return !!accessToken && Date.now() < tokenExpiry; }
export function canStaySignedIn() { return !!localStorage.getItem(RT_KEY); }

const loginListeners = new Set();
let loginNeeded = false;
export function onNeedLogin(fn) { loginListeners.add(fn); fn(loginNeeded); }
function needLogin(v) { if (loginNeeded !== v) { loginNeeded = v; loginListeners.forEach(f => f(v)); } if (v) setSync('anmelden'); }

export async function serverAuthInfo() {
  if (serverAuth) return serverAuth;
  try {
    const r = await fetch('/api/google-config', { cache: 'no-store' });
    serverAuth = r.ok && (r.headers.get('content-type') || '').includes('json') ? await r.json() : { enabled: false };
  } catch { serverAuth = { enabled: false }; }
  if (serverAuth.clientId && !local.googleClientId) local.googleClientId = serverAuth.clientId;
  return serverAuth;
}

async function refreshSilently() {
  const rt = localStorage.getItem(RT_KEY);
  if (!rt) return false;
  try {
    const r = await fetch('/api/google-refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) });
    const j = await r.json();
    if (!r.ok || !j.access_token) { if (j.error === 'invalid_grant') localStorage.removeItem(RT_KEY); return false; }
    saveToken(j.access_token, j.expires_in || 3600);
    return true;
  } catch { return false; }
}

// Interaktive Anmeldung – nur aus einem Klick heraus aufrufen (sonst blockiert der Browser das Fenster)
export async function signIn() {
  const info = await serverAuthInfo();
  const clientId = local.googleClientId;
  if (!clientId) throw new Error('Bitte zuerst in den Einstellungen die Google-Client-ID eintragen.');
  await waitForGis();
  if (info.enabled) {
    // Code-Verfahren: Server tauscht den Code gegen Zugang + Refresh-Token
    const code = await new Promise((resolve, reject) => {
      const c = google.accounts.oauth2.initCodeClient({
        client_id: clientId, scope: SCOPES, ux_mode: 'popup',
        callback: resp => resp.error ? reject(new Error(resp.error_description || resp.error)) : resolve(resp.code),
        error_callback: err => reject(new Error(err?.message || err?.type || 'Anmeldung abgebrochen'))
      });
      c.requestCode();
    });
    const r = await fetch('/api/google-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error('Google-Anmeldung fehlgeschlagen: ' + (j.error_description || j.error || r.status));
    if (j.refresh_token) localStorage.setItem(RT_KEY, j.refresh_token);
    saveToken(j.access_token, j.expires_in || 3600);
    return accessToken;
  }
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: resp => {
        const p = pendingToken; pendingToken = null;
        if (resp.error) { p?.reject(new Error(resp.error_description || resp.error)); return; }
        saveToken(resp.access_token, resp.expires_in);
        p?.resolve(accessToken);
      },
      error_callback: err => {
        const p = pendingToken; pendingToken = null;
        p?.reject(new Error(err?.message || err?.type || 'Anmeldung abgebrochen'));
      }
    });
  }
  return new Promise((resolve, reject) => {
    pendingToken = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// Beim Start: ohne Fenster versuchen (gemerkter Zugang oder Refresh-Token)
export async function signInSilently() {
  if (isSignedIn()) return true;
  await serverAuthInfo();
  if (await refreshSilently()) return true;
  if (local.loggedInHint) needLogin(true);
  return false;
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null; tokenExpiry = 0; local.loggedInHint = false;
  try { localStorage.removeItem(TOK_KEY); localStorage.removeItem(RT_KEY); } catch {}
  setSync('offline');
}

async function token() {
  if (isSignedIn()) return accessToken;
  if (await refreshSilently()) return accessToken;
  needLogin(true);
  const e = new Error('Die Google-Verbindung ist abgelaufen. Bitte oben auf „anmelden“ tippen.');
  e.needLogin = true;
  throw e;
}

// Zugang rechtzeitig vor Ablauf still erneuern (nur mit Server möglich)
setInterval(() => { if (accessToken && tokenExpiry - Date.now() < 5 * 60 * 1000) refreshSilently(); }, 60 * 1000);

async function gfetch(url, opts = {}, retry = true) {
  const t = await token();
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  if (res.status === 401 && retry) { accessToken = null; tokenExpiry = 0; return gfetch(url, opts, false); }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    throw new Error('Google Drive: ' + msg);
  }
  return res;
}

const FIELDS = 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents)';

export async function listFolder(folderId = 'root') {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent(FIELDS)}&pageSize=1000&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? '&pageToken=' + pageToken : ''}`;
    const j = await (await gfetch(url)).json();
    out.push(...j.files);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function listShared() {
  const q = encodeURIComponent(`sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const j = await (await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent(FIELDS)}&pageSize=200`)).json();
  return j.files;
}

export const isFolder = f => f.mimeType === 'application/vnd.google-apps.folder';

// Alle Dateien in einem Ordner inkl. Unterordnern (mit Pfad)
export async function listRecursive(folderId, path = '', depth = 0) {
  const items = await listFolder(folderId);
  const out = [];
  for (const it of items) {
    if (isFolder(it)) {
      if (depth < 6) out.push(...await listRecursive(it.id, path ? path + ' / ' + it.name : it.name, depth + 1));
    } else {
      out.push({ ...it, path });
    }
  }
  return out;
}

export async function downloadFile(file) {
  if (file.mimeType === 'application/vnd.google-apps.document') {
    const res = await gfetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`);
    return { kind: 'text', text: await res.text() };
  }
  if (file.mimeType?.startsWith('application/vnd.google-apps')) throw new Error('Dieser Google-Dateityp wird nicht unterstützt: ' + file.name);
  const res = await gfetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`);
  return { kind: 'binary', buffer: await res.arrayBuffer() };
}

export async function getFileMeta(id) {
  return (await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,modifiedTime,size&supportsAllDrives=true`)).json();
}

// ---------- Zustand im App-Datenordner ----------
async function findStateFile() {
  if (stateFileId) return stateFileId;
  const q = encodeURIComponent(`name = '${STATE_FILE}'`);
  const j = await (await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`)).json();
  stateFileId = j.files?.[0]?.id || null;
  return stateFileId;
}

async function readRemoteState() {
  const id = await findStateFile();
  if (!id) return null;
  return (await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json();
}

let saving = false, saveAgain = false;
export async function writeRemoteState() {
  if (!isSignedIn() && !canStaySignedIn()) return;
  if (saving) { saveAgain = true; return; }
  saving = true; setSync('speichert');
  try {
    const body = JSON.stringify(store.state);
    const id = await findStateFile();
    if (id) {
      await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    } else {
      const boundary = 'b' + Math.random().toString(36).slice(2);
      const meta = { name: STATE_FILE, parents: ['appDataFolder'] };
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const j = await (await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart })).json();
      stateFileId = j.id;
    }
    setSync('synchron');
  } catch (e) {
    console.warn(e); setSync('Fehler');
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; writeRemoteState(); }
  }
}

// Beim Start: neueren Stand (lokal oder Drive) übernehmen
export async function syncOnStart() {
  setSync('lädt');
  const remote = await readRemoteState();
  const localEmpty = !store.state.subjects.length;
  if (remote && ((remote.updatedAt || 0) > (store.state.updatedAt || 0) || (localEmpty && remote.subjects?.length))) {
    // auf einem neuen Gerät: Drive-Stand übernehmen, lokal eingetragene Schlüssel behalten
    const localKeys = store.state.settings.keys || {};
    remote.settings = remote.settings || {};
    remote.settings.keys = { ...localKeys, ...Object.fromEntries(Object.entries(remote.settings.keys || {}).filter(([, v]) => v)) };
    store.replace(remote);
  } else if (!remote || (store.state.updatedAt || 0) > (remote.updatedAt || 0)) {
    await writeRemoteState();
  }
  setSync('synchron');
}

store.remoteSaver = () => writeRemoteState();

// ---------- Weitere Dateien im privaten App-Datenordner (z. B. ausgelesene Buchtexte) ----------
const appFileIds = {};
async function findAppFile(name) {
  if (appFileIds[name]) return appFileIds[name];
  const q = encodeURIComponent(`name = '${name}'`);
  const j = await (await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
  return (appFileIds[name] = j.files?.[0]?.id || null);
}
export async function readAppFile(name) {
  const id = await findAppFile(name);
  if (!id) return null;
  return (await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json();
}
export async function writeAppFile(name, obj) {
  const body = JSON.stringify(obj);
  const id = await findAppFile(name);
  if (id) { await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }); return; }
  const boundary = 'b' + Math.random().toString(36).slice(2);
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const j = await (await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart })).json();
  appFileIds[name] = j.id;
}
