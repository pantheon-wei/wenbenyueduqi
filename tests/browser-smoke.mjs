// 使用独立、临时浏览器配置测试应用，不接触日常浏览器的书架或其他用户数据。
// Windows 默认使用 Edge；可通过 BROWSER_PATH 指定 Chrome/Edge 可执行文件。
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const profile = path.join(output, `browser-profile-${Date.now()}`);
const browserPath = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 19333;
const baseUrl = process.env.READER_URL || 'http://localhost:5173';
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws, sequence = 0;
const waiting = new Map();
const errors = [];
const pass = (text) => console.log(`✓ ${text}`);
browser.on('error', (error) => errors.push(error.message));

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    waiting.set(id, { resolve: (result) => { clearTimeout(timeout); resolve(result); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
  return result.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error(`条件未满足：${expression}`);
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function input(selector, value) {
  await evaluate(`{ const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); }`);
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, name), Buffer.from(result.data, 'base64'));
}
async function setFiles(selector, files) {
  const doc = await send('DOM.getDocument');
  const result = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: result.nodeId, files });
}
const position = `new Promise((resolve,reject)=>{ const r=indexedDB.open('leaf-reader'); r.onerror=()=>reject(r.error); r.onsuccess=()=>{const db=r.result;const tx=db.transaction(['states','meta']);const m=tx.objectStore('meta').get('currentId');m.onsuccess=()=>{const s=tx.objectStore('states').get(m.result.value);s.onsuccess=()=>resolve(s.result)};tx.oncomplete=()=>db.close()}; })`;
const settled = `document.querySelector('#saveStatus').textContent.includes('已自动保存')`;

try {
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); if (targets.length) break; } catch { }
    await delay(100);
  }
  assert.ok(targets?.length, `浏览器无法启动 ${errors.join(',')}`);
  ws = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const pending = waiting.get(message.id); waiting.delete(message.id); if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: baseUrl });
  await waitFor(`document.querySelector('#readerTitle')?.textContent === '林间漫步'`);
  await waitFor(settled);
  assert.equal(await evaluate(`document.querySelector('#bookCount').textContent`), '1');
  await screenshot('desktop.png'); pass('首次加载、示例书、桌面布局');

  await input('#readingProgress', '45'); await waitFor(settled);
  await click('#addBookmark'); await waitFor(settled);
  const before = await evaluate(position);
  assert.equal(before.bookmarks.length, 1); assert.ok(before.position.progress > .44 && before.position.progress < .46);
  await input('#fontSize', '26'); await waitFor(settled);
  const after = await evaluate(position);
  assert.equal(after.position.index, before.position.index); assert.ok(Math.abs(after.position.fraction - before.position.fraction) < .02);
  await click('[data-theme="night"]'); await waitFor(settled);
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--reader-bg').trim()`), '#252e29');
  await click('#eyeMode'); await waitFor(settled);
  assert.equal(await evaluate(`document.querySelector('#eyeMode').getAttribute('aria-checked')`), 'true');
  await click('#eyeMode'); await waitFor(settled);
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--reader-bg').trim()`), '#252e29');
  await input('#customBackground', '#000000'); await waitFor(settled);
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--reader-ink').trim()`), '#edf1e9');
  await click('[data-theme="paper"]'); await waitFor(settled);
  pass('进度跳转、书签、字号锚点、背景色、护眼、自定义颜色');

  const preReload = await evaluate(position);
  await send('Page.reload'); await waitFor(`document.querySelector('#readerTitle')?.textContent === '林间漫步'`); await waitFor(settled);
  const restored = await evaluate(position);
  assert.equal(restored.position.index, preReload.position.index);
  assert.equal(restored.bookmarks.length, 1); assert.equal(await evaluate(`document.querySelector('#fontSize').value`), '26');
  pass('刷新后恢复阅读进度、书签和排版');

  await click('#toggleOutline'); await click('#outlineList button:nth-child(5)'); await waitFor(settled);
  await waitFor(`document.querySelector('#currentChapter').textContent.includes('第五章')`);
  assert.ok((await evaluate(`document.querySelector('#currentChapter').textContent`)).includes('第五章'));
  await click('#bookmarkList .bookmark-jump'); await waitFor(settled);
  assert.equal((await evaluate(position)).position.index, before.position.index);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF' });
  assert.equal(await evaluate(`document.body.classList.contains('focus-mode')`), true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  assert.equal(await evaluate(`document.body.classList.contains('focus-mode')`), false); await waitFor(settled);
  pass('章节跳转、书签定位、专注模式快捷键');

  const utf16 = path.join(output, 'UTF16测试.txt'); await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一章 编码\n这是 UTF16 的中文内容。', 'utf16le')]));
  const gbk = path.join(output, 'GBK测试.txt'); await writeFile(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  const empty = path.join(output, '空文件.txt'); await writeFile(empty, '');
  await click('.sidebar-import');
  await setFiles('#fileInput', [path.join(root, 'samples', '导入演示.txt'), utf16, gbk]);
  await waitFor(`document.querySelector('#bookCount').textContent === '4' && !document.querySelector('#importDialog').open`);
  await waitFor(settled); pass('UTF-8、UTF-16、GBK 多文件实际导入');
  await click('.sidebar-import'); await setFiles('#fileInput', [path.join(root, 'samples', '导入演示.txt')]);
  await waitFor(`!document.querySelector('#importDialog').open`);
  assert.equal(await evaluate(`document.querySelector('#bookCount').textContent`), '4');
  await click('.sidebar-import'); await setFiles('#fileInput', [empty]);
  await waitFor(`document.querySelector('#importMessage').textContent.includes('文本为空')`);
  await click('[data-close="importDialog"]'); pass('内容去重、空文件错误提示');

  await click('.sidebar-import'); await click('#pasteTab'); await input('#pasteTitle', '安全测试 <img src=x>');
  await input('#pasteContent', '第一章 测试\n<script>window.HACKED=true</script>\n这是一段普通文字。');
  await click('#pasteSubmit'); await waitFor(`document.querySelector('#bookCount').textContent === '5'`); await waitFor(settled);
  assert.equal(await evaluate(`window.HACKED === undefined && document.querySelector('#readingContent script') === null`), true);
  await input('#shelfSearch', '安全测试'); assert.equal(await evaluate(`document.querySelectorAll('.book-item').length`), 1);
  await click('#bookList .book-delete'); await click('#cancelConfirm'); assert.equal(await evaluate(`document.querySelector('#bookCount').textContent`), '5');
  await click('#bookList .book-delete'); await click('#acceptConfirm'); await waitFor(`document.querySelector('#bookCount').textContent === '4'`);
  await input('#shelfSearch', ''); pass('粘贴、安全文本输出、搜索、删除取消与确认');

  const backupData = await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('leaf-reader');r.onsuccess=()=>{const db=r.result;const tx=db.transaction(['books','states']);const b=tx.objectStore('books').getAll();const s=tx.objectStore('states').getAll();tx.oncomplete=()=>{const m=new Map(s.result.map(x=>[x.id,x]));resolve({format:'leaf-reader',version:1,books:b.result.map(x=>({...x,...m.get(x.id)})),settings:{fontSize:24,theme:'warm'}});db.close()};r.onerror=()=>reject(r.error)}})`);
  const backupFile = path.join(output, '恢复测试.json'); await writeFile(backupFile, JSON.stringify(backupData));
  const corruptFile = path.join(output, '损坏备份.json'); await writeFile(corruptFile, '{oops');
  await click('#bookList .book-delete'); await click('#acceptConfirm'); await waitFor(`document.querySelector('#bookCount').textContent === '3'`);
  await setFiles('#backupInput', [backupFile]); await waitFor(`document.querySelector('#bookCount').textContent === '4'`); await waitFor(settled);
  assert.equal(await evaluate(`document.querySelector('#fontSize').value`), '24');
  await setFiles('#backupInput', [corruptFile]); await waitFor(`document.querySelector('#toast').textContent.includes('恢复失败')`);
  assert.equal(await evaluate(`document.querySelector('#bookCount').textContent`), '4');
  await evaluate(`Array.from(document.querySelectorAll('.book-select')).find(x=>x.querySelector('.book-title').textContent==='林间漫步').click()`);
  await waitFor(`document.querySelector('#readerTitle').textContent==='林间漫步'`); await waitFor(settled);
  assert.equal((await evaluate(position)).bookmarks.length, 1);
  await input('#readingProgress', '100'); await waitFor(settled);
  assert.equal((await evaluate(position)).position.progress, 1);
  await send('Page.reload'); await waitFor(`document.querySelector('#readerTitle')?.textContent==='林间漫步'`); await waitFor(settled);
  assert.equal((await evaluate(position)).position.progress, 1);
  await input('#readingProgress', '0'); await waitFor(settled);
  assert.equal((await evaluate(position)).position.progress, 0);
  await click('#eyeMode'); await waitFor(settled);
  await send('Page.reload'); await waitFor(`document.querySelector('#readerTitle')?.textContent==='林间漫步'`); await waitFor(settled);
  assert.equal(await evaluate(`document.querySelector('#eyeMode').getAttribute('aria-checked')`), 'true');
  await click('#eyeMode'); await waitFor(settled);
  pass('切书恢复原书书签、进度 0%/100%、阅读完毕和护眼模式刷新恢复');
  // 通过浏览器下载路径验证导出，而不只是检查生成函数。
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
  await click('#exportBackup'); await waitFor(`document.querySelector('#toast').textContent.includes('备份已导出')`);
  pass('备份恢复合并、设置恢复、损坏备份保护、备份导出');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await delay(250);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390`), true);
  await click('#toggleShelf'); assert.equal(await evaluate(`getComputedStyle(document.querySelector('#sidebar')).display !== 'none'`), true);
  await click('#mobileBackdrop'); await click('#toggleSettings'); assert.equal(await evaluate(`getComputedStyle(document.querySelector('#settingsPanel')).display !== 'none'`), true);
  await click('#closeSettings'); await screenshot('mobile.png'); pass('手机宽度、书架抽屉、设置抽屉、无页面横向溢出');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false }); await delay(250);
  for (let i = 0; i < 4; i++) { await click('#bookList .book-delete'); await click('#acceptConfirm'); await waitFor(`document.querySelector('#bookCount').textContent === '${3 - i}'`); }
  assert.equal(await evaluate(`document.querySelector('#welcome').hidden`), false);
  await send('Page.reload'); await waitFor(`document.querySelector('#bookCount')?.textContent === '0' && !document.querySelector('#welcome').hidden`);
  await click('#loadSample'); await waitFor(`document.querySelector('#bookCount').textContent === '1'`);
  pass('删除最后一本、空书架刷新、重新添加示例');
  assert.deepEqual(errors, []); pass('无未捕获浏览器 JavaScript 异常');
  console.log(`\n浏览器验收全部通过。截图和测试下载位于：${output}`);
} catch (error) {
  console.error(error);
  if (ws?.readyState === WebSocket.OPEN) await screenshot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); ws.close(); }
  browser.kill();
}
