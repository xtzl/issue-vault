# 开发交接说明

> 这份文档是给「换一台电脑继续开发」或「换一个 AI 会话」用的。读一遍就知道这个项目是什么、怎么跑、改哪里。

---

## 一句话说明

给客服岗位用的**问题处置经验库**：登记问题现象、解决方法、截图，以后遇到同类问题搜索复用。纯静态网页，部署在 GitHub Pages，数据存在浏览器 IndexedDB，可自动备份到本地文件夹。

- 线上地址：https://xtzl.github.io/issue-vault/
- 仓库：https://github.com/xtzl/issue-vault （public，GitHub Pages 免费版要求公开）
- 用户：客服专员，非程序员，沟通用中文，偏好「结论先行 + 可直接操作」

## 技术栈

纯 HTML / CSS / 原生 JS（IIFE，无模块打包），无框架、无构建步骤。

```
index.html                    单页应用，所有视图都在里面
assets/css/style.css          全部样式，浅色/深色用 CSS 变量
assets/js/db.js               IndexedDB 封装（records / images / meta 三个 store）
assets/js/importer.js         Excel/CSV 解析与列名自动识别
assets/js/app.js              主逻辑：路由、渲染、表单、搜索、提醒、备份
assets/vendor/xlsx.full.min.js  SheetJS 0.20.3（按需加载，不阻塞首屏）
```

### 本地怎么跑

```bash
cd issue-vault
python -m http.server 8765
# 浏览器打开 http://127.0.0.1:8765
```

**必须用 http 访问**，不要双击 index.html（`file://` 下 IndexedDB 和文件 API 会受限）。

### 数据模型

```js
// records store
{
  id, title, occurredAt: 'YYYY-MM-DD', category, customer,
  sessionId,        // 会话 ID（客服系统里的会话编号，搜索权重最高）
  phone,            // 顾客电话
  channel,          // 历史字段「来源渠道」，新数据为空，编辑旧记录时显示为「原来源渠道」
  status,           // 已解决 / 跟进中 / 未解决
  problem, solution, note,
  problemImages: [imageId], solutionImages: [imageId],
  tags: [], star: bool, useCount: number,
  remindAt: 'YYYY-MM-DDTHH:mm', remindDone: bool,
  source: 'manual' | 'import',
  createdAt, updatedAt   // 毫秒时间戳
}

// images store
{ id, full: Blob, thumb: Blob, w, h, size, thumbSize, type, name, createdAt }

// meta store（key-value）
categories / backupDir（FileSystemDirectoryHandle）/ autoBackup /
lastBackupAt / backupFileRecords / backupFileCount
```

## 已实现的功能

| 功能 | 关键代码位置 |
|---|---|
| 登记/编辑表单 | `openEditor()`、`collectForm()`、`saveForm()` |
| 图片压缩上传（拖拽/粘贴） | `DB.addImage()`、`addFilesToUploader()`、`currentUploaderKind()` |
| 问题库列表 + 搜索 + 筛选 | `filteredRecords()`、`relevanceScore()`、`renderLibrary()` |
| 详情抽屉 + 图片灯箱 | `openDrawer()`、`openLightbox()` |
| Excel/CSV 导入（含 GBK） | `assets/js/importer.js`、`handleImportFile()`、`doImport()` |
| 导出备份 / CSV | `exportBackup()`、`toCSV()` |
| 自动备份到本地文件夹 | `runAutoBackup()`、`initBackupSync()`、`scheduleAutoBackup()` |
| 多浏览器共用同一备份文件 | `DB.mergeFromBackup()`、`syncFromBackup()` |
| 单条记录定时提醒 | `dueReminders()`、`checkRecordReminders()`、`showRecordReminder()` |
| 每日待跟进提示 | `checkFollowUps()` |

## 踩过的坑（改代码前务必看）

1. **IndexedDB 事务会自动提交**
   同一个事务里 `await` 之后再发请求会抛 `TransactionInactiveError`。要么同时发出多个请求再 `Promise.all`，要么分开事务。`usage()`、`exportBackup()` 都踩过。

2. **不要用 `backdrop-filter`**
   抽屉遮罩上加 `blur(1px)`，滚动帧率从 60 掉到 20（实测）。浮层一律不用实时模糊。

3. **详情图片要用原图**
   拿 360px 缩略图放进 520px 容器会糊。`fillThumbs()` 里用 `data-full-img` 标记的取 `full`。

4. **`[hidden]` 会被 `display:flex` 覆盖**
   CSS 里已全局加 `[hidden]{display:none!important}`，别删。

5. **粘贴图片要跟随焦点**
   `currentUploaderKind()` 按 `document.activeElement` 判断落到哪一侧，不能只看「最后点过的上传区」。

6. **git push 经常被代理拦截（502）**
   `github.com` 通不了但 `api.github.com` 正常时，用 Git Data API 提交：
   仓库里没有这个脚本，历史记录在开发机上。思路：`ref → commit.tree → blobs → trees(base_tree) → commits → PATCH ref`。

7. **`git fetch` 失败后不要 `reset --hard`**
   origin/main 还是旧引用，会把工作区回退。先确认 fetch 成功。

## 部署

推送到 `main` 分支后，GitHub Pages 自动构建（约 30-60 秒）。

验证是否生效：

```bash
curl -s "https://xtzl.github.io/issue-vault/?v=$(date +%s)" | grep -c 某个新加的id
```

带上 `?v=时间戳` 绕过 CDN 缓存（默认缓存 10 分钟）。

## 用户明确提过的偏好

- 字段调整：来源渠道 → **会话 ID** + **电话**（他会拿会话 ID 反查记录，搜索权重最高）
- 提醒：**跟着每条记录走的时间点**，不是周期性提醒。他会把时间设在自己一定在电脑前的时候（如早 9 点、晚 8 点）
- 数据焦虑：**很在意清缓存/换浏览器丢数据**，所以自动备份是重点功能，不是可选项
- 用 **Chrome 和 Edge**，公司电脑；Chrome 的 File System Access 可能被策略限制
- 不要给他看不懂的技术解释，要「点哪里、会看到什么」

## 还没做 / 可以改进的方向

- [ ] 删除操作无法跨浏览器同步（需要墓碑机制）
- [ ] 大数据量（几百条 + 上千张图）时，全量写 JSON 会变慢，可考虑图片单独存文件
- [ ] 列表没有虚拟滚动，记录上千条时渲染会变慢
- [ ] 没有月度统计报表导出
- [ ] 提醒只有页面打开时才触发，可以做 Service Worker 后台通知（复杂，收益有限）

## 给新会话 AI 的提示词

在新电脑上，把下面这段发给 WorkBuddy：

```
这个项目是从 GitHub 克隆下来的「问题手册」，先读 DEVELOPMENT.md 和 README.md。

它是纯静态网页（HTML/CSS/原生JS），数据存 IndexedDB，
部署在 https://xtzl.github.io/issue-vault/。

我要改的地方是：______

改之前请先本地起服务（python -m http.server 8765）验证，
改完告诉我怎么推送到 GitHub。
```

---

最后更新：2026-11-09
