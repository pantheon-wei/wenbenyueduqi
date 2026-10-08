import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, parseText, decodeText, contentId, normalizeSettings, contrastColor, normalizePosition, normalizeBookState, positionFromScroll, scrollFromPosition, validateBackup } from '../src/core.js';

test('中文、英文和 Markdown 章节识别，同时保留普通正文', () => {
  const result = parseText('\uFEFF第一章 清晨\r\n\r\n  第一段文字。\r\n## 第二段\nChapter 3 The path\n不是章节的正文');
  assert.deepEqual(result.chapters.map((x) => x.title), ['第一章 清晨', '第二段', 'Chapter 3 The path']);
  assert.equal(result.blocks[1].text, '第一段文字。');
  assert.equal(result.blocks[4].heading, false);
});
test('处理 BOM、Windows 换行、空文本和 NUL', () => {
  assert.equal(normalizeText('\uFEFF a\r\nb\r\u0000 '), 'a\nb');
  assert.deepEqual(parseText(' \n ').blocks, []);
});
test('自动识别 UTF-8、GBK、UTF-16 LE 和 BE，错误编码明确失败', () => {
  assert.equal(decodeText(new TextEncoder().encode('你好').buffer), '你好');
  assert.equal(decodeText(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]).buffer), '你好');
  assert.equal(decodeText(Uint8Array.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]).buffer), '你好');
  assert.equal(decodeText(Uint8Array.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d]).buffer), '你好');
  assert.throws(() => decodeText(Uint8Array.from([0xff]).buffer, 'utf-8'));
});
test('内容去重忽略换行格式和首尾空白，并区分不同正文', async () => {
  assert.equal(await contentId('a\r\nb '), await contentId('a\nb'));
  assert.notEqual(await contentId('正文 A'), await contentId('正文 B'));
});
test('字号变化后的段落定位和末尾恢复', () => {
  const oldTops = [30, 150, 300, 550];
  const position = positionFromScroll(oldTops, 375, 600);
  assert.equal(position.index, 2);
  assert.equal(position.fraction, .3);
  assert.equal(scrollFromPosition([30, 220, 500, 900], position, 1100), 620);
  assert.equal(scrollFromPosition(oldTops, { index: 0, fraction: 0, progress: 0 }, 600), 0);
  assert.equal(scrollFromPosition(oldTops, { index: 2, progress: 1 }, 600), 600);
  assert.equal(scrollFromPosition(oldTops, { index: 999, progress: .5 }, 600), 300);
});
test('无滚动正文以及超出边界的进度不会产生 NaN', () => {
  assert.equal(positionFromScroll([20], 0, 0).progress, 1);
  assert.equal(scrollFromPosition([], {}, 0), 0);
  assert.deepEqual(normalizePosition({ index: -8, fraction: 9, progress: NaN }), { index: 0, fraction: 1, progress: 0 });
});
test('设置及备份的非法值被限制，不允许注入 CSS 值', () => {
  const settings = normalizeSettings({ fontSize: 999, lineHeight: 0, theme: 'evil', customBackground: 'red;display:none', eyeMode: 'yes' });
  assert.equal(settings.fontSize, 36); assert.equal(settings.lineHeight, 1.4); assert.equal(settings.theme, 'paper'); assert.equal(settings.customBackground, '#f5f1e8'); assert.equal(settings.eyeMode, false);
  assert.equal(normalizeSettings(null).fontSize, 20);
  assert.equal(contrastColor('#000000'), '#edf1e9'); assert.equal(contrastColor('#ffffff'), '#29372c');
});
test('备份校验与阅读状态恢复，拒绝错误格式、空正文和超大正文', () => {
  const backup = { format: 'leaf-reader', version: 1, books: [{ title: '测试', content: '第一章 开始\n正文', position: { index: 1, fraction: .5, progress: .6 }, bookmarks: [{ id: 'one', label: '<script>危险</script>', position: { index: 1 } }] }] };
  const result = validateBackup(backup);
  assert.equal(result.books[0].position.progress, .6);
  assert.equal(result.books[0].bookmarks[0].label, '<script>危险</script>');
  assert.throws(() => validateBackup({ books: [] }));
  assert.throws(() => validateBackup({ ...backup, books: [{ title: '空书', content: '  ' }] }));
  assert.throws(() => validateBackup({ ...backup, books: [{ title: '大书', content: 'x'.repeat(10 * 1024 * 1024 + 1) }] }));
  assert.deepEqual(normalizeBookState(null).bookmarks, []);
});
