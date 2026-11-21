// Text aus PDFs, Word-Dateien und Textdateien holen
const PDFJS_VER = '4.10.38';
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.mjs`;
let pdfjsPromise = null;

async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_URL).then(m => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return m;
    });
  }
  return pdfjsPromise;
}

// Liefert { pages: [{n, label, text}], outline: [{title, page, level}] }
export async function extractPdf(buffer, onProgress = () => {}) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  let labels = null;
  try { labels = await doc.getPageLabels(); } catch {}
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '', lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !text.endsWith(' ') && !text.endsWith('-')) text += ' ';
      text += it.str;
      lastY = y;
    }
    text = text.replace(/(\w)-\n(\w)/g, '$1$2').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    pages.push({ n: i, label: labels?.[i - 1] || String(i), text });
    page.cleanup();
    if (i % 10 === 0 || i === doc.numPages) onProgress(i, doc.numPages);
  }
  let outline = [];
  try {
    const raw = await doc.getOutline();
    if (raw) outline = await flattenOutline(doc, raw, 0);
  } catch (e) { console.warn('Inhaltsverzeichnis nicht lesbar', e); }
  await doc.destroy();
  return { pages, outline };
}

async function flattenOutline(doc, items, level) {
  const out = [];
  for (const it of items) {
    let page = null;
    try {
      let dest = it.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0])) + 1;
    } catch {}
    out.push({ title: (it.title || '').trim(), page, level });
    if (it.items?.length && level < 2) out.push(...await flattenOutline(doc, it.items, level + 1));
  }
  return out;
}

// --- Minimaler ZIP-Leser für .docx (ohne Fremdbibliothek) ---
async function unzipEntry(buffer, wanted) {
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige Word-Datei');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nlen = view.getUint16(p + 28, true), xlen = view.getUint16(p + 30, true), clen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buffer, p + 46, nlen));
    if (name === wanted) {
      const lnlen = view.getUint16(local + 26, true), lxlen = view.getUint16(local + 28, true);
      const start = local + 30 + lnlen + lxlen;
      const data = new Uint8Array(buffer, start, csize);
      if (method === 0) return dec.decode(data);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('Inhalt der Word-Datei nicht gefunden');
}

export async function extractDocx(buffer) {
  const xml = await unzipEntry(buffer, 'word/document.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [...doc.getElementsByTagNameNS(W, 'p')].map(p => {
    let t = '';
    p.querySelectorAll('*').forEach(n => {
      if (n.localName === 't') t += n.textContent;
      else if (n.localName === 'tab') t += '\t';
      else if (n.localName === 'br') t += '\n';
    });
    return t;
  });
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Einheitlich: Datei-Download -> Text (bei PDFs mit Seitenmarkierungen)
export async function fileToText(file, data, onProgress) {
  const name = (file.name || '').toLowerCase();
  if (data.kind === 'text') return { text: data.text, pages: null };
  if (file.mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    const r = await extractPdf(data.buffer, onProgress);
    return { text: pagesToText(r.pages), pages: r.pages, outline: r.outline };
  }
  if (name.endsWith('.docx')) return { text: await extractDocx(data.buffer), pages: null };
  if (/\.(txt|md|srt|vtt|csv|rtf)$/.test(name) || (file.mimeType || '').startsWith('text/')) {
    let t = new TextDecoder().decode(data.buffer);
    if (name.endsWith('.srt') || name.endsWith('.vtt')) t = t.replace(/^\d+\s*$/gm, '').replace(/^[\d:.,]+ --> [\d:.,]+.*$/gm, '').replace(/\n{2,}/g, '\n');
    if (name.endsWith('.rtf')) t = t.replace(/\\par[d]?/g, '\n').replace(/\{\*?\\[^{}]+}|[{}]|\\\S+\s?/g, '');
    return { text: t, pages: null };
  }
  throw new Error('Dateityp wird nicht unterstützt: ' + file.name + ' (möglich: PDF, Word .docx, Text, Google Docs)');
}

// Verzeichniszeilen („Kauf ........ 2/12“) werden weggelassen – sie sind kein Lernstoff
const DOT_LINE = /(?:[.…]\s?){4,}\s*[\dIVXLC]+(?:\/\d+)?\s*$/;
export function pagesToText(pages, from = 1, to = Infinity) {
  return pages.filter(p => p.n >= from && p.n <= to).map(p => `[S. ${p.label}]\n${p.text.split('\n').filter(l => !DOT_LINE.test(l)).join('\n')}`).join('\n\n');
}

export const SUPPORTED = /\.(pdf|docx|txt|md|srt|vtt|rtf)$/i;
export function isSupported(f) {
  return SUPPORTED.test(f.name || '') || f.mimeType === 'application/pdf' || f.mimeType === 'application/vnd.google-apps.document' || (f.mimeType || '').startsWith('text/');
}
