//把书籍和阅读数据保存到浏览器数据库
const DB_NAME = 'leaf-reader';
const DB_VERSION = 1;
let database;

function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function transactionResult(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || new Error('本地存储事务已中止')); tx.onerror = () => {}; });
}

export async function openDatabase() {
  if (!globalThis.indexedDB) throw new Error('浏览器不支持 IndexedDB，请使用最新版 Edge、Chrome 或 Firefox。');
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('books', { keyPath: 'id' });
    db.createObjectStore('states', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  request.onblocked = () => window.dispatchEvent(new CustomEvent('storage-blocked'));
  database = await requestResult(request);
  database.onversionchange = () => { database.close(); window.dispatchEvent(new CustomEvent('storage-blocked')); };
}

export async function readLibrary() {
  const tx = database.transaction(['books', 'states', 'meta'], 'readonly');
  const done = transactionResult(tx);
  const values = await Promise.all([
    requestResult(tx.objectStore('books').getAll()), requestResult(tx.objectStore('states').getAll()), requestResult(tx.objectStore('meta').getAll())
  ]);
  await done;
  return { books: values[0], states: values[1], meta: Object.fromEntries(values[2].map((x) => [x.key, x.value])) };
}

export async function writeBooks(books, states = [], meta = {}) {
  const tx = database.transaction(['books', 'states', 'meta'], 'readwrite');
  const done = transactionResult(tx);
  books.forEach((x) => tx.objectStore('books').put(x));
  states.forEach((x) => tx.objectStore('states').put(x));
  Object.entries(meta).forEach(([key, value]) => tx.objectStore('meta').put({ key, value }));
  await done;
}

export async function writeState(state, settings, currentId) {
  // 正文和高频更新的阅读状态分开，滚动时无需重写整本书。
  const tx = database.transaction(['states', 'meta'], 'readwrite');
  const done = transactionResult(tx);
  if (state) tx.objectStore('states').put(state);
  tx.objectStore('meta').put({ key: 'settings', value: settings });
  tx.objectStore('meta').put({ key: 'currentId', value: currentId });
  await done;
}

export async function deleteBook(id) {
  const tx = database.transaction(['books', 'states', 'meta'], 'readwrite');
  const done = transactionResult(tx);
  tx.objectStore('books').delete(id);
  tx.objectStore('states').delete(id);
  await done;
}
