# 拾页 · 本地文本阅读器

为「比特工场 2026 秋招程序组考核」的文本阅读器方向实现。设计主题是“给阅读留一点空白”：浅色书架、纸张背景、柔和绿、无外部请求的私人阅读空间。初次使用会自动加入原创随笔《林间漫步》，可直接演示。

## 本地运行

需要 Node.js 18 或以上，不需要安装任何第三方依赖。

从 GitHub 获取项目：

```powershell
git clone https://github.com/pantheon-wei/wenbenyueduqi.git
cd wenbenyueduqi
npm start
```

本机已生成的源码目录可直接运行：

```powershell
cd D:\ojbk
npm start
```

打开 **http://localhost:5173**。按 Ctrl+C 停止。不要双击 `index.html`：ES 模块、数据库和内容摘要需要通过本地 HTTP 服务使用。

端口被占用时，在 PowerShell 中运行：

```powershell
$env:PORT = '5174'
npm start
```

浏览器数据按访问来源隔离；`localhost:5173`、`127.0.0.1:5173` 和不同端口是不同书架。尽量一直使用同一个地址。

## 功能与题目对应

| 考核要求 | 实现与验证 |
| --- | --- |
| 打开 / 导入文本 | 点击导入、拖入 TXT/MD/TEXT 文件、多文件导入、粘贴文本；自动或手动选择编码 |
| 书架增删与选择 | 导入即新增；点击书籍切换；删除二次确认；搜索和排序；同正文自动去重 |
| 字号调节 | 14–36 px，滑块或 A−/A+；排版变化保留段落位置 |
| 背景色调整 | 纸白、暖砂、青苔、夜读、自定义颜色；自动选择深色或浅色正文 |
| 护眼模式 | 独立开关切换柔和绿底；关闭后回到之前的主题；支持持久化 |
| 阅读进度保存 | 自动存储段落索引、段内比例和百分比；刷新、切书、重新打开后恢复 |
| 本地存储和状态管理 | IndexedDB 存正文、书签、进度、设置；小型 localStorage 恢复点处理页面退出 |
| 创新和交互 | 章节目录、书签、专注模式、阅读时间、进度跳转、完整备份恢复、桌面/手机布局 |

导入上限为每本 10 MB、40,000 个非空段落，书架最多 200 本。文件支持 UTF-8、GB18030/GBK、UTF-16 LE/BE；无 BOM 的 UTF-16 需手动选择。自动识别不是任意编码检测器，如果乱码请手选正确编码。MD 按纯文本阅读，仅识别一级至三级标题，不渲染 Markdown 排版。

## 数据与隐私

- 正文不上传服务器；本地 Node 服务仅提供静态文件。应用无登录、无远程字体、无外部接口。
- 数据只保存在当前浏览器/当前网址中。清理网站数据、无痕模式结束或卸载浏览器可能丢失数据，建议定期备份。
- 「备份」导出正文、阅读位置、书签、设置；JSON 文件最多 60 MB。「恢复」按正文 SHA-256 合并，以较新的最后阅读时间决定同内容书籍的状态。空备份不会清空已有书架。
- 删除只删除本地数据库记录，不会删除用户的原始文件。备份文件也不会自动删除，请自行保管。
- 建议单个浏览器标签页编辑同一书架；跨标签页不是实时协作。书架数据无跨设备自动同步。
- 护眼模式是配色功能，不代表医学保护；长时间阅读仍需合理休息。
- 本次阅读时间按页面可见、窗口获得焦点且没有弹窗时累计；刷新后本次计时重新开始。剩余时间是按 400 字/分钟得到的估计值。

## 技术栈和文件

原生 HTML5 / CSS3 / JavaScript ES Modules，IndexedDB、localStorage、Web Crypto、TextDecoder、ResizeObserver。Node.js 内置 HTTP 静态服务和内置 test runner，无构建工具和第三方包。

```text
index.html              页面结构和弹窗
src/styles.css          布局、主题、响应式和专注模式
src/app.js              状态管理、事件、渲染和读写协调
src/core.js             文本解码、目录解析、位置算法、数据校验
src/storage.js          IndexedDB 数据访问
src/sample.js           原创演示书
server.mjs              本地静态服务
samples/导入演示.txt     文件导入验收素材
tests/core.test.mjs      核心数据和阅读位置测试
docs/AI开发记录.md       AI 使用记录与待补充的个人理解记录
docs/答辩与验收.md       5 分钟演示、10 分钟讲解、选型原因
```

## 验证

```powershell
npm run check
npm test
```

核心测试覆盖文本解码、章节解析、内容去重、字号变化后的位置恢复、边界值和备份校验。界面验收流程见 `docs/答辩与验收.md`；测试结果和实际验证范围见 `docs/验证记录.md`。

另一个终端保持服务运行时，可执行 `npm run test:browser` 进行浏览器集成验收。该脚本默认使用 Windows Edge 的独立测试配置；其他环境可通过 `BROWSER_PATH` 指定兼容 Chromium 的浏览器路径。测试截图、下载和独立配置位于 Git 忽略的 `test-results/`，不会使用你的日常浏览器配置。

## 交付与源码仓库

源码仓库：[pantheon-wei/wenbenyueduqi](https://github.com/pantheon-wei/wenbenyueduqi)。当前目录已关联该仓库，后续修改可执行：

```powershell
git add .
git commit -m "改进拾页文本阅读器"
git push -u origin main
```

本地运行说明已满足题目“部署链接或本地运行说明”的要求。如果要在线展示，可将 `index.html`、`src/`、`assets/`、`samples/` 部署到任何支持 HTTPS 的静态站点，例如 GitHub Pages；不需要 Node 后端。更换部署网址后请用备份恢复迁移书架。

这份项目由 AI 根据考核要求协助开发。提交前请阅读答辩文档、实际修改一个功能，并如实补充个人验证和理解记录；能运行并不等于已掌握全部实现。
