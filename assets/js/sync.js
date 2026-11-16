/* ===========================================================
   问题手册 · 局域网同步（浏览器端）
   -----------------------------------------------------------
   把网页本地 IndexedDB 与电脑上运行的 vault-sync 服务对接，
   让手机 App、电脑网页看到同一份数据。

   设计要点
   - 记录级 last-write-wins：只比较 updatedAt
   - 删除走服务端墓碑（deleted:true），拉到时才真正删本地
   - 增量水位线取「服务器时间 - 5 秒」：宁可重复拉，绝不漏
   - 推送失败进重试队列，重放时从 IndexedDB 重新读最新内容，
     避免把内存里的旧对象覆盖回去
   - 图片按需上传：记录保存后静默把引用到的图片推到服务端，
     已传过的记在 localStorage，不重复传
   =========================================================== */
window.VaultSync = (function () {
  'use strict';

  if (!window.VaultDB) {
    console.warn('[sync] 需要先加载 db.js');
    return {
      bootstrap: async function () {},
      syncNow: async function () {},
      pushAll: async function () {},
      getState: function () { return { status: 'off' }; }
    };
  }

  var DB = window.VaultDB;

  var K = {
    enabled: 'vault-sync-enabled',
    server: 'vault-sync-server',
    since: 'vault-sync-since',
    pending: 'vault-sync-pending',
    imgs: 'vault-sync-imgs'
  };

  var POLL_MS = 15000;     // 增量拉取间隔
  var DEBOUNCE_MS = 400;   // 本地改动后多久推送
  var TIMEOUT_MS = 9000;   // 常规请求超时
  var FIRST_MS = 2500;     // 首屏拉取超时（服务器没开时别卡住页面）
  var SAFETY_GAP = 5000;   // 水位线安全回退量

  var st = {
    enabled: false,
    server: '',
    since: 0,
    status: 'off',        // off | idle | syncing | ok | error
    message: '',
    lastPullAt: 0,
    lastErrorAt: 0,
    pending: new Set(),   // 待推送的记录 id
    pendingDel: new Set(),// 待推送的删除 id
    imgs: new Set(),      // 已上传的图片 id
    imgQueue: new Set(),  // 待上传图片的记录 id
    imgTotal: 0,          // 本轮要传的图片张数
    imgDone: 0,           // 本轮已传张数
    upload: { phase: 'idle', total: 0, done: 0, message: '' },
    pushTimer: null,
    pollTimer: null,
    busy: false,
    silent: true,         // 首次拉取期间不触发 UI 刷新回调
    mounted: false,
    onRemoteChange: null  // 由 app.js 注入，拉到新数据后调用
  };

  /* ---------------------------------------------------------- 小工具 */

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ }
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
    });
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function relTime(ts) {
    if (!ts) return '从未';
    var d = Date.now() - ts;
    if (d < 5000) return '刚刚';
    if (d < 60000) return Math.floor(d / 1000) + ' 秒前';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  /* ---------------------------------------------------------- 配置 */

  function trimSlash(s) {
    return String(s || '').trim().replace(/\/+$/, '');
  }

  /**
   * 当前页面是不是就跑在服务器本机上？
   * 判断依据：同步地址的 host 和当前页面的 host 一致。
   * 是的话这个浏览器就是"数据源"，不该出现"推送到服务器"这类按钮（推给自己没意义）。
   */
  function isLocalServer() {
    if (!st.server) return false;
    try {
      return new URL(st.server).host === location.host;
    } catch (e) {
      return false;
    }
  }

  function defaultServer() {
    // 页面里可以用 window.VAULT_SYNC_SERVER 强制指定（离线包用它指回公司服务器）
    var forced = String(window.VAULT_SYNC_SERVER || '').trim();
    if (forced) return trimSlash(forced);

    // 从同步服务托管的页面打开时（端口 8765），默认就用当前地址
    var port = (location.port || '');
    if (port === '8765') return location.origin;
    return '';
  }

  function loadConfig() {
    var saved = lsGet(K.server);
    st.server = trimSlash(saved === null ? defaultServer() : saved);

    var en = lsGet(K.enabled);
    if (en === null) {
      st.enabled = !!st.server;
    } else {
      st.enabled = en === '1' && !!st.server;
    }

    st.since = Number(lsGet(K.since) || 0) || 0;

    try {
      var p = JSON.parse(lsGet(K.pending) || 'null');
      if (p && Array.isArray(p.put)) st.pending = new Set(p.put);
      if (p && Array.isArray(p.del)) st.pendingDel = new Set(p.del);
    } catch (e) { /* ignore */ }

    try {
      var im = JSON.parse(lsGet(K.imgs) || 'null');
      if (Array.isArray(im)) st.imgs = new Set(im);
    } catch (e) { /* ignore */ }

    st.status = st.enabled ? 'idle' : 'off';
  }

  function persistPending() {
    lsSet(K.pending, JSON.stringify({
      put: Array.from(st.pending).slice(0, 2000),
      del: Array.from(st.pendingDel).slice(0, 2000)
    }));
  }

  function persistImgs() {
    // 集合太大就重置，最多重复上传一轮，不影响正确性
    var arr = Array.from(st.imgs);
    if (arr.length > 6000) {
      st.imgs = new Set(arr.slice(-3000));
      arr = Array.from(st.imgs);
    }
    lsSet(K.imgs, JSON.stringify(arr));
  }

  /* ---------------------------------------------------------- 请求 */

  function api(pathname, opts) {
    opts = opts || {};
    if (!st.server) return Promise.reject(new Error('未配置同步服务器'));

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = opts.timeout || TIMEOUT_MS;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, timeout);

    var init = {
      method: opts.method || 'GET',
      cache: 'no-store',
      headers: opts.headers || {}
    };
    if (opts.body) init.body = opts.body;
    if (ctrl) init.signal = ctrl.signal;

    return fetch(st.server + pathname, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          throw new Error((data && data.error) || ('服务器返回 ' + res.status));
        }
        return data;
      });
    }).then(function (v) {
      clearTimeout(timer);
      return v;
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error('连接超时（' + Math.round(timeout / 1000) + ' 秒）');
      }
      if (err instanceof TypeError) {
        throw new Error('连不上服务器，请确认电脑上的同步服务已启动');
      }
      throw err;
    });
  }

  /* ---------------------------------------------------------- 落地远程数据 */

  /**
   * 把服务端返回的记录合并进本地 IndexedDB。
   * 返回实际新增/更新的条数。
   */
  async function applyRemote(list) {
    if (!Array.isArray(list) || !list.length) return 0;

    var local = await DB.allRecords();
    var map = new Map();
    local.forEach(function (r) { if (r && r.id) map.set(r.id, r); });

    var toPut = [];
    var toDel = [];
    var candidates = new Set(); // 可能变成孤儿的图片 id
    var n = 0;

    function imgsOf(rec) {
      return [].concat(rec.problemImages || [], rec.solutionImages || []).filter(Boolean);
    }

    list.forEach(function (r) {
      if (!r || !r.id) return;
      var cur = map.get(r.id);

      if (r.deleted) {
        // 服务端墓碑：本地有就删掉，并记下不复活
        if (cur) {
          toDel.push(r.id);
          imgsOf(cur).forEach(function (i) { candidates.add(i); });
        }
        return;
      }
      if (!cur) {
        toPut.push(r);
        n++;
        return;
      }
      if ((r.updatedAt || 0) > (cur.updatedAt || 0)) {
        toPut.push(r);
        n++;
        // 旧版本有、新版本没有的图，可能是孤儿
        var keep = new Set(imgsOf(r));
        imgsOf(cur).forEach(function (i) { if (!keep.has(i)) candidates.add(i); });
      }
    });

    var db = await DB.open();

    if (toPut.length) {
      var tx = db.transaction('records', 'readwrite');
      var store = tx.objectStore('records');
      toPut.forEach(function (r) { store.put(r); });
      await txDone(tx);
    }
    if (toDel.length) {
      var tx2 = db.transaction('records', 'readwrite');
      var store2 = tx2.objectStore('records');
      toDel.forEach(function (id) { store2.delete(id); });
      await txDone(tx2);
    }

    // 关键：删完记录后把不再被引用的图片一起删掉。
    // 以前漏了这步，别处删掉的记录，图片会永远留在这台机器上，本地占用只涨不降。
    if (candidates.size) {
      try {
        var remain = await DB.allRecords();
        var used = new Set();
        remain.forEach(function (r) {
          imgsOf(r).forEach(function (i) { used.add(i); });
        });
        var orphans = Array.from(candidates).filter(function (i) { return !used.has(i); });
        if (orphans.length) {
          var tx3 = db.transaction('images', 'readwrite');
          var s3 = tx3.objectStore('images');
          orphans.forEach(function (i) { s3.delete(i); });
          await txDone(tx3);
          console.log('[sync] 清理孤儿图片 ' + orphans.length + ' 张');
        }
      } catch (e) {
        console.warn('[sync] 清理孤儿图片失败', e.message);
      }
    }

    return n;
  }

  /* ---------------------------------------------------------- 拉取 */

  async function pull(opts) {
    opts = opts || {};
    if (!st.enabled || !st.server) return { changed: 0, skipped: true };

    var since = opts.full ? 0 : st.since;
    var resp = await api('/api/sync?since=' + since, {
      timeout: opts.timeout || TIMEOUT_MS
    });

    var list = (resp && Array.isArray(resp.records)) ? resp.records : [];
    var changed = await applyRemote(list);

    // 水位线：以服务器时间为准，回退一点防漏（重复拉取是幂等的）
    var serverTime = (resp && resp.serverTime) || Date.now();
    st.since = Math.max(0, serverTime - SAFETY_GAP);
    lsSet(K.since, String(st.since));

    st.lastPullAt = Date.now();
    return { changed: changed, total: (resp && resp.total) || 0 };
  }

  /* ---------------------------------------------------------- 推送 */

  /** 二进制直传一张图，比 base64 省 1/3 流量，也不吃 CPU */
  function uploadBlob(iid, blob, mime) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 60000);
    var init = {
      method: 'POST',
      headers: { 'Content-Type': mime || 'image/jpeg' },
      body: blob
    };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(st.server + '/api/images/' + encodeURIComponent(iid), init).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  /**
   * 把一条记录引用的图片传到服务端。
   * 关键：先问服务端 /api/images/check 哪些已经有了，只传缺的。
   * 不能只靠本地集合——多标签页、换浏览器、清缓存都会让它失真。
   */
  async function uploadImagesOf(rec) {
    if (!st.enabled || !st.server) return true;
    var ids = []
      .concat(rec.problemImages || [], rec.solutionImages || [])
      .filter(Boolean);
    if (!ids.length) return true;

    // 本地已知传过的先剔掉
    var todo = ids.filter(function (i) { return !st.imgs.has(i); });
    if (!todo.length) return true;

    // 问服务端：这些里面哪些已经有了
    try {
      var resp = await api('/api/images/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: todo })
      });
      var have = (resp && resp.have) || [];
      have.forEach(function (i) { st.imgs.add(i); });
      if (have.length) persistImgs();
      todo = todo.filter(function (i) { return have.indexOf(i) < 0; });
    } catch (e) {
      console.warn('[sync] 查询已有图片失败，按本地判断继续', e.message);
    }

    if (!todo.length) return true;

    // 剩下的并发上传，一次 4 张
    var CONC = 4;
    var cursor = 0;
    var failed = false;
    st.imgTotal = (st.imgTotal || 0) + todo.length;

    // 进入上传阶段，进度浮层亮起来
    st.upload.phase = 'uploading';
    st.upload.total += todo.length;
    renderUpload();

    async function worker() {
      while (cursor < todo.length) {
        if (!st.enabled || !st.server || failed) return;
        var iid = todo[cursor++];
        try {
          var im = await DB.getImage(iid);
          if (!im || !im.full) {
            // 本地没这张图，标记一下别再反复查
            st.imgs.add(iid);
            st.upload.done++;
            st.upload.total--;
            renderUpload();
            continue;
          }
          await uploadBlob(iid, im.full, im.type);
          st.imgs.add(iid);
          st.imgDone = (st.imgDone || 0) + 1;
          st.upload.done++;
          renderUpload();
        } catch (e) {
          console.warn('[sync] 图片上传失败', iid, e.message);
          st.upload.message = e.message;
          failed = true;
          return;
        }
      }
    }

    var workers = [];
    var n = Math.min(CONC, todo.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);

    persistImgs();
    return !failed;
  }

  async function pushRecord(id) {
    var rec = await DB.getRecord(id);
    if (!rec) {
      await pushDelete(id);
      return;
    }
    await uploadImagesOf(rec);
    await api('/api/records/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec)
    });
  }

  async function pushDelete(id) {
    await api('/api/records/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  /** 把待推送队列清空。失败即停，保留队列等下次重试。 */
  async function flush() {
    if (!st.enabled || !st.server) return { ok: false, skipped: true };
    if (!st.pending.size && !st.pendingDel.size) return { ok: true, pushed: 0 };

    var pushed = 0;
    var pushedIds = [];
    var puts = Array.from(st.pending);
    var dels = Array.from(st.pendingDel);
    if (!puts.length && !dels.length) return { ok: true, pushed: 0 };

    // ---- 1. 记录走批量接口：一次 50 条，比逐条 PUT 快几十倍 ----
    if (puts.length) {
      var recs = [];
      for (var i = 0; i < puts.length; i++) {
        var id = puts[i];
        try {
          var r = await DB.getRecord(id);
          if (r) recs.push(r);
          else {
            // 本地已经删了，转成删除任务
            st.pending.delete(id);
            st.pendingDel.add(id);
          }
        } catch (e) {
          // 单条读失败就跳过，留在队列里下次再试
        }
      }

      var BATCH = 50;
      for (var j = 0; j < recs.length; j += BATCH) {
        var chunk = recs.slice(j, j + BATCH);
        try {
          await api('/api/records/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: chunk }),
            timeout: 60000
          });
          chunk.forEach(function (x) {
            st.pending.delete(x.id);
            pushedIds.push(x.id);
          });
          persistPending();
          pushed += chunk.length;
        } catch (e) {
          persistPending();
          throw e;
        }
      }
    }

    // ---- 2. 删除（服务端软删，逐条即可）----
    var dels2 = Array.from(st.pendingDel);
    for (var k = 0; k < dels2.length; k++) {
      var did = dels2[k];
      st.pendingDel.delete(did);
      try {
        await pushDelete(did);
        pushed++;
      } catch (e) {
        st.pendingDel.add(did);
        persistPending();
        throw e;
      }
    }

    persistPending();

    // ---- 3. 只给刚推上去的这些记录补图片，不再遍历全库 ----
    if (pushedIds.length) queueImageUpload(pushedIds);

    return { ok: true, pushed: pushed };
  }

  function enqueuePut(id) {
    if (!id) return;
    st.pending.add(String(id));
    st.pendingDel.delete(String(id));
    persistPending();
    scheduleFlush();
  }

  function enqueueDel(id) {
    if (!id) return;
    st.pending.delete(String(id));
    st.pendingDel.add(String(id));
    persistPending();
    scheduleFlush();
  }

  function enqueueAll() {
    DB.allRecords().then(function (list) {
      (list || []).forEach(function (r) { if (r && r.id) st.pending.add(r.id); });
      persistPending();
      scheduleFlush(1500);
    }).catch(function () { /* ignore */ });
  }

  function scheduleFlush(delay) {
    if (!st.enabled || !st.server) return;
    if (st.pushTimer) clearTimeout(st.pushTimer);
    st.pushTimer = setTimeout(function () {
      st.pushTimer = null;
      syncNow({ quiet: true }).catch(function () { /* 已记在状态里 */ });
    }, typeof delay === 'number' ? delay : DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------- 图片补齐 */
  // 记录同步只带图片 id，图片本体在服务端 /api/images/:id。
  // 换一台电脑首次打开时本地没有图，这里后台悄悄补下来，不挡首屏。

  var imgFillTimer = null;
  var imgFilling = false;

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function makeThumb(blob, maxDim) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          var c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          c.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.74);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  async function fillImages(records) {
    var ids = [];
    (records || []).forEach(function (r) {
      (r.problemImages || []).forEach(function (i) { if (i) ids.push(i); });
      (r.solutionImages || []).forEach(function (i) { if (i) ids.push(i); });
    });
    if (!ids.length) return 0;
    ids = Array.from(new Set(ids));

    var db = await DB.open();
    var tx = db.transaction('images', 'readonly');
    var have = new Set((await req(tx.objectStore('images').getAllKeys())) || []);

    var todo = ids.filter(function (i) { return !have.has(i); });
    if (!todo.length) return 0;

    var done = 0;
    for (var i = 0; i < todo.length; i++) {
      if (!st.enabled || !st.server) break;
      try {
        var res = await fetch(st.server + '/api/images/' + encodeURIComponent(todo[i]));
        if (!res.ok) continue;
        var blob = await res.blob();
        if (!blob.size) continue;

        var thumb = await makeThumb(blob, 360);
        var w = 0;
        var h = 0;
        try {
          var bmp = await createImageBitmap(blob);
          w = bmp.width;
          h = bmp.height;
          if (bmp.close) bmp.close();
        } catch (e) { /* 拿不到尺寸不影响使用 */ }

        var tx2 = db.transaction('images', 'readwrite');
        tx2.objectStore('images').put({
          id: todo[i],
          full: blob,
          thumb: thumb || blob,
          w: w,
          h: h,
          size: blob.size,
          thumbSize: (thumb || blob).size,
          type: blob.type || 'image/jpeg',
          name: '',
          createdAt: Date.now()
        });
        await txDone(tx2);
        done++;
      } catch (e) {
        console.warn('[sync] 补图失败', todo[i], e.message);
        break;
      }
    }
    return done;
  }

  function queueImageFill() {
    if (!st.enabled || !st.server) return;
    if (imgFilling || imgFillTimer) return;
    imgFillTimer = setTimeout(async function () {
      imgFillTimer = null;
      if (imgFilling) return;
      imgFilling = true;
      try {
        var recs = await DB.allRecords();
        var n = await fillImages(recs);
        if (n && !st.silent && typeof st.onRemoteChange === 'function') {
          try { await st.onRemoteChange(n); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        console.warn('[sync] 图片补齐失败', e.message);
      } finally {
        imgFilling = false;
      }
    }, 2500);
  }

  /* ---------------------------------------------------------- 图片上传队列 */
  // 记录批量推完后，图片在后台慢慢传，避免一次性几百张把同步卡死。

  var imgUpTimer = null;
  var imgUping = false;

  /**
   * 只上传「刚推送过的那些记录」的图片，不再每次遍历全库。
   * 记录 id 进队列后合并处理，2 秒防抖。
   */
  function queueImageUpload(recordIds) {
    if (!st.enabled || !st.server) return;
    if (!st.imgQueue) st.imgQueue = new Set();
    if (recordIds && recordIds.length) {
      recordIds.forEach(function (i) { st.imgQueue.add(String(i)); });
    }
    if (st.imgQueue.size === 0) return;

    // 有新任务进来先给个反馈，别让人等那 2 秒防抖以为没反应
    if (!imgUping && !imgUpTimer) {
      st.upload = { phase: 'checking', total: 0, done: 0, message: '' };
      renderUpload();
    }

    if (imgUping || imgUpTimer) return;

    imgUpTimer = setTimeout(async function () {
      imgUpTimer = null;
      if (imgUping) return;
      imgUping = true;
      var fails = 0;
      try {
        while (st.imgQueue.size) {
          var batch = Array.from(st.imgQueue);
          st.imgQueue.clear();
          for (var i = 0; i < batch.length; i++) {
            if (!st.enabled || !st.server) return;
            var rec = await DB.getRecord(batch[i]);
            if (!rec) continue;
            var ok = await uploadImagesOf(rec);
            if (!ok) {
              fails++;
              st.imgQueue.add(batch[i]);
              if (fails >= 3) {
                console.warn('[sync] 图片上传连续失败，暂停本轮');
                return;
              }
            }
          }
        }
      } catch (e) {
        console.warn('[sync] 图片上传中断', e.message);
      } finally {
        imgUping = false;
        st.imgTotal = 0;

        if (st.upload.phase === 'checking' || st.upload.phase === 'uploading') {
          if (st.upload.total === 0) {
            st.upload.phase = 'idle';                 // 没有缺图，直接收起
          } else if (st.upload.done >= st.upload.total) {
            st.upload.phase = 'done';                 // 全部传完
          } else {
            st.upload.phase = 'error';                // 中断，保住已传的
            st.upload.message = st.upload.message ||
              ('还有 ' + (st.upload.total - st.upload.done) + ' 张没传完，下次同步接着补');
          }
        }

        renderUpload();
        render();
      }
    }, 2000);
  }

  /* ---------------------------------------------------------- 主流程 */

  function setStatus(status, message) {
    st.status = status;
    st.message = message || '';
    if (status === 'error') st.lastErrorAt = Date.now();
    render();
  }

  async function syncNow(opts) {
    opts = opts || {};
    if (!st.enabled || !st.server) {
      setStatus(st.enabled ? 'error' : 'off', '未配置');
      return { changed: 0, pushed: 0 };
    }
    if (st.busy) return { changed: 0, pushed: 0, skipped: true };

    st.busy = true;
    if (!opts.quiet) setStatus('syncing', '同步中…');

    try {
      var pushed = 0;
      try {
        var f = await flush();
        pushed = f.pushed || 0;
      } catch (e) {
        // 推送失败仍要继续拉，免得连对方的新数据也看不到
        console.warn('[sync] 推送失败', e.message);
      }

      var p = await pull({ timeout: opts.timeout || TIMEOUT_MS });
      setStatus('ok', '');

      // 本地缺的图片后台慢慢补，不挡这次同步的返回
      queueImageFill();

      if (p.changed && !st.silent && typeof st.onRemoteChange === 'function') {
        try { await st.onRemoteChange(p.changed); } catch (e) { /* ignore */ }
      }
      st.silent = false;
      return { changed: p.changed || 0, pushed: pushed };
    } catch (e) {
      setStatus('error', e.message || '同步失败');
      throw e;
    } finally {
      st.busy = false;
      render();
    }
  }

  function startPoll() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = setInterval(function () {
      if (document.hidden) return;
      syncNow({ quiet: true }).catch(function () { /* ignore */ });
    }, POLL_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        syncNow({ quiet: true }).catch(function () { /* ignore */ });
      }
    });

    // 网络恢复时立刻补一次
    window.addEventListener('online', function () {
      syncNow({ quiet: true }).catch(function () { /* ignore */ });
    });
  }

  /* ---------------------------------------------------------- 全量推送（迁移用） */

  async function pushAll(onProgress) {
    if (!st.server) throw new Error('请先填写服务器地址');
    var all = await DB.allRecords();
    var recs = (all || []).filter(function (r) { return r && r.id && !r.deleted; });
    if (!recs.length) throw new Error('本地没有数据可推送');

    var BATCH = 40;
    var done = 0;

    // 点下去立刻有反馈，别让人以为没反应
    st.upload = { phase: 'checking', total: 0, done: 0, message: '正在推送记录（共 ' + recs.length + ' 条）…' };
    renderUpload();

    for (var i = 0; i < recs.length; i += BATCH) {
      var chunk = recs.slice(i, i + BATCH);
      await api('/api/records/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: chunk }),
        timeout: 60000
      });
      done += chunk.length;
      st.upload.message = '正在推送记录 ' + done + ' / ' + recs.length + '…';
      renderUpload();
      if (typeof onProgress === 'function') onProgress(done, recs.length);
    }
    st.since = 0;
    lsSet(K.since, '0');

    // 记录推完，把缺失的图片也补上去（check 会挡掉服务端已有的，不会重复传）
    st.silent = false;
    queueImageUpload(recs.map(function (r) { return r.id; }));

    return { total: done };
  }

  /* ---------------------------------------------------------- 拦截 DB 写操作 */

  var hooked = false;
  function hookDB() {
    if (hooked) return;
    hooked = true;

    var origSave = DB.saveRecord;
    DB.saveRecord = async function () {
      var rec = await origSave.apply(this, arguments);
      if (rec && rec.id) enqueuePut(rec.id);
      return rec;
    };

    var origDel = DB.deleteRecord;
    DB.deleteRecord = async function (id) {
      var r = await origDel.apply(this, arguments);
      enqueueDel(id);
      return r;
    };

    ['toggleStar', 'bumpUseCount'].forEach(function (fn) {
      var orig = DB[fn];
      if (typeof orig !== 'function') return;
      DB[fn] = async function (id) {
        var v = await orig.apply(this, arguments);
        enqueuePut(id);
        return v;
      };
    });

    ['importBackup', 'mergeFromBackup'].forEach(function (fn) {
      var orig = DB[fn];
      if (typeof orig !== 'function') return;
      DB[fn] = async function () {
        var v = await orig.apply(this, arguments);
        enqueueAll();
        return v;
      };
    });
  }

  /* ---------------------------------------------------------- 界面 */

  var el = {};

  function injectStyle() {
    if (document.getElementById('vsync-style')) return;
    var css = ''
      + '.vsync{margin-bottom:10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface-2);overflow:hidden}'
      + '.vsync-head{display:flex;align-items:center;gap:7px;width:100%;padding:9px 10px;border:0;background:transparent;cursor:pointer;font:inherit;font-size:11.5px;color:var(--text-3);text-align:left}'
      + '.vsync-head:hover{background:var(--surface-3)}'
      + '.vsync-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--text-3);box-shadow:0 0 0 3px transparent;transition:background .2s}'
      + '.vsync[data-s="ok"] .vsync-dot{background:var(--success);box-shadow:0 0 0 3px var(--success-soft)}'
      + '.vsync[data-s="syncing"] .vsync-dot{background:var(--primary);animation:vsyncPulse 1s infinite}'
      + '.vsync[data-s="error"] .vsync-dot{background:var(--danger);box-shadow:0 0 0 3px var(--danger-soft)}'
      + '@keyframes vsyncPulse{0%,100%{opacity:1}50%{opacity:.25}}'
      + '.vsync-label{font-weight:600;color:var(--text-2)}'
      + '.vsync-time{margin-left:auto;font-size:11px;color:var(--text-3)}'
      + '.vsync-body{padding:0 10px 10px;display:none}'
      + '.vsync.open .vsync-body{display:block}'
      + '.vsync-row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}'
      + '.vsync-input{flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font:inherit;font-size:11.5px}'
      + '.vsync-btn{padding:6px 9px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text-2);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}'
      + '.vsync-btn:hover{background:var(--surface-3)}'
      + '.vsync-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}'
      + '.vsync-btn.primary:hover{background:var(--primary-hover)}'
      + '.vsync-btn:disabled{opacity:.5;cursor:not-allowed}'
      + '.vsync-msg{margin-top:8px;font-size:11px;line-height:1.5;color:var(--text-3);word-break:break-all}'
      + '.vsync-msg.err{color:var(--danger)}'
      + '.vsync-msg.ok{color:var(--success)}'
      // ---- 上传进度浮层 ----
      + '.vup{position:fixed;right:22px;bottom:86px;z-index:210;width:296px;'
      + 'background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);'
      + 'box-shadow:var(--shadow-lg);padding:12px 14px;font-family:var(--font);'
      + 'transition:opacity .28s ease,transform .28s ease}'
      + '.vup.hide{opacity:0;transform:translateY(10px);pointer-events:none}'
      + '.vup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}'
      + '.vup-title{font-size:12.5px;font-weight:600;color:var(--text)}'
      + '.vup-count{font-size:12px;color:var(--text-3);font-variant-numeric:tabular-nums;flex:none}'
      + '.vup-bar{height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden}'
      + '.vup-bar i{display:block;height:100%;width:0;background:var(--primary);border-radius:3px;transition:width .18s linear}'
      + '.vup-sub{margin-top:8px;font-size:11.5px;line-height:1.5;color:var(--text-3)}'
      + '.vup.done .vup-bar i{background:var(--success)}'
      + '.vup.done .vup-title{color:var(--success)}'
      + '.vup.err .vup-bar i{background:var(--danger)}'
      + '.vup.err .vup-title{color:var(--danger)}'
      // ---- 服务器模式：不显示客户端那套同步按钮 ----
      + '.vsync-server .vsync-input,.vsync-server .vsync-row{display:none}'
      + '.vsync-srv{display:none;margin-top:8px}'
      + '.vsync-server .vsync-srv{display:block}'
      + '.vsync-srv-tip{font-size:11.5px;line-height:1.65;color:var(--text-3)}'
      + '.vsync-srv-stat{margin-top:8px;padding:7px 9px;border-radius:var(--r-sm);'
      + 'background:var(--surface-3);font-size:11.5px;line-height:1.7;color:var(--text-2)}'
      + '.vsync-srv .vsync-btn{width:100%;margin-top:8px}'
      + '@media (max-width:640px){.vup{left:14px;right:14px;width:auto;bottom:74px}}';
    var s = document.createElement('style');
    s.id = 'vsync-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function mountUI() {
    if (st.mounted) return;
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    injectStyle();

    var box = document.createElement('div');
    box.className = 'vsync';
    box.id = 'vsync';
    box.dataset.s = 'off';
    box.innerHTML = ''
      + '<button class="vsync-head" id="vsyncHead" type="button">'
      + '  <i class="vsync-dot"></i>'
      + '  <span class="vsync-label" id="vsyncLabel">局域网同步</span>'
      + '  <span class="vsync-time" id="vsyncTime">—</span>'
      + '</button>'
      + '<div class="vsync-body">'
      + '  <div class="vsync-row">'
      + '    <input class="vsync-input" id="vsyncServer" placeholder="192.168.31.174:8765" spellcheck="false">'
      + '  </div>'
      + '  <div class="vsync-row">'
      + '    <button class="vsync-btn primary" id="vsyncNow" type="button">立即同步</button>'
      + '    <button class="vsync-btn" id="vsyncAll" type="button">推送全部本地数据</button>'
      + '  </div>'
      + '  <div class="vsync-row">'
      + '    <button class="vsync-btn" id="vsyncToggle" type="button">关闭同步</button>'
      + '    <button class="vsync-btn" id="vsyncReset" type="button">重新全量同步</button>'
      + '  </div>'
      + '  <div class="vsync-row">'
      + '    <button class="vsync-btn" id="vsyncGc" type="button">清理本地冗余图片</button>'
      + '  </div>'
      + '  <div class="vsync-srv">'
      + '    <div class="vsync-srv-tip">这台就是服务器，记录和图片都存在它硬盘上的 data 文件夹里。</div>'
      + '    <div class="vsync-srv-stat" id="vsyncStat">正在统计…</div>'
      + '    <button class="vsync-btn" id="vsyncGc2" type="button">清理本地缓存</button>'
      + '  </div>'
      + '  <div class="vsync-msg" id="vsyncMsg"></div>'
      + '</div>';

    var foot = sidebar.querySelector('.sidebar-foot');
    if (foot) sidebar.insertBefore(box, foot);
    else sidebar.appendChild(box);

    // 跑在服务器本机上就切成"数据源"形态
    if (isLocalServer()) box.classList.add('vsync-server');

    el.box = box;
    el.head = document.getElementById('vsyncHead');
    el.label = document.getElementById('vsyncLabel');
    el.time = document.getElementById('vsyncTime');
    el.server = document.getElementById('vsyncServer');
    el.now = document.getElementById('vsyncNow');
    el.all = document.getElementById('vsyncAll');
    el.toggle = document.getElementById('vsyncToggle');
    el.reset = document.getElementById('vsyncReset');
    el.gc = document.getElementById('vsyncGc');
    el.gc2 = document.getElementById('vsyncGc2');
    el.stat = document.getElementById('vsyncStat');
    el.msg = document.getElementById('vsyncMsg');

    el.head.addEventListener('click', function () {
      box.classList.toggle('open');
      if (box.classList.contains('open') && isLocalServer()) updateServerStat();
    });

    el.server.addEventListener('change', function () {
      var v = trimSlash(el.server.value);
      if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
      st.server = v;
      lsSet(K.server, v);
      if (v) {
        st.enabled = true;
        lsSet(K.enabled, '1');
        st.since = 0;
        lsSet(K.since, '0');
        setStatus('idle', '');
        syncNow({}).then(function (r) {
          setMsg('已连接，拉取 ' + (r.changed || 0) + ' 条', 'ok');
        }).catch(function (e) {
          setMsg(e.message, 'err');
        });
      } else {
        st.enabled = false;
        lsSet(K.enabled, '0');
        setStatus('off', '未配置');
      }
      render();
    });

    el.now.addEventListener('click', function () {
      setMsg('正在同步…', '');
      syncNow({}).then(function (r) {
        setMsg('完成：上行 ' + (r.pushed || 0) + ' 条，下行 ' + (r.changed || 0) + ' 条', 'ok');
      }).catch(function (e) {
        setMsg(e.message, 'err');
      });
    });

    el.all.addEventListener('click', async function () {
      el.all.disabled = true;
      try {
        setMsg('正在上传本地数据…', '');
        var r = await pushAll(function (done, total) {
          setMsg('已上传 ' + done + ' / ' + total + ' 条…', '');
        });
        setMsg('已把 ' + r.total + ' 条推送到服务器，缺失的图片在后台继续传（看状态栏进度）', 'ok');
        // 推完再拉一次，把服务器上别处的更新带回来
        await syncNow({});
      } catch (e) {
        setMsg(e.message, 'err');
      } finally {
        el.all.disabled = false;
      }
    });

    el.toggle.addEventListener('click', function () {
      st.enabled = !st.enabled;
      lsSet(K.enabled, st.enabled ? '1' : '0');
      if (st.enabled) {
        setStatus('idle', '');
        syncNow({}).catch(function (e) { setMsg(e.message, 'err'); });
      } else {
        setStatus('off', '已关闭');
        setMsg('已关闭同步，数据只存在本浏览器', '');
      }
      render();
    });

    el.reset.addEventListener('click', function () {
      var ok = window.confirm(
        '把服务器上的数据从头重新拉一遍（排查数据不齐时用）。\n\n' +
        '· 不会删除本机任何记录\n' +
        '· 记录多的话这次同步会慢一点\n\n' +
        '确定要重新全量同步吗？'
      );
      if (!ok) return;
      st.since = 0;
      lsSet(K.since, '0');
      st.silent = false;
      setMsg('已重置。下次同步会把服务器数据重新拉一遍，本机记录不受影响。', 'ok');
      syncNow({}).then(function (r) {
        setMsg('全量同步完成：上行 ' + (r.pushed || 0) + ' 条，下行 ' + (r.changed || 0) + ' 条', 'ok');
      }).catch(function (e) {
        setMsg(e.message, 'err');
      });
    });

    async function doGc(btn) {
      var ok = window.confirm(
        '清理本机浏览器里「没有任何记录引用」的图片缓存。\n\n' +
        '· 记录本身和服务器上的数据都不受影响\n' +
        '· 如果你在别的标签页正编辑一条还没保存的记录，那张图可能被清掉\n\n' +
        '继续吗？'
      );
      if (!ok) return;
      if (btn) btn.disabled = true;
      setMsg('正在清理…', '');
      try {
        var n = await DB.gcImages();
        setMsg(n ? '已清理 ' + n + ' 张未被引用的图片' : '没有需要清理的图片', 'ok');
        if (isLocalServer()) updateServerStat();
        if (typeof st.onRemoteChange === 'function') {
          try { await st.onRemoteChange(0); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        setMsg('清理失败：' + e.message, 'err');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    el.gc.addEventListener('click', function () { doGc(el.gc); });
    if (el.gc2) el.gc2.addEventListener('click', function () { doGc(el.gc2); });

    st.mounted = true;
    render();
  }

  function setMsg(text, kind) {
    if (!el.msg) return;
    el.msg.className = 'vsync-msg' + (kind ? ' ' + kind : '');
    el.msg.textContent = text || '';
  }

  function render() {
    if (!st.mounted || !el.box) return;
    el.box.dataset.s = st.status;

    var label = '局域网同步';
    var timeText = '';

    if (isLocalServer()) {
      // 服务器本机：这里就是数据源头，不叫"同步"
      label = st.status === 'error' ? '数据源 · 读取异常' : '数据源 · 本机';
      timeText = st.status === 'error' ? '重试中' : relTime(st.lastPullAt);
    } else if (st.status === 'off') {
      label = st.server ? '同步已关闭' : '同步未配置';
      timeText = st.server ? '' : '点此设置';
    } else if (st.status === 'syncing') {
      label = '同步中…';
      timeText = '';
    } else if (st.status === 'error') {
      label = '同步故障';
      timeText = '重试中';
    } else if (st.status === 'ok') {
      label = '已同步';
      timeText = relTime(st.lastPullAt);
    } else {
      label = '待同步';
      timeText = st.lastPullAt ? relTime(st.lastPullAt) : '—';
    }

    el.label.textContent = label;
    el.time.textContent = timeText;

    // 图片批量上传时把进度显示出来，别让人以为卡住了
    if (st.imgTotal > 0) {
      el.label.textContent = '正在传图片';
      el.time.textContent = st.imgDone + '/' + st.imgTotal;
    }
    if (document.activeElement !== el.server) {
      el.server.value = st.server;
      // 长地址默认滚到末尾会看不到 http:// ，强行回左
      el.server.scrollLeft = 0;
    }
    el.toggle.textContent = st.enabled ? '关闭同步' : '开启同步';
    el.now.disabled = !st.enabled || !st.server;

    if (st.status === 'error' && st.message) {
      setMsg(st.message, 'err');
    }
  }

  /* ---------------------------------------------------------- 上传进度浮层 */

  var upEl = null;
  var upHideTimer = null;

  function ensureUploadUI() {
    if (upEl && document.body.contains(upEl)) return upEl;
    if (!document.getElementById('vsync-style')) injectStyle();

    var box = document.createElement('div');
    box.className = 'vup hide';
    box.id = 'vaultUpload';
    box.innerHTML = ''
      + '<div class="vup-head">'
      + '  <span class="vup-title" id="vupTitle">正在上传照片</span>'
      + '  <span class="vup-count" id="vupCount"></span>'
      + '</div>'
      + '<div class="vup-bar"><i id="vupBar"></i></div>'
      + '<div class="vup-sub" id="vupSub"></div>';
    document.body.appendChild(box);

    box._title = box.querySelector('#vupTitle');
    box._count = box.querySelector('#vupCount');
    box._bar = box.querySelector('#vupBar');
    box._sub = box.querySelector('#vupSub');

    upEl = box;
    return box;
  }

  function renderUpload() {
    var u = st.upload;
    if (!u || u.phase === 'idle') {
      if (upEl) upEl.classList.add('hide');
      return;
    }

    var box = ensureUploadUI();
    if (upHideTimer) {
      clearTimeout(upHideTimer);
      upHideTimer = null;
    }
    box.classList.remove('hide', 'done', 'err');

    if (u.phase === 'checking') {
      box._title.textContent = '正在准备…';
      box._count.textContent = '';
      box._bar.style.width = '0%';
      box._sub.textContent = u.message || '对比服务器上已有的照片';
      return;
    }

    if (u.phase === 'uploading') {
      var pct = u.total ? Math.round((u.done / u.total) * 100) : 0;
      box._title.textContent = '正在上传照片';
      box._count.textContent = u.done + ' / ' + u.total;
      box._bar.style.width = Math.max(2, pct) + '%';
      var left = u.total - u.done;
      box._sub.textContent = left > 0 ? ('还剩 ' + left + ' 张，页面别关') : '即将完成…';
      return;
    }

    if (u.phase === 'done') {
      box.classList.add('done');
      box._title.textContent = '照片已全部上传';
      box._count.textContent = u.done + ' / ' + u.total;
      box._bar.style.width = '100%';
      box._sub.textContent = '其他设备刷新就能看到';
      upHideTimer = setTimeout(function () {
        if (st.upload.phase === 'done') {
          st.upload.phase = 'idle';
          renderUpload();
        }
      }, 5000);
      return;
    }

    if (u.phase === 'error') {
      box.classList.add('err');
      box._title.textContent = '照片上传中断';
      box._count.textContent = u.done + ' / ' + u.total;
      box._sub.textContent = u.message || '已传的不会丢，下次同步接着补';
    }
  }

  function resetUpload() {
    st.upload = { phase: 'idle', total: 0, done: 0, message: '' };
    renderUpload();
  }

  /** 服务器模式下的统计（记录数/图片数/浏览器缓存占用） */
  async function updateServerStat() {
    if (!el.stat) return;
    try {
      var u = await DB.usage();
      var mb = (u.bytes / 1048576).toFixed(1);
      el.stat.innerHTML = '记录 <b>' + u.recordCount + '</b> 条 · 图片 <b>' +
        u.imageCount + '</b> 张<br>浏览器缓存 ' + mb + ' MB';
    } catch (e) {
      el.stat.textContent = '统计失败';
    }
  }

  /* ---------------------------------------------------------- 启动 */

  var booted = false;

  async function bootstrap() {
    if (booted) return { changed: 0 };
    booted = true;

    loadConfig();
    hookDB();
    mountUI();

    if (!st.enabled || !st.server) {
      render();
      return { changed: 0, skipped: true };
    }

    // 首屏已经由本地缓存渲染完了，这里允许拉到数据后直接刷新界面
    st.silent = false;
    startPoll();
    render();

    // 后台同步，绝不阻塞首屏
    syncNow({ quiet: true }).catch(function (e) {
      setStatus('error', e.message);
    });

    return { changed: 0, background: true };
  }

  return {
    bootstrap: bootstrap,
    syncNow: syncNow,
    pushAll: pushAll,
    pull: pull,
    flush: flush,
    render: render,
    getState: function () {
      return {
        enabled: st.enabled,
        server: st.server,
        since: st.since,
        status: st.status,
        message: st.message,
        lastPullAt: st.lastPullAt,
        pending: st.pending.size,
        pendingDel: st.pendingDel.size
      };
    },
    set onRemoteChange(fn) { st.onRemoteChange = fn; },
    get onRemoteChange() { return st.onRemoteChange; }
  };
})();
