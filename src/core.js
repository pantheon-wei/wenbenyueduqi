// 不依赖 DOM 的文本处理、数据校验和阅读位置算法。
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
export const MAX_BOOKS = 200;
export const DEFAULT_SETTINGS = Object.freeze({ fontSize: 20, lineHeight: 1.9, fontFamily: 'serif', theme: 'paper', customBackground: '#f5f1e8', eyeMode: false });
export const THEMES = Object.freeze({
  paper: { name: '纸白', background: '#fcfbf7', color: '#394238' },
  warm: { name: '暖砂', background: '#efe5d0', color: '#514a3e' },
  green: { name: '青苔', background: '#e3eddc', color: '#394b36' },
  night: { name: '夜读', background: '#252e29', color: '#c5cdbc' }
});
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function normalizeSettings(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {};
  return {
    fontSize: Math.round(clamp(number(raw.fontSize, 20), 14, 36)),
    lineHeight: Math.round(clamp(number(raw.lineHeight, 1.9), 1.4, 2.6) * 10) / 10,
    fontFamily: raw.fontFamily === 'sans' ? 'sans' : 'serif',
    theme: [...Object.keys(THEMES), 'custom'].includes(raw.theme) ? raw.theme : 'paper',
    customBackground: /^#[\da-f]{6}$/i.test(raw.customBackground || '') ? raw.customBackground : '#f5f1e8',
    eyeMode: raw.eyeMode === true
  };
}

export function contrastColor(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .179 ? '#29372c' : '#edf1e9';
}

export function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

export function parseText(text) {
  const blocks = [];
  const chapters = [];
  // 支持中文小说章名、常用英文章节、Markdown 一级至三级标题。
  const chapterPattern = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇](?:\s|[：:、.．·—-]|$)|(?:序章|序言|前言|楔子|引子|尾声|后记|终章)(?:\s|[：:、.．·—-]|$)|chapter\s+\w+(?:\s|[.:—-]|$)|#{1,3}\s+)/i;
  for (const rawLine of normalizeText(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.length <= 100 && chapterPattern.test(line);
    const index = blocks.length;
    blocks.push({ text: heading ? line.replace(/^#{1,3}\s+/, '') : line, heading });
    if (heading) chapters.push({ index, title: blocks[index].text });
  }
  return { blocks, chapters, characters: text.replace(/\s/g, '').length };
}

export function decodeText(buffer, encoding = 'auto') {
  const bytes = new Uint8Array(buffer);
  if (encoding !== 'auto') return normalizeText(new TextDecoder(encoding, { fatal: true }).decode(bytes));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return normalizeText(new TextDecoder('utf-16le', { fatal: true }).decode(bytes));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return normalizeText(new TextDecoder('utf-16be', { fatal: true }).decode(bytes));
  try { return normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return normalizeText(new TextDecoder('gb18030', { fatal: true }).decode(bytes)); }
}

export async function contentId(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeText(text)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizePosition(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {};
  return { index: Math.max(0, Math.floor(number(raw.index, 0))), fraction: clamp(number(raw.fraction, 0), 0, 1), progress: clamp(number(raw.progress, 0), 0, 1) };
}

// tops 是各段落相对于滚动容器顶部的坐标，二分查找避免每次滚动遍历所有段落。
export function positionFromScroll(tops, scrollTop, maxScroll) {
  if (!tops.length) return normalizePosition();
  let low = 0, high = tops.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tops[mid] <= scrollTop + 1) low = mid;
    else high = mid - 1;
  }
  const span = (tops[low + 1] ?? Math.max(maxScroll, tops[low] + 1)) - tops[low];
  return { index: low, fraction: clamp((scrollTop - tops[low]) / Math.max(1, span), 0, 1), progress: maxScroll > 0 ? clamp(scrollTop / maxScroll, 0, 1) : 1 };
}

export function scrollFromPosition(tops, raw, maxScroll) {
  const position = normalizePosition(raw);
  if (position.progress >= .9999) return maxScroll;
  if (!tops.length || position.index >= tops.length) return maxScroll * position.progress;
  // 第一段前的留白属于起始位置，不应在初次打开时跳过。
  if (position.index === 0 && position.fraction === 0 && position.progress === 0) return 0;
  const top = tops[position.index];
  const next = tops[position.index + 1] ?? Math.max(top + 1, maxScroll);
  return clamp(top + (next - top) * position.fraction, 0, maxScroll);
}

export function normalizeBookState(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {};
  const bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks.slice(0, 100).filter((x) => x && typeof x.id === 'string').map((x) => ({
    id: x.id.slice(0, 100), position: normalizePosition(x.position), label: String(x.label || '书签').slice(0, 80), createdAt: number(x.createdAt, Date.now())
  })) : [];
  return { position: normalizePosition(raw.position), bookmarks, lastRead: number(raw.lastRead, 0), readingSeconds: Math.max(0, number(raw.readingSeconds, 0)) };
}

export function validateBackup(raw) {
  if (!raw || raw.format !== 'leaf-reader' || raw.version !== 1 || !Array.isArray(raw.books)) throw new Error('不是拾页阅读器的有效备份文件。');
  if (raw.books.length > MAX_BOOKS) throw new Error(`备份书籍超过 ${MAX_BOOKS} 本。`);
  let totalBytes = 0;
  const books = raw.books.map((book) => {
    if (!book || typeof book.content !== 'string' || typeof book.title !== 'string' || !book.title.trim()) throw new Error('备份中的书籍缺少书名或正文。');
    const content = normalizeText(book.content);
    const size = new TextEncoder().encode(content).byteLength;
    if (!content || size > MAX_FILE_BYTES) throw new Error(`「${book.title.slice(0, 40)}」为空或超过 10 MB。`);
    totalBytes += size;
    if (totalBytes > MAX_BACKUP_BYTES) throw new Error('备份文本总量超过 60 MB。');
    return { title: book.title.trim().slice(0, 120), content, author: typeof book.author === 'string' ? book.author.slice(0, 80) : '本地导入', addedAt: number(book.addedAt, Date.now()), ...normalizeBookState(book) };
  });
  return { books, settings: normalizeSettings(raw.settings) };
}
