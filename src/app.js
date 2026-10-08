import { MAX_FILE_BYTES, MAX_BACKUP_BYTES, MAX_BOOKS, DEFAULT_SETTINGS, THEMES, normalizeSettings, contrastColor, normalizeText, parseText, decodeText, contentId, normalizeBookState, positionFromScroll, scrollFromPosition, validateBackup } from './core.js';
import * as storage from './storage.js';
import { SAMPLE_TITLE, SAMPLE_TEXT } from './sample.js';

const $ = (id) => document.getElementById(id);
const state = { books: new Map(), currentId: null, settings: { ...DEFAULT_SETTINGS }, parsed: null, tops: [], restoring: false, initialized: false };
let saveTimer, toastTimer, resizeTimer, dragDepth = 0, scrollFrame = 0, renderGeneration = 0;
let writeQueue = Promise.resolve();
let pendingConfirm = null;
let sessionSeconds = 0;
let tickTime = Date.now();
let importing = false;
let saveRevision = 0;
const CHECKPOINT_KEY = 'leaf-reader-checkpoint-v1';

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg;
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200); }
function currentBook() { return state.books.get(state.currentId); }
function stateRecord(book) { return book ? { id: book.id, position: { ...book.position }, bookmarks: structuredClone(book.bookmarks), lastRead: book.lastRead, readingSeconds: book.readingSeconds } : null; }
function setSaveStatus(text, error = false) {
  $('saveStatus').replaceChildren(element('span', 'status-dot'), document.createTextNode(text));
  $('saveStatus').classList.toggle('error', error);
}
function reportError(error, prefix = '保存失败') {
  console.error(error);
  const message = error?.name === 'QuotaExceededError' ? '本地空间不足，请先备份并删除部分书籍。' : (error?.message || '浏览器存储不可用。');
  if (prefix === '保存失败' || error?.name === 'QuotaExceededError') setSaveStatus('保存失败', true);
  toast(`${prefix}：${message}`);
}
function enqueueWrite(task) {
  const result = writeQueue.then(task);
  writeQueue = result.catch(() => {});
  return result;
}
function capturePosition() {
  const book = currentBook();
  if (!book || state.restoring || !state.tops.length) return;
  const scroller = $('readerScroll');
  book.position = positionFromScroll(state.tops, scroller.scrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
}
function writeCheckpoint() {
  // 离开页面时同步保留一个很小的恢复点，弥补异步数据库事务可能尚未完成的窗口。
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ state: stateRecord(currentBook()), currentId: state.currentId, settings: state.settings, updatedAt: Date.now() }));
  } catch { /* IndexedDB 仍是主要存储；localStorage 不可用时依然正常使用。 */ }
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!state.initialized) return Promise.resolve();
  capturePosition();
  const record = stateRecord(currentBook());
  const settings = { ...state.settings }, id = state.currentId;
  const revision = ++saveRevision;
  writeCheckpoint();
  setSaveStatus('正在保存');
  return enqueueWrite(() => storage.writeState(record, settings, id)).then(() => { if (revision === saveRevision && !state.restoring) setSaveStatus('已自动保存'); }).catch((error) => reportError(error));
}
function scheduleSave() { if (state.initialized) { ++saveRevision; setSaveStatus('正在保存'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); } }

function coverColor(id) { const palette = ['#71846a', '#a88f71', '#708f8b', '#8b8195', '#939367', '#9a7971']; return palette[parseInt(id.slice(0, 2), 16) % palette.length]; }
function renderShelf() {
  const query = $('shelfSearch').value.trim().toLocaleLowerCase();
  let books = [...state.books.values()].filter((x) => x.title.toLocaleLowerCase().includes(query));
  const sort = $('sortBooks').value;
  books.sort(sort === 'title' ? (a, b) => a.title.localeCompare(b.title, 'zh-CN') : (a, b) => (sort === 'added' ? b.addedAt - a.addedAt : b.lastRead - a.lastRead || b.addedAt - a.addedAt));
  $('bookCount').textContent = String(state.books.size);
  $('bookList').replaceChildren();
  if (!books.length) { $('bookList').append(element('p', 'shelf-empty', query ? '没有找到这本书，换个名字试试。' : '书架还很空。\n导入一本，开始新的故事。')); return; }
  const fragment = document.createDocumentFragment();
  for (const book of books) {
    const item = element('div', `book-item${book.id === state.currentId ? ' active' : ''}`);
    const select = element('button', 'book-select'); select.dataset.bookId = book.id; select.setAttribute('aria-label', `阅读《${book.title}》`); select.setAttribute('aria-pressed', String(book.id === state.currentId));
    const cover = element('span', 'book-cover'); cover.style.setProperty('--cover', coverColor(book.id)); cover.append(icon('leaf'));
    const info = element('span', 'book-info');
    info.append(element('span', 'book-title', book.title));
    const percent = Math.round(book.position.progress * 100);
    info.append(element('span', 'book-detail', `${book.author} · ${percent > 0 ? `已读 ${percent}%` : '尚未开始'}`));
    const progress = element('span', 'book-progress'); const bar = element('span'); bar.style.width = `${percent}%`; progress.append(bar); info.append(progress);
    select.append(cover, info);
    const remove = element('button', 'book-delete'); remove.dataset.deleteId = book.id; remove.setAttribute('aria-label', `删除《${book.title}》`); remove.title = '从书架删除'; remove.append(icon('trash'));
    item.append(select, remove); fragment.append(item);
  }
  $('bookList').append(fragment);
}

function renderSettings() {
  const settings = state.settings;
  $('fontSize').value = settings.fontSize; $('fontSizeValue').textContent = `${settings.fontSize} px`;
  $('lineHeight').value = settings.lineHeight; $('lineHeightValue').textContent = settings.lineHeight.toFixed(1);
  document.querySelectorAll('[data-font]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.font === settings.fontFamily)));
  document.querySelectorAll('[data-theme]').forEach((button) => button.setAttribute('aria-pressed', String(!settings.eyeMode && button.dataset.theme === settings.theme)));
  $('themeName').textContent = settings.eyeMode ? '护眼绿' : (THEMES[settings.theme]?.name || '自定义');
  $('eyeMode').setAttribute('aria-checked', String(settings.eyeMode));
  $('customBackground').value = settings.customBackground;
  const theme = settings.eyeMode ? THEMES.green : settings.theme === 'custom' ? { background: settings.customBackground, color: contrastColor(settings.customBackground) } : THEMES[settings.theme];
  const root = document.documentElement;
  root.style.setProperty('--reader-bg', theme.background); root.style.setProperty('--reader-ink', theme.color);
  root.style.setProperty('--font-size', `${settings.fontSize}px`); root.style.setProperty('--line-height', settings.lineHeight);
  root.style.setProperty('--reader-font', settings.fontFamily === 'sans' ? '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif' : '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif');
  $('fontDown').disabled = settings.fontSize <= 14; $('fontUp').disabled = settings.fontSize >= 36;
}

function measureBlocks() {
  const scroller = $('readerScroll');
  const scrollRect = scroller.getBoundingClientRect();
  state.tops = [...$('readingContent').children].map((child) => child.getBoundingClientRect().top - scrollRect.top + scroller.scrollTop);
}
function restorePosition(position) {
  if (!currentBook()) return;
  state.restoring = true;
  ++saveRevision;
  setSaveStatus('正在保存');
  const generation = ++renderGeneration;
  requestAnimationFrame(() => {
    if (generation !== renderGeneration) return;
    measureBlocks();
    const scroller = $('readerScroll');
    scroller.scrollTop = scrollFromPosition(state.tops, position, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    requestAnimationFrame(() => {
      if (generation !== renderGeneration) return;
      state.restoring = false;
      capturePosition(); updateProgress(); scheduleSave();
    });
  });
}
function renderOutline() {
  $('outlineList').replaceChildren();
  const chapters = state.parsed.chapters;
  if (!chapters.length) { $('outlineList').append(element('p', 'bookmark-empty', '未识别到章节；仍可使用下方进度条跳转。')); return; }
  chapters.forEach((chapter, i) => {
    const button = element('button', 'outline-link'); button.dataset.index = String(chapter.index);
    button.append(element('span', 'outline-index', String(i + 1).padStart(2, '0')), document.createTextNode(chapter.title));
    $('outlineList').append(button);
  });
}
function renderBookmarks() {
  const book = currentBook(); $('bookmarkList').replaceChildren(); $('bookmarkCount').textContent = String(book?.bookmarks.length || 0);
  if (!book?.bookmarks.length) { $('bookmarkList').append(element('p', 'bookmark-empty', '给喜欢的段落留一个记号。\n点击正文上方「书签」即可添加。')); return; }
  for (const bookmark of [...book.bookmarks].sort((a, b) => a.position.index - b.position.index)) {
    const item = element('div', 'bookmark-item');
    const jump = element('button', 'bookmark-jump'); jump.dataset.bookmarkId = bookmark.id;
    jump.append(element('span', '', bookmark.label), element('small', '', `${Math.round(bookmark.position.progress * 100)}% · ${new Date(bookmark.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}`));
    const remove = element('button', 'bookmark-remove'); remove.dataset.removeBookmark = bookmark.id; remove.setAttribute('aria-label', `删除书签：${bookmark.label}`); remove.append(icon('close'));
    item.append(jump, remove); $('bookmarkList').append(item);
  }
}
function updateProgress() {
  const book = currentBook(); if (!book) return;
  const progress = Math.round(book.position.progress * 1000) / 10;
  $('readingProgress').value = progress; $('progressLabel').textContent = `${Math.round(progress)}%`;
  $('statProgress').replaceChildren(document.createTextNode(String(Math.round(progress))), element('span', '', ' %'));
  $('miniProgressBar').style.width = `${progress}%`;
  const chapter = [...state.parsed.chapters].reverse().find((x) => x.index <= book.position.index);
  $('currentChapter').textContent = chapter?.title || '正文';
  const remaining = Math.ceil((1 - book.position.progress) * state.parsed.characters / 400);
  $('remainingTime').textContent = progress >= 99.9 ? '已读完，愿你有所收获。' : `约剩 ${remaining} 分钟 · 按 400 字 / 分钟估算`;
  $('readingProgress').disabled = $('readerScroll').scrollHeight <= $('readerScroll').clientHeight;
  // 只更新当前书籍的进度，避免滚动时重建整个书架。
  const button = $('bookList').querySelector(`[data-book-id="${book.id}"]`);
  if (button) { button.querySelector('.book-progress span').style.width = `${progress}%`; button.querySelector('.book-detail').textContent = `${book.author} · 已读 ${Math.round(progress)}%`; }
}
function closeOutline() { $('outlinePanel').hidden = true; $('toggleOutline').setAttribute('aria-expanded', 'false'); }
function closePanels() {
  document.body.classList.remove('shelf-open', 'settings-open'); $('mobileBackdrop').hidden = true;
  $('toggleSettings').setAttribute('aria-expanded', 'false'); closeOutline();
}
function showReader() {
  const book = currentBook();
  $('welcome').hidden = !!book; $('readingWorkspace').hidden = !book;
  $('toggleFocus').disabled = !book; $('toggleSettings').disabled = !book;
  if (!book) { $('currentTitle').textContent = '阅读空间'; document.title = '拾页 · 把时间留给阅读'; setFocus(false); return; }
  state.parsed = parseText(book.content);
  $('currentTitle').textContent = book.title; $('readerTitle').textContent = book.title; $('focusTitle').textContent = book.title;
  $('readerTitle').title = book.title;
  $('bookCategory').textContent = book.author === '拾页原创' ? '慢读 · 原创随笔' : '私人书架 · 文本';
  $('bookMeta').textContent = `${book.author}　 /　 ${state.parsed.characters.toLocaleString()} 字　 /　 约 ${Math.ceil(state.parsed.characters / 400)} 分钟`;
  document.title = `${book.title} · 拾页`;
  const fragment = document.createDocumentFragment();
  let chapterNumber = 0;
  for (const block of state.parsed.blocks) {
    const node = element(block.heading ? 'h2' : 'p', '', block.text);
    if (block.heading) { chapterNumber++; node.prepend(element('span', 'chapter-index', `CHAPTER ${String(chapterNumber).padStart(2, '0')}`)); }
    fragment.append(node);
  }
  $('readingContent').replaceChildren(fragment);
  renderOutline(); renderBookmarks(); renderSettings(); restorePosition({ ...book.position });
}
async function selectBook(id) {
  if (!state.books.has(id) || state.currentId === id) { closePanels(); return; }
  await saveNow();
  state.currentId = id; currentBook().lastRead = Date.now(); closePanels(); renderShelf(); showReader();
  saveNow();
}
function changeSettings(patch) {
  capturePosition(); const position = { ...currentBook()?.position };
  state.settings = normalizeSettings({ ...state.settings, ...patch }); renderSettings();
  if (currentBook()) restorePosition(position);
  scheduleSave();
}
function setFocus(on) {
  capturePosition(); const position = { ...currentBook()?.position };
  closePanels(); document.body.classList.toggle('focus-mode', on);
  $('toggleFocus').setAttribute('aria-pressed', String(on)); $('toggleFocus').setAttribute('aria-label', on ? '退出专注模式' : '开启专注模式');
  if (currentBook()) restorePosition(position);
}
async function makeBook(title, content, author = '本地导入') {
  content = normalizeText(content);
  if (!content) throw new Error('文本为空，请选择包含正文的文件。');
  if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) throw new Error('文本过大，单本最多 10 MB。');
  if (parseText(content).blocks.length > 40000) throw new Error('文本超过 40,000 个非空段落，请拆分后导入。');
  return { id: await contentId(content), title: title.trim().slice(0, 120) || '未命名文本', content, author, addedAt: Date.now(), ...normalizeBookState() };
}
async function addBooks(books) {
  const unique = new Map(); books.forEach((book) => { if (!state.books.has(book.id)) unique.set(book.id, book); });
  const added = [...unique.values()];
  if (state.books.size + added.length > MAX_BOOKS) throw new Error(`书架最多 ${MAX_BOOKS} 本，请先删除一些书籍。`);
  if (added.length) {
    await enqueueWrite(() => storage.writeBooks(added.map(({ position, bookmarks, lastRead, readingSeconds, ...book }) => book), added.map(stateRecord)));
    added.forEach((book) => state.books.set(book.id, book));
  }
  renderShelf();
  if (books[0]) await selectBook(books[0].id);
  return added.length;
}
function showImport() { if (importing) return; $('importMessage').textContent = ''; $('fileInput').value = ''; closePanels(); $('importDialog').showModal(); }
async function importFiles(files) {
  if (importing || !files.length) return;
  importing = true; $('fileInput').disabled = true; $('pasteSubmit').disabled = true; $('encoding').disabled = true;
  const encoding = $('encoding').value;
  const books = [], errors = [];
  $('importMessage').textContent = '正在读取文本…';
  try {
    for (const file of files) {
      try {
        if (!/\.(txt|md|text)$/i.test(file.name)) throw new Error('仅支持 TXT、MD、TEXT 文件。');
        if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 10 MB。');
        const content = decodeText(await file.arrayBuffer(), encoding);
        books.push(await makeBook(file.name.replace(/\.(txt|md|text)$/i, ''), content));
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    const added = await addBooks(books);
    const duplicates = books.length - added;
    const message = [added ? `已导入 ${added} 本书。` : '', duplicates ? `${duplicates} 本内容重复，已保留原书。` : '', ...errors].filter(Boolean).join('\n');
    $('importMessage').textContent = message;
    if (books.length && !errors.length) $('importDialog').close();
    else if (!$('importDialog').open) $('importDialog').showModal();
    toast(message || '没有可导入的文件。');
  } catch (error) { $('importMessage').textContent = error.message; reportError(error, '导入失败'); }
  finally { importing = false; $('fileInput').disabled = false; $('pasteSubmit').disabled = false; $('encoding').disabled = false; $('fileInput').value = ''; }
}
function confirmDelete(book) {
  $('confirmTitle').textContent = '删除这本书？';
  $('confirmMessage').textContent = `「${book.title}」的正文、阅读进度和书签将从本地书架移除。原始文本文件不受影响。`;
  pendingConfirm = async () => {
    await saveNow(); await enqueueWrite(() => storage.deleteBook(book.id)); state.books.delete(book.id);
    if (state.currentId === book.id) {
      ++renderGeneration; state.restoring = false;
      state.currentId = [...state.books.values()].sort((a, b) => b.lastRead - a.lastRead)[0]?.id || null;
      state.tops = []; showReader();
    }
    writeCheckpoint(); renderShelf(); await saveNow(); toast('已从书架移除。');
  };
  $('confirmDialog').showModal();
}
function addBookmark() {
  const book = currentBook(); if (!book) return;
  capturePosition();
  if (book.bookmarks.length >= 100) { toast('每本书最多 100 个书签，请先删除一些。'); return; }
  if (book.bookmarks.some((x) => x.position.index === book.position.index && Math.abs(x.position.fraction - book.position.fraction) < .08)) { toast('当前位置已经有书签了。'); return; }
  const label = state.parsed.blocks[book.position.index]?.text.slice(0, 45) || book.title;
  book.bookmarks.push({ id: crypto.randomUUID(), position: { ...book.position }, label, createdAt: Date.now() });
  renderBookmarks(); saveNow(); toast('已把这一页，留在书签里。');
}
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = element('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function exportBackup() {
  await saveNow();
  const content = JSON.stringify({ format: 'leaf-reader', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, books: [...state.books.values()] });
  if (new Blob([content]).size > MAX_BACKUP_BYTES) { toast('完整备份超过 60 MB，请先保存原始文本并减少书架内容。'); return; }
  // 使用本地日历日期，避免 UTC 在北京时间凌晨显示前一天。
  const now = new Date(); const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  download(`拾页备份-${date}.json`, content, 'application/json'); toast('备份已导出，包含正文、进度、书签和设置。');
}
async function restoreBackup(file) {
  if (!file || importing) return;
  importing = true;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 60 MB。');
    const backup = validateBackup(JSON.parse(await file.text()));
    const incoming = new Map();
    for (const raw of backup.books) {
      const book = { ...await makeBook(raw.title, raw.content, raw.author), addedAt: raw.addedAt, ...normalizeBookState(raw) };
      const previous = incoming.get(book.id);
      if (!previous || book.lastRead >= previous.lastRead) incoming.set(book.id, book);
    }
    const merged = new Map(state.books);
    incoming.forEach((book, id) => { if (!merged.has(id) || book.lastRead >= merged.get(id).lastRead) merged.set(id, book); });
    if (merged.size > MAX_BOOKS) throw new Error(`合并后超过 ${MAX_BOOKS} 本，未修改现有书架。`);
    await saveNow();
    const written = [...incoming.keys()].map((id) => merged.get(id));
    const nextId = state.currentId || written[0]?.id || null;
    await enqueueWrite(() => storage.writeBooks(written.map(({ position, bookmarks, lastRead, readingSeconds, ...book }) => book), written.map(stateRecord), { settings: backup.settings, currentId: nextId, initialized: true }));
    state.books = merged; state.currentId = nextId; state.settings = backup.settings;
    writeCheckpoint(); renderShelf(); renderSettings(); showReader(); toast(`已恢复 ${incoming.size} 本书；书架按内容合并。`);
  } catch (error) { reportError(error, '恢复失败'); }
  finally { importing = false; $('backupInput').value = ''; }
}

function bindEvents() {
  document.querySelectorAll('.import-trigger').forEach((button) => button.addEventListener('click', showImport));
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { const rect = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close(); }));
  $('fileTab').addEventListener('click', () => { $('fileForm').hidden = false; $('pasteForm').hidden = true; $('fileTab').classList.add('active'); $('pasteTab').classList.remove('active'); $('fileTab').setAttribute('aria-pressed', 'true'); $('pasteTab').setAttribute('aria-pressed', 'false'); });
  $('pasteTab').addEventListener('click', () => { $('fileForm').hidden = true; $('pasteForm').hidden = false; $('pasteTab').classList.add('active'); $('fileTab').classList.remove('active'); $('fileTab').setAttribute('aria-pressed', 'false'); $('pasteTab').setAttribute('aria-pressed', 'true'); $('pasteTitle').focus(); });
  $('fileInput').addEventListener('change', (event) => importFiles([...event.target.files]));
  $('pasteForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (importing) return; importing = true; $('pasteSubmit').disabled = true;
    try { const book = await makeBook($('pasteTitle').value, $('pasteContent').value, '我的文字'); const added = await addBooks([book]); $('importDialog').close(); $('pasteForm').reset(); toast(added ? '文字已加入书架。' : '内容已在书架，已打开原书。'); }
    catch (error) { $('importMessage').textContent = error.message; }
    finally { importing = false; $('pasteSubmit').disabled = false; }
  });
  $('loadSample').addEventListener('click', async () => { try { await addBooks([await makeBook(SAMPLE_TITLE, SAMPLE_TEXT, '拾页原创')]); } catch (error) { reportError(error, '打开示例失败'); } });
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); closePanels(); if (currentBook()) $('readerScroll').focus({ preventScroll: true }); });
  $('shelfSearch').addEventListener('input', renderShelf); $('sortBooks').addEventListener('change', renderShelf);
  $('bookList').addEventListener('click', (event) => { const select = event.target.closest('[data-book-id]'); const remove = event.target.closest('[data-delete-id]'); if (select) selectBook(select.dataset.bookId); if (remove) confirmDelete(state.books.get(remove.dataset.deleteId)); });
  $('readerScroll').addEventListener('scroll', () => { if (state.restoring || scrollFrame) return; scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; if (state.restoring) return; capturePosition(); updateProgress(); scheduleSave(); }); }, { passive: true });
  $('readingProgress').addEventListener('input', () => { $('readerScroll').scrollTop = ($('readerScroll').scrollHeight - $('readerScroll').clientHeight) * Number($('readingProgress').value) / 100; capturePosition(); updateProgress(); scheduleSave(); });
  $('fontSize').addEventListener('input', () => changeSettings({ fontSize: Number($('fontSize').value) }));
  $('fontDown').addEventListener('click', () => changeSettings({ fontSize: state.settings.fontSize - 1 })); $('fontUp').addEventListener('click', () => changeSettings({ fontSize: state.settings.fontSize + 1 }));
  $('lineHeight').addEventListener('input', () => changeSettings({ lineHeight: Number($('lineHeight').value) }));
  $('fontFamilyButtons').addEventListener('click', (event) => { const button = event.target.closest('[data-font]'); if (button) changeSettings({ fontFamily: button.dataset.font }); });
  $('themeOptions').addEventListener('click', (event) => { const button = event.target.closest('[data-theme]'); if (button) changeSettings({ theme: button.dataset.theme, eyeMode: false }); });
  $('customBackground').addEventListener('input', () => changeSettings({ theme: 'custom', customBackground: $('customBackground').value, eyeMode: false }));
  $('eyeMode').addEventListener('click', () => changeSettings({ eyeMode: !state.settings.eyeMode })); $('resetSettings').addEventListener('click', () => { changeSettings(DEFAULT_SETTINGS); toast('已恢复默认阅读设置。'); });
  $('toggleOutline').addEventListener('click', () => { $('outlinePanel').hidden = !$('outlinePanel').hidden; $('toggleOutline').setAttribute('aria-expanded', String(!$('outlinePanel').hidden)); });
  $('closeOutline').addEventListener('click', closeOutline);
  $('outlineList').addEventListener('click', (event) => { const button = event.target.closest('[data-index]'); if (button) { restorePosition({ index: Number(button.dataset.index), fraction: 0, progress: .001 }); closeOutline(); } });
  $('addBookmark').addEventListener('click', addBookmark);
  $('bookmarkList').addEventListener('click', (event) => {
    const jump = event.target.closest('[data-bookmark-id]'); const remove = event.target.closest('[data-remove-bookmark]'); const book = currentBook();
    if (jump) { const bookmark = book.bookmarks.find((x) => x.id === jump.dataset.bookmarkId); if (bookmark) { restorePosition(bookmark.position); if (innerWidth <= 1160) closePanels(); } }
    if (remove) { book.bookmarks = book.bookmarks.filter((x) => x.id !== remove.dataset.removeBookmark); renderBookmarks(); saveNow(); }
  });
  $('cancelConfirm').addEventListener('click', () => { pendingConfirm = null; $('confirmDialog').close(); });
  $('acceptConfirm').addEventListener('click', async () => { const action = pendingConfirm; pendingConfirm = null; $('acceptConfirm').disabled = true; try { if (action) await action(); $('confirmDialog').close(); } catch (error) { reportError(error, '删除失败'); } finally { $('acceptConfirm').disabled = false; } });
  $('showHelp').addEventListener('click', () => { closePanels(); $('helpDialog').showModal(); });
  $('exportBackup').addEventListener('click', exportBackup); $('restoreBackup').addEventListener('click', () => { if (!importing) $('backupInput').click(); }); $('backupInput').addEventListener('change', () => restoreBackup($('backupInput').files[0]));
  $('toggleFocus').addEventListener('click', () => setFocus(!document.body.classList.contains('focus-mode'))); $('exitFocus').addEventListener('click', () => setFocus(false));
  $('toggleShelf').addEventListener('click', () => { closePanels(); document.body.classList.add('shelf-open'); $('mobileBackdrop').hidden = false; });
  $('toggleSettings').addEventListener('click', () => {
    const open = !document.body.classList.contains('settings-open'); closePanels(); if (innerWidth <= 1160 && open) { document.body.classList.add('settings-open'); $('mobileBackdrop').hidden = false; $('toggleSettings').setAttribute('aria-expanded', 'true'); }
    else if (innerWidth > 1160) $('fontSize').focus();
  });
  $('mobileBackdrop').addEventListener('click', closePanels); $('closeSettings').addEventListener('click', closePanels);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { if (document.querySelector('dialog[open]')) return; closePanels(); if (document.body.classList.contains('focus-mode')) setFocus(false); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || document.querySelector('dialog[open]') || !currentBook()) return;
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); setFocus(!document.body.classList.contains('focus-mode')); }
    if (event.key.toLowerCase() === 'b') { event.preventDefault(); addBookmark(); }
    if (['PageDown', 'PageUp'].includes(event.key)) { event.preventDefault(); $('readerScroll').scrollBy({ top: $('readerScroll').clientHeight * .85 * (event.key === 'PageDown' ? 1 : -1) }); }
  });
  document.addEventListener('dragenter', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; } });
  document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) $('dropOverlay').hidden = true; });
  document.addEventListener('drop', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; importFiles([...event.dataTransfer.files]); } });
  window.addEventListener('blur', () => { dragDepth = 0; $('dropOverlay').hidden = true; });
  const observer = new ResizeObserver(() => { if (!currentBook() || state.restoring) return; clearTimeout(resizeTimer); const position = { ...currentBook().position }; resizeTimer = setTimeout(() => restorePosition(position), 100); });
  observer.observe($('readerScroll'));
  window.addEventListener('resize', () => { if (innerWidth > 1160) closePanels(); });
  window.addEventListener('pagehide', () => { capturePosition(); writeCheckpoint(); saveNow(); });
  document.addEventListener('visibilitychange', () => { tickTime = Date.now(); if (document.hidden) { capturePosition(); writeCheckpoint(); saveNow(); } });
  window.addEventListener('storage-blocked', () => toast('本地数据库已变化或被其他页面占用，请关闭其他拾页页面并刷新。'));
  setInterval(() => {
    const now = Date.now(); const elapsed = Math.min(5, Math.max(0, (now - tickTime) / 1000)); tickTime = now;
    if (!document.hidden && document.hasFocus() && currentBook() && !document.querySelector('dialog[open]')) {
      sessionSeconds += elapsed; currentBook().readingSeconds += elapsed;
      $('sessionMinutes').replaceChildren(document.createTextNode(String(Math.floor(sessionSeconds / 60))), element('span', '', ' 分钟'));
      if (Math.floor(sessionSeconds) % 15 === 0) scheduleSave();
    }
  }, 1000);
}

async function initialize() {
  try {
    await storage.openDatabase();
    const library = await storage.readLibrary();
    const states = new Map(library.states.map((x) => [x.id, normalizeBookState(x)]));
    library.books.forEach((book) => state.books.set(book.id, { ...book, ...normalizeBookState(states.get(book.id)) }));
    state.settings = normalizeSettings(library.meta.settings);
    state.currentId = state.books.has(library.meta.currentId) ? library.meta.currentId : [...state.books.keys()][0] || null;
    try {
      const checkpoint = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null');
      if (checkpoint && state.books.has(checkpoint.currentId)) {
        state.currentId = checkpoint.currentId; state.settings = normalizeSettings(checkpoint.settings);
        if (checkpoint.state?.id === state.currentId) Object.assign(currentBook(), normalizeBookState(checkpoint.state));
      }
    } catch { /* 损坏的辅助恢复点不影响数据库中的正式书架。 */ }
    if (!library.meta.initialized && !state.books.size) {
      const sample = await makeBook(SAMPLE_TITLE, SAMPLE_TEXT, '拾页原创');
      sample.lastRead = Date.now();
      await storage.writeBooks([sample], [stateRecord(sample)], { initialized: true, currentId: sample.id });
      state.books.set(sample.id, sample); state.currentId = sample.id;
    }
    state.initialized = true; bindEvents(); renderSettings(); renderShelf(); showReader();
  } catch (error) {
    console.error(error);
    $('bookList').textContent = '本地书架暂时无法打开。';
    $('fatalError').textContent = `无法打开阅读器：${error.message} 请通过 npm start 后访问 http://localhost:5173；允许网站使用本地存储，并避免禁用存储的隐私模式。`;
    $('fatalError').hidden = false; setSaveStatus('存储不可用', true);
  }
}
initialize();
