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

  function defaultServer() {
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
    var n = 0;

    list.forEach(function (r) {
      if (!r || !r.id) return;
      var cur = map.get(r.id);

      if (r.deleted) {
        // 服务端墓碑：本地有就删掉，并记下不复活
        if (cur) toDel.push(r.id);
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

  async function uploadImagesOf(rec) {
    if (!st.enabled || !st.server) return;
    var ids = []
      .concat(rec.problemImages || [], rec.solutionImages || [])
      .filter(Boolean);

    for (var i = 0; i < ids.length; i++) {
      var iid = ids[i];
      if (st.imgs.has(iid)) continue;
      try {
        var im = await DB.getImage(iid);
        if (!im || !im.full) continue;
        var dataUrl = await blobToDataURL(im.full);
        await api('/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: iid,
            data: dataUrl,
            type: im.type || 'image/jpeg',
            name: im.name || ''
          }),
          timeout: 60000
        });
        st.imgs.add(iid);
        persistImgs();
      } catch (e) {
        // 图片失败不阻断记录同步，下次保存会再试
        console.warn('[sync] 图片上传失败', iid, e.message);
        break;
      }
    }
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
    var puts = Array.from(st.pending);
    for (var i = 0; i < puts.length; i++) {
      var id = puts[i];
      st.pending.delete(id);
      try {
        await pushRecord(id);
        pushed++;
      } catch (e) {
        st.pending.add(id);
        persistPending();
        throw e;
      }
    }

    var dels = Array.from(st.pendingDel);
    for (var j = 0; j < dels.length; j++) {
      var did = dels[j];
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
    var recs = await DB.allRecords();
    if (!recs.length) throw new Error('本地没有数据可推送');

    var BATCH = 40;
    var done = 0;
    for (var i = 0; i < recs.length; i += BATCH) {
      var chunk = recs.slice(i, i + BATCH);
      await api('/api/records/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: chunk }),
        timeout: 60000
      });
      done += chunk.length;
      if (typeof onProgress === 'function') onProgress(done, recs.length);
    }
    st.since = 0;
    lsSet(K.since, '0');
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
      + '.vsync-row{display:flex;gap:6px;margin-top:8px}'
      + '.vsync-input{flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font:inherit;font-size:11.5px}'
      + '.vsync-btn{padding:6px 9px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text-2);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}'
      + '.vsync-btn:hover{background:var(--surface-3)}'
      + '.vsync-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}'
      + '.vsync-btn.primary:hover{background:var(--primary-hover)}'
      + '.vsync-btn:disabled{opacity:.5;cursor:not-allowed}'
      + '.vsync-msg{margin-top:8px;font-size:11px;line-height:1.5;color:var(--text-3);word-break:break-all}'
      + '.vsync-msg.err{color:var(--danger)}'
      + '.vsync-msg.ok{color:var(--success)}';
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
      + '    <button class="vsync-btn" id="vsyncReset" type="button">重置进度</button>'
      + '  </div>'
      + '  <div class="vsync-msg" id="vsyncMsg"></div>'
      + '</div>';

    var foot = sidebar.querySelector('.sidebar-foot');
    if (foot) sidebar.insertBefore(box, foot);
    else sidebar.appendChild(box);

    el.box = box;
    el.head = document.getElementById('vsyncHead');
    el.label = document.getElementById('vsyncLabel');
    el.time = document.getElementById('vsyncTime');
    el.server = document.getElementById('vsyncServer');
    el.now = document.getElementById('vsyncNow');
    el.all = document.getElementById('vsyncAll');
    el.toggle = document.getElementById('vsyncToggle');
    el.reset = document.getElementById('vsyncReset');
    el.msg = document.getElementById('vsyncMsg');

    el.head.addEventListener('click', function () {
      box.classList.toggle('open');
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
        setMsg('已把 ' + r.total + ' 条推送到服务器', 'ok');
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
      st.since = 0;
      lsSet(K.since, '0');
      st.silent = false;
      setMsg('已重置同步进度，下次同步会全量拉取', 'ok');
    });

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

    if (st.status === 'off') {
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
    if (document.activeElement !== el.server) {
      el.server.value = st.server;
    }
    el.toggle.textContent = st.enabled ? '关闭同步' : '开启同步';
    el.now.disabled = !st.enabled || !st.server;

    if (st.status === 'error' && st.message) {
      setMsg(st.message, 'err');
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

    try {
      // 首屏只等 2.5 秒：服务器没开时不能把页面卡住
      var p = await pull({ timeout: FIRST_MS });
      setStatus('ok', '');
      st.silent = false;
      return p;
    } catch (e) {
      st.silent = false;
      setStatus('error', e.message);
      return { changed: 0, error: e.message };
    } finally {
      startPoll();
      render();
    }
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
