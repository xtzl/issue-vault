/* ===========================================================
   问题手册 · 数据层
   IndexedDB：records（记录）/ images（图片二进制）/ meta（配置）
   =========================================================== */
window.VaultDB = (function () {
  'use strict';

  const DB_NAME = 'issue-vault';
  const DB_VER = 1;
  const STORE_REC = 'records';
  const STORE_IMG = 'images';
  const STORE_META = 'meta';

  const DEFAULT_CATEGORIES = [
    '充值退款', '会员卡券', '设备故障', '系统操作',
    '客户投诉', '供应商', 'KA客户', '其他'
  ];

  let _db = null;

  /* ---------- 工具 ---------- */
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('事务被中止'));
    });
  }

  /* ---------- 打开 ---------- */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB，请换用 Chrome / Edge'));
        return;
      }
      const r = indexedDB.open(DB_NAME, DB_VER);

      r.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_REC)) {
          const s = db.createObjectStore(STORE_REC, { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
          s.createIndex('occurredAt', 'occurredAt');
          s.createIndex('category', 'category');
          s.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains(STORE_IMG)) {
          db.createObjectStore(STORE_IMG, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      r.onsuccess = () => {
        _db = r.result;
        _db.onversionchange = () => { _db.close(); _db = null; };
        resolve(_db);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭其他页面后重试'));
    });
  }

  /* ---------- 图片处理 ---------- */
  function loadBitmap(blobOrFile) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blobOrFile);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片读取失败，可能是格式不支持'));
      };
      img.src = url;
    });
  }

  function drawToBlob(img, maxDim, quality) {
    return new Promise((resolve) => {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      // 截图常带透明通道，转 JPEG 前铺白底，避免变黑
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob((blob) => {
        if (blob) resolve({ blob, w, h });
        else {
          // 极端情况降级：直接用原图
          resolve(null);
        }
      }, 'image/jpeg', quality);
    });
  }

  const MAX_DIM = 1680;   // 主图长边
  const THUMB_DIM = 360;  // 缩略图长边

  /**
   * 把用户选的图片压缩后存库，返回图片 id
   * @returns {Promise<string>} imageId
   */
  async function addImage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      throw new Error('不是有效的图片文件');
    }
    const img = await loadBitmap(file);
    const full = await drawToBlob(img, MAX_DIM, 0.84);
    const thumb = await drawToBlob(img, THUMB_DIM, 0.74);

    const fullBlob = full ? full.blob : file;
    const thumbBlob = thumb ? thumb.blob : file;
    const id = uid();

    const rec = {
      id,
      full: fullBlob,
      thumb: thumbBlob,
      w: full ? full.w : img.naturalWidth,
      h: full ? full.h : img.naturalHeight,
      size: fullBlob.size,
      thumbSize: thumbBlob.size,
      type: 'image/jpeg',
      name: file.name || '',
      createdAt: Date.now()
    };
    const db = await open();
    const tx = db.transaction(STORE_IMG, 'readwrite');
    tx.objectStore(STORE_IMG).put(rec);
    await txDone(tx);
    return id;
  }

  async function getImage(id) {
    if (!id) return null;
    const db = await open();
    const tx = db.transaction(STORE_IMG, 'readonly');
    return req(tx.objectStore(STORE_IMG).get(id));
  }

  async function deleteImage(id) {
    if (!id) return;
    const db = await open();
    const tx = db.transaction(STORE_IMG, 'readwrite');
    tx.objectStore(STORE_IMG).delete(id);
    await txDone(tx);
  }

  /** 批量取缩略图 */
  async function getThumbs(ids) {
    const out = {};
    if (!ids || !ids.length) return out;
    const db = await open();
    const tx = db.transaction(STORE_IMG, 'readonly');
    const store = tx.objectStore(STORE_IMG);
    await Promise.all(ids.map(async (id) => {
      const r = await req(store.get(id));
      if (r) out[id] = r.thumb;
    }));
    return out;
  }

  /* ---------- 记录 ---------- */
  async function allRecords() {
    const db = await open();
    const tx = db.transaction(STORE_REC, 'readonly');
    const list = await req(tx.objectStore(STORE_REC).getAll());
    return list || [];
  }

  async function getRecord(id) {
    const db = await open();
    const tx = db.transaction(STORE_REC, 'readonly');
    return req(tx.objectStore(STORE_REC).get(id));
  }

  async function saveRecord(data) {
    const now = Date.now();
    const rec = Object.assign({}, data);
    if (!rec.id) {
      rec.id = uid();
      rec.createdAt = now;
    }
    rec.updatedAt = now;
    if (!rec.createdAt) rec.createdAt = now;

    // 归一化
    rec.title = (rec.title || '').trim();
    rec.problem = rec.problem || '';
    rec.solution = rec.solution || '';
    rec.note = rec.note || '';
    rec.customer = (rec.customer || '').trim();
    rec.category = rec.category || '其他';
    rec.channel = rec.channel || '';
    rec.sessionId = (rec.sessionId || '').trim();
    rec.phone = (rec.phone || '').trim();
    rec.remindAt = rec.remindAt || '';
    rec.remindDone = !!rec.remindDone;
    rec.status = rec.status || '已解决';
    rec.tags = Array.isArray(rec.tags) ? rec.tags.filter(Boolean) : [];
    rec.problemImages = Array.isArray(rec.problemImages) ? rec.problemImages : [];
    rec.solutionImages = Array.isArray(rec.solutionImages) ? rec.solutionImages : [];
    rec.star = !!rec.star;
    rec.useCount = Number(rec.useCount) || 0;
    rec.occurredAt = rec.occurredAt || new Date().toISOString().slice(0, 10);
    rec.source = rec.source || 'manual';

    const db = await open();
    const tx = db.transaction(STORE_REC, 'readwrite');
    tx.objectStore(STORE_REC).put(rec);
    await txDone(tx);
    return rec;
  }

  async function deleteRecord(id) {
    const rec = await getRecord(id);
    if (!rec) return;
    const db = await open();
    const tx = db.transaction([STORE_REC, STORE_IMG], 'readwrite');
    tx.objectStore(STORE_REC).delete(id);
    const imgStore = tx.objectStore(STORE_IMG);
    (rec.problemImages || []).concat(rec.solutionImages || []).forEach((iid) => imgStore.delete(iid));
    await txDone(tx);
  }

  /** 编辑保存后清理不再被引用的图片 */
  async function pruneImages(oldRec, newRec) {
    const before = ((oldRec.problemImages || []).concat(oldRec.solutionImages || []));
    const after = ((newRec.problemImages || []).concat(newRec.solutionImages || []));
    const afterSet = new Set(after);
    const orphans = before.filter((id) => !afterSet.has(id));
    for (const id of orphans) {
      await deleteImage(id);
    }
    return orphans.length;
  }

  /** 清掉所有没有被任何记录引用的图片（保险用） */
  async function gcImages() {
    const recs = await allRecords();
    const used = new Set();
    recs.forEach((r) => {
      (r.problemImages || []).forEach((i) => used.add(i));
      (r.solutionImages || []).forEach((i) => used.add(i));
    });
    const db = await open();

    // 先用独立事务取全部 key（不要在事务中用 await 后再发请求）
    const txRead = db.transaction(STORE_IMG, 'readonly');
    const keys = (await req(txRead.objectStore(STORE_IMG).getAllKeys())) || [];
    const orphans = keys.filter((k) => !used.has(k));
    if (!orphans.length) return 0;

    const tx = db.transaction(STORE_IMG, 'readwrite');
    const store = tx.objectStore(STORE_IMG);
    orphans.forEach((k) => store.delete(k));
    await txDone(tx);
    return orphans.length;
  }

  async function bumpUseCount(id) {
    const rec = await getRecord(id);
    if (!rec) return null;
    rec.useCount = (rec.useCount || 0) + 1;
    const db = await open();
    const tx = db.transaction(STORE_REC, 'readwrite');
    tx.objectStore(STORE_REC).put(rec);
    await txDone(tx);
    return rec.useCount;
  }

  async function toggleStar(id) {
    const rec = await getRecord(id);
    if (!rec) return null;
    rec.star = !rec.star;
    const db = await open();
    const tx = db.transaction(STORE_REC, 'readwrite');
    tx.objectStore(STORE_REC).put(rec);
    await txDone(tx);
    return rec.star;
  }

  /* ---------- meta ---------- */
  async function getMeta(key, fallback) {
    const db = await open();
    const tx = db.transaction(STORE_META, 'readonly');
    const row = await req(tx.objectStore(STORE_META).get(key));
    return row ? row.value : fallback;
  }
  async function setMeta(key, value) {
    const db = await open();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    await txDone(tx);
  }

  async function getCategories() {
    const cats = await getMeta('categories', null);
    if (!Array.isArray(cats) || !cats.length) return DEFAULT_CATEGORIES.slice();
    return cats;
  }
  async function setCategories(list) {
    await setMeta('categories', list);
  }

  /* ---------- 存储用量 ---------- */
  async function usage() {
    const db = await open();
    const tx = db.transaction([STORE_IMG, STORE_REC], 'readonly');
    // 两个请求必须同时发出：await 会让空闲事务自动提交
    const pImgs = req(tx.objectStore(STORE_IMG).getAll());
    const pRecs = req(tx.objectStore(STORE_REC).getAll());
    const imgs = await pImgs;
    const recs = await pRecs;
    let bytes = 0;
    (imgs || []).forEach((i) => { bytes += (i.size || 0) + (i.thumbSize || 0); });
    (recs || []).forEach((r) => { bytes += JSON.stringify(r).length * 2; });
    let quota = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        quota = est.quota || 0;
      }
    } catch (e) { /* ignore */ }
    return {
      bytes,
      quota,
      imageCount: (imgs || []).length,
      recordCount: (recs || []).length
    };
  }

  /* ---------- 备份 / 还原 ---------- */
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  async function dataURLToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
  }

  async function exportBackup() {
    const db = await open();
    const tx = db.transaction([STORE_REC, STORE_IMG, STORE_META], 'readonly');
    const pRecs = req(tx.objectStore(STORE_REC).getAll());
    const pImgs = req(tx.objectStore(STORE_IMG).getAll());
    const pMeta = req(tx.objectStore(STORE_META).getAll());
    const records = await pRecs;
    const images = await pImgs;
    const metas = await pMeta;

    const imgOut = [];
    for (const im of images || []) {
      imgOut.push({
        id: im.id,
        full: await blobToDataURL(im.full),
        thumb: await blobToDataURL(im.thumb),
        w: im.w, h: im.h, size: im.size, thumbSize: im.thumbSize,
        type: im.type, name: im.name, createdAt: im.createdAt
      });
    }
    return {
      app: 'issue-vault',
      version: 1,
      exportedAt: new Date().toISOString(),
      records: records || [],
      images: imgOut,
      meta: (metas || []).reduce((acc, m) => { acc[m.key] = m.value; return acc; }, {})
    };
  }

  /**
   * @param {object} backup 备份对象
   * @param {'merge'|'replace'} mode
   */
  async function importBackup(backup, mode) {
    if (!backup || backup.app !== 'issue-vault' || !Array.isArray(backup.records)) {
      throw new Error('不是有效的备份文件');
    }
    const db = await open();

    if (mode === 'replace') {
      const tx0 = db.transaction([STORE_REC, STORE_IMG, STORE_META], 'readwrite');
      tx0.objectStore(STORE_REC).clear();
      tx0.objectStore(STORE_IMG).clear();
      tx0.objectStore(STORE_META).clear();
      await txDone(tx0);
    }

    // 图片
    let imgCount = 0;
    for (const im of backup.images || []) {
      try {
        const full = await dataURLToBlob(im.full);
        const thumb = im.thumb ? await dataURLToBlob(im.thumb) : full;
        const tx = db.transaction(STORE_IMG, 'readwrite');
        tx.objectStore(STORE_IMG).put({
          id: im.id, full, thumb,
          w: im.w, h: im.h, size: full.size, thumbSize: thumb.size,
          type: im.type || 'image/jpeg', name: im.name || '', createdAt: im.createdAt || Date.now()
        });
        await txDone(tx);
        imgCount++;
      } catch (e) {
        console.warn('图片恢复失败', im.id, e);
      }
    }

    // 记录
    let recCount = 0;
    for (const r of backup.records) {
      const tx = db.transaction(STORE_REC, 'readwrite');
      tx.objectStore(STORE_REC).put(r);
      await txDone(tx);
      recCount++;
    }

    // meta
    if (backup.meta && typeof backup.meta === 'object') {
      for (const k of Object.keys(backup.meta)) {
        if (k === 'categories') {
          await setMeta(k, backup.meta[k]);
        }
      }
    }
    return { recCount, imgCount };
  }

  async function wipeAll() {
    const db = await open();
    const tx = db.transaction([STORE_REC, STORE_IMG, STORE_META], 'readwrite');
    tx.objectStore(STORE_REC).clear();
    tx.objectStore(STORE_IMG).clear();
    tx.objectStore(STORE_META).clear();
    await txDone(tx);
  }

  function objectURL(blob) {
    return blob ? URL.createObjectURL(blob) : '';
  }

  return {
    open, uid,
    addImage, getImage, deleteImage, getThumbs,
    allRecords, getRecord, saveRecord, deleteRecord, pruneImages, gcImages,
    bumpUseCount, toggleStar,
    getMeta, setMeta, getCategories, setCategories,
    usage, exportBackup, importBackup, wipeAll, objectURL,
    DEFAULT_CATEGORIES
  };
})();
