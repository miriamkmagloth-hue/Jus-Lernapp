// Hintergrundaufgaben (z. B. Lehrbuch verarbeiten), laufen weiter, während man in der App herumgeht
export const jobs = new Map(); // key -> { label, status, done, error, subId }
const listeners = new Set();
export function onJobs(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(key) { listeners.forEach(f => f(key, jobs.get(key))); }

let queue = Promise.resolve();

// Aufgaben laufen nacheinander (schont KI-Limits)
export function runJob(key, label, fn, { subId = null } = {}) {
  if (jobs.has(key) && !jobs.get(key).done) return jobs.get(key).promise;
  const job = { label, status: 'wartet …', done: false, error: null, subId };
  jobs.set(key, job); emit(key);
  job.promise = queue = queue.then(async () => {
    job.status = 'läuft …'; emit(key);
    try {
      const r = await fn(msg => { job.status = msg; emit(key); });
      job.done = true; job.status = 'fertig'; emit(key);
      setTimeout(() => { if (jobs.get(key) === job) { jobs.delete(key); emit(key); } }, 8000);
      return r;
    } catch (e) {
      console.error(e);
      job.done = true; job.error = e.message; job.status = 'Fehler: ' + e.message; emit(key);
      setTimeout(() => { if (jobs.get(key) === job) { jobs.delete(key); emit(key); } }, 20000);
    }
  });
  return job.promise;
}

export function activeJobs(subId) {
  return [...jobs.entries()].filter(([, j]) => !subId || j.subId === subId);
}
