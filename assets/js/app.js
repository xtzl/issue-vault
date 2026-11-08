/* ===========================================================
   问题手册 · 主程序
   =========================================================== */
(function () {
  'use strict';

  const DB = window.VaultDB;

  /* ---------------- 状态 ---------------- */
  const state = {
    records: [],
    categories: [],
    view: 'library',
    q: '',
    cat: '',
    status: '',
    starOnly: false,
    sort: 'updated',
    limit: 40,
    editingId: null,
    editorTags: [],
    editorImages: { problem: [], solution: [] },
    editorNewImages: new Set(),
    lastUploader: 'problem',
    flashId: null,
    drawerId: null,
    import: null
  };

  const urlCache = new Map();
  const CAT_FALLBACK = '其他';

  /* ---------------- DOM ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    sidebar: $('#sidebar'),
    scrim: $('#scrim'),
    searchWrap: $('#searchWrap'),
    searchInput: $('#searchInput'),
    searchClear: $('#searchClear'),
    navCount: $('#navCount'),
    storageText: $('#storageText'),
    storageBar: $('#storageBar'),

    recordList: $('#recordList'),
    emptyLibrary: $('#emptyLibrary'),
    libTitle: $('#libTitle'),
    libSub: $('#libSub'),
    filterCats: $('#filterCats'),
    filterStatus: $('#filterStatus'),
    sortBy: $('#sortBy'),
    filterStar: $('#filterStar'),
    listToolbar: $('#listToolbar'),
    resultCount: $('#resultCount'),

    editorTitle: $('#editorTitle'),
    editorSub: $('#editorSub'),
    form: $('#recordForm'),
    fId: $('#fId'),
    fTitle: $('#fTitle'),
    fDate: $('#fDate'),
    fCategory: $('#fCategory'),
    fCustomer: $('#fCustomer'),
    dlCustomer: $('#dlCustomer'),
    fChannel: $('#fChannel'),
    fStatus: $('#fStatus'),
    fTags: $('#fTags'),
    tagList: $('#tagList'),
    tagBox: $('#tagBox'),
    suggestTags: $('#suggestTags'),
    fProblem: $('#fProblem'),
    fSolution: $('#fSolution'),
    fNote: $('#fNote'),
    fStar: $('#fStar'),
    upProblem: $('#upProblem'),
    upSolution: $('#upSolution'),
    upProblemGrid: $('#upProblemGrid'),
    upSolutionGrid: $('#upSolutionGrid'),

    drawer: $('#drawer'),
    drawerMask: $('#drawerMask'),
    drawerInner: $('#drawerInner'),

    lightbox: $('#lightbox'),
    lbImg: $('#lbImg'),
    lbCount: $('#lbCount'),

    modalMask: $('#modalMask'),
    modalTitle: $('#modalTitle'),
    modalText: $('#modalText'),
    modalOk: $('#modalOk'),
    modalCancel: $('#modalCancel'),

    toastWrap: $('#toastWrap'),

    statCards: $('#statCards'),
    catChart: $('#catChart'),
    topUsed: $('#topUsed'),
    trendChart: $('#trendChart'),

    catManage: $('#catManage'),
    newCatInput: $('#newCatInput'),
    themeSwitch: $('#themeSwitch'),
    themeText: $('#themeText'),

    impStep1: $('#importStep1'),
    impStep2: $('#importStep2'),
    dropzone: $('#dropzone'),
    importFile: $('#importFile'),
    sheetSelect: $('#sheetSelect'),
    hasHeader: $('#hasHeader'),
    mapGrid: $('#mapGrid'),
    previewTable: $('#previewTable'),
    previewInfo: $('#previewInfo'),
    btnDoImport: $('#btnDoImport'),
    skipDuplicate: $('#skipDuplicate'),
    mergeTitle: $('#mergeTitle')
  };

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeReg(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const parts = String(iso).split('-');
    if (parts.length < 3) return iso;
    const y = +parts[0], m = +parts[1], d = +parts[2];
    if (!y || !m || !d) return iso;
    const now = new Date();
    if (y === now.getFullYear()) return m + ' 月 ' + d + ' 日';
    return y + '/' + m + '/' + d;
  }
  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
    const d = new Date(ts);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function tokensOf(q) {
    return String(q || '').toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }
  function highlight(text, tokens) {
    const safe = escapeHtml(text);
    if (!tokens || !tokens.length) return safe;
    const uniq = Array.from(new Set(tokens.filter(Boolean))).sort((a, b) => b.length - a.length);
    if (!uniq.length) return safe;
    const re = new RegExp('(' + uniq.map(escapeReg).join('|') + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }
  function snippet(text, tokens, len) {
    const L = len || 120;
    if (!text) return '';
    // 多行内容压成一行时用 · 分段，保留「步骤感」
    const src = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/\n+/g, ' · ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (src.length <= L) return src;
    const lower = src.toLowerCase();
    let pos = -1;
    (tokens || []).forEach((t) => {
      const p = lower.indexOf(t.toLowerCase());
      if (p >= 0 && (pos < 0 || p < pos)) pos = p;
    });
    if (pos < 0) return src.slice(0, L) + '…';
    const start = Math.max(0, pos - 24);
    const end = Math.min(src.length, start + L);
    return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '');
  }
  function linkify(escaped) {
    return String(escaped).replace(
      /(https?:\/\/[^\s<）)】」]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  }
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
  }
  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    const icon = type === 'err' ? '#i-alert' : '#i-check';
    t.innerHTML =
      '<svg width="16" height="16"><use href="' + icon + '"/></svg><span>' + escapeHtml(msg) + '</span>';
    el.toastWrap.appendChild(t);
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 240);
    }, 2400);
  }

  let modalResolve = null;
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      el.modalTitle.textContent = opts.title || '确认操作';
      el.modalText.innerHTML = opts.text || '';
      el.modalOk.textContent = opts.okText || '确定';
      el.modalOk.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
      el.modalMask.classList.add('show');
      modalResolve = resolve;
    });
  }
  function closeModal(result) {
    el.modalMask.classList.remove('show');
    if (modalResolve) {
      modalResolve(result);
      modalResolve = null;
    }
  }

  /* ---------------- 图片 URL ---------------- */
  async function ensureUrl(imageId, kind) {
    const k = imageId + ':' + (kind || 'thumb');
    if (urlCache.has(k)) return urlCache.get(k);
    const im = await DB.getImage(imageId);
    if (!im) return '';
    const blob = (kind === 'full') ? im.full : im.thumb;
    const url = URL.createObjectURL(blob);
    urlCache.set(k, url);
    return url;
  }

  async function fillThumbs(container) {
    const nodes = $$('[data-thumb]', container || document);
    await Promise.all(nodes.map(async (node) => {
      if (node.dataset.filled) return;
      const id = node.dataset.thumb;
      if (!id) return;
      try {
        const url = await ensureUrl(id, 'thumb');
        if (url && node.isConnected) {
          if (node.tagName === 'IMG') node.src = url;
          else node.style.backgroundImage = 'url(' + JSON.stringify(url) + ')';
          node.dataset.filled = '1';
        }
      } catch (e) { /* ignore */ }
    }));
  }

  /* ---------------- 视图切换 ---------------- */
  function setView(name) {
    state.view = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    closeSidebar();
    $('.workspace').scrollTop = 0;

    if (name === 'library') renderLibrary();
    if (name === 'stats') renderStats();
    if (name === 'settings') renderSettings();
  }

  function openSidebar() {
    el.sidebar.classList.add('open');
    el.scrim.classList.add('show');
  }
  function closeSidebar() {
    el.sidebar.classList.remove('open');
    el.scrim.classList.remove('show');
  }

  /* ---------------- 筛选与搜索 ---------------- */
  /* 搜索相关度：标题命中权重最高，其次是标签、问题、解法 */
  function relevanceScore(rec, tokens) {
    if (!tokens.length) return 0;
    const t = String(rec.title || '').toLowerCase();
    const p = String(rec.problem || '').toLowerCase();
    const s = String(rec.solution || '').toLowerCase();
    const g = (rec.tags || []).join(' ').toLowerCase();
    const c = String(rec.customer || '').toLowerCase();
    const cat = String(rec.category || '').toLowerCase();
    let score = 0;
    tokens.forEach((tk) => {
      if (t.indexOf(tk) >= 0) score += 10;
      if (g.indexOf(tk) >= 0) score += 7;
      if (c.indexOf(tk) >= 0) score += 5;
      if (cat.indexOf(tk) >= 0) score += 4;
      if (p.indexOf(tk) >= 0) score += 3;
      if (s.indexOf(tk) >= 0) score += 2;
    });
    return score;
  }

  function filteredRecords() {
    const tokens = tokensOf(state.q);
    let list = state.records.slice();

    if (state.cat) list = list.filter((r) => r.category === state.cat);
    if (state.status) list = list.filter((r) => r.status === state.status);
    if (state.starOnly) list = list.filter((r) => r.star);

    if (tokens.length) {
      list = list.filter((r) => {
        const hay = [
          r.title, r.problem, r.solution, r.note, r.customer,
          r.category, r.channel, r.status, (r.tags || []).join(' ')
        ].join(' ').toLowerCase();
        return tokens.every((t) => hay.indexOf(t) >= 0);
      });
    }

    const sort = state.sort;

    if (sort === 'occurred') {
      list.sort((a, b) => {
        const d1 = a.occurredAt || '', d2 = b.occurredAt || '';
        if (d1 !== d2) return d2.localeCompare(d1);
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return list;
    }
    if (sort === 'used') {
      list.sort((a, b) => {
        const c = (b.useCount || 0) - (a.useCount || 0);
        return c || (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return list;
    }
    if (sort === 'title') {
      list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'));
      return list;
    }

    // 默认：「最近更新」。搜索时改为相关度优先，命中更准
    if (tokens.length) {
      const scores = new Map();
      list.forEach((r) => scores.set(r.id, relevanceScore(r, tokens)));
      list.sort((a, b) => {
        const d = scores.get(b.id) - scores.get(a.id);
        if (d) return d;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    } else {
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      // 星标置顶
      list.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0));
    }
    return list;
  }

  function renderFilterCats() {
    const counts = {};
    state.records.forEach((r) => {
      counts[r.category] = (counts[r.category] || 0) + 1;
    });
    const cats = state.categories.slice();
    Object.keys(counts).forEach((c) => {
      if (c && !cats.includes(c)) cats.push(c);
    });

    let html = '<button class="chip' + (state.cat === '' ? ' active' : '') + '" data-cat="">全部 ' +
      '<span style="opacity:.6">' + state.records.length + '</span></button>';
    cats.forEach((c) => {
      const n = counts[c] || 0;
      if (!n && state.cat !== c) return;
      html += '<button class="chip' + (state.cat === c ? ' active' : '') + '" data-cat="' + escapeHtml(c) + '">' +
        escapeHtml(c) + (n ? ' <span style="opacity:.6">' + n + '</span>' : '') + '</button>';
    });
    el.filterCats.innerHTML = html;
  }

  /* 问题摘要：如果标题就是问题开头的截断，去掉重复部分 */
  function problemPreview(rec, tokens) {
    const p = String(rec.problem || '').trim();
    if (!p) return '';
    const t = String(rec.title || '').trim().replace(/[…\.]{1,3}$/, '').trim();
    if (t && t.length >= 5 && p.startsWith(t)) {
      const rest = p.slice(t.length).replace(/^[\s，,。.、；;：:！!？?]+/, '').trim();
      return rest ? snippet(rest, tokens, 130) : '';
    }
    return snippet(p, tokens, 130);
  }

  /* ---------------- 记录卡片 ---------------- */
  function recordCardHtml(r, tokens) {
    const allImgs = (r.problemImages || []).concat(r.solutionImages || []);
    const thumbs = allImgs.slice(0, 3);
    const imgTotal = allImgs.length;
    const tags = (r.tags || []).slice(0, 3);
    const hasFilter = state.q || state.cat || state.status || state.starOnly;

    let thumbHtml = '';
    if (thumbs.length) {
      thumbHtml = '<div class="rc-thumbs">' +
        thumbs.map((id) => '<img data-thumb="' + escapeHtml(id) + '" alt="">').join('') +
        '</div>';
    }

    const snippetText = problemPreview(r, tokens);
    const solText = r.solution ? snippet(r.solution, tokens, 90) : '';

    return '' +
      '<article class="record-card" data-id="' + escapeHtml(r.id) + '" tabindex="0">' +
        '<div class="rc-main">' +
          '<div class="rc-top">' +
            '<button class="rc-star' + (r.star ? ' on' : '') + '" data-star="' + escapeHtml(r.id) + '" title="标为重点">' +
              '<svg width="15" height="15"><use href="#i-' + (r.star ? 'star-fill' : 'star') + '"/></svg>' +
            '</button>' +
            '<h3 class="rc-title">' + highlight(r.title || '未命名', tokens) + '</h3>' +
            '<span class="rc-flag flag-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</span>' +
          '</div>' +
          '<div class="rc-meta">' +
            '<span class="rc-cat">' + escapeHtml(r.category || CAT_FALLBACK) + '</span>' +
            (r.customer ? '<span>' + escapeHtml(r.customer) + '</span>' : '') +
            '<span>' + escapeHtml(fmtDate(r.occurredAt)) + '</span>' +
            (imgTotal ? '<span class="rc-imgcount">' + imgTotal + ' 张图</span>' : '') +
            (r.useCount ? '<span>用过 ' + r.useCount + ' 次</span>' : '') +
            (r.source === 'import' ? '<span style="opacity:.65">导入</span>' : '') +
          '</div>' +
          (snippetText ? '<p class="rc-snippet">' + highlight(snippetText, tokens) + '</p>' : '') +
          (solText ? '<div class="rc-solution"><b>解法</b>' + highlight(solText, tokens) + '</div>' : '') +
          (tags.length ? '<div class="rc-meta" style="margin-top:8px;margin-bottom:0">' +
            tags.map((t) => '<span style="color:var(--text-3)">#' + escapeHtml(t) + '</span>').join('') +
            '</div>' : '') +
        '</div>' +
        thumbHtml +
      '</article>';
  }

  function renderLibrary() {
    const all = filteredRecords();
    const tokens = tokensOf(state.q);
    const shown = all.slice(0, state.limit);

    el.recordList.innerHTML = shown.map((r) => recordCardHtml(r, tokens)).join('');

    // 空状态
    const noData = state.records.length === 0;
    const noResult = all.length === 0 && !noData;
    el.emptyLibrary.classList.toggle('show', noData || noResult);
    if (noResult) {
      el.emptyLibrary.querySelector('h3').textContent = '没有找到匹配的记录';
      el.emptyLibrary.querySelector('p').textContent = '换个关键词试试，或者清除筛选条件。';
      el.emptyLibrary.querySelector('.empty-actions').innerHTML =
        '<button class="btn btn-ghost" id="btnClearAllFilter">清除筛选条件</button>';
      const b = $('#btnClearAllFilter');
      if (b) b.onclick = resetFilters;
    } else if (noData) {
      el.emptyLibrary.querySelector('h3').textContent = '还没有登记过问题';
      el.emptyLibrary.querySelector('p').textContent = '把处理过的问题和回复方法记下来，下次遇到直接搜。';
      el.emptyLibrary.querySelector('.empty-actions').innerHTML =
        '<button class="btn btn-primary" id="btnEmptyNew"><svg width="16" height="16"><use href="#i-plus"/></svg>登记第一条</button>' +
        '<button class="btn btn-ghost" id="btnEmptyImport">导入已有表格</button>';
      const n = $('#btnEmptyNew'), i = $('#btnEmptyImport');
      if (n) n.onclick = () => openEditor();
      if (i) i.onclick = () => setView('import');
    }

    // 无记录时不显示筛选条
    const fbar = $('#filterbar');
    if (fbar) fbar.hidden = state.records.length === 0;

    // 计数
    const hasFilter = state.q || state.cat || state.status || state.starOnly;
    el.listToolbar.hidden = !hasFilter || all.length === 0;
    el.resultCount.innerHTML = all.length
      ? '找到 <b>' + all.length + '</b> 条记录'
      : '';
    el.libTitle.textContent = state.q ? '搜索结果' : '问题库';

    // 副标题按当前筛选条件如实描述，避免「显示 0 条却说共 9 条」
    const conds = [];
    if (state.q) conds.push('关键词「' + state.q + '」');
    if (state.cat) conds.push('分类：' + state.cat);
    if (state.status) conds.push('状态：' + state.status);
    if (state.starOnly) conds.push('只看重点');
    if (conds.length) {
      el.libSub.textContent = conds.join(' · ') + ' · 共 ' + all.length + ' 条';
    } else {
      el.libSub.textContent = state.records.length
        ? '共 ' + state.records.length + ' 条记录，点击任意一条查看完整内容'
        : '还没有记录';
    }

    // 加载更多
    const oldWrap = document.getElementById('loadMoreWrap');
    if (oldWrap) oldWrap.remove();
    if (all.length > state.limit) {
      const wrap = document.createElement('div');
      wrap.id = 'loadMoreWrap';
      wrap.style.cssText = 'text-align:center;margin-top:16px';
      wrap.innerHTML = '<button class="btn btn-ghost" id="btnLoadMore">显示更多（还有 ' +
        (all.length - state.limit) + ' 条）</button>';
      el.recordList.after(wrap);
      $('#btnLoadMore').onclick = () => {
        state.limit += 40;
        renderLibrary();
      };
    }

    // 闪现高亮
    if (state.flashId) {
      const node = el.recordList.querySelector('[data-id="' + state.flashId + '"]');
      if (node) {
        node.classList.add('flash');
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      state.flashId = null;
    }

    fillThumbs(el.recordList);
    renderFilterCats();
    updateNavCount();
  }

  function clearFilters() {
    state.q = '';
    state.cat = '';
    state.status = '';
    state.starOnly = false;
    state.limit = 40;
    el.searchInput.value = '';
    el.searchWrap.classList.remove('has-value');
    el.filterStatus.value = '';
    el.filterStar.classList.remove('active');
  }

  function resetFilters() {
    clearFilters();
    renderLibrary();
  }

  function updateNavCount() {
    el.navCount.textContent = state.records.length > 999 ? '999+' : state.records.length;
  }

  async function reload() {
    state.records = await DB.allRecords();
    state.records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /* ---------------- 编辑器 ---------------- */
  function renderCategoryOptions(selected) {
    const cats = state.categories.slice();
    if (selected && !cats.includes(selected)) cats.push(selected);
    el.fCategory.innerHTML = cats.map((c) =>
      '<option value="' + escapeHtml(c) + '"' + (c === selected ? ' selected' : '') + '>' +
      escapeHtml(c) + '</option>'
    ).join('');
  }

  function renderEditorTags() {
    const tags = state.editorTags || [];
    el.tagList.innerHTML = tags.map((t) =>
      '<span class="tag-pill">' + escapeHtml(t) +
      '<button type="button" data-rmtag="' + escapeHtml(t) + '" aria-label="移除">×</button></span>'
    ).join('');

    // 智能建议
    const counts = {};
    state.records.forEach((r) => (r.tags || []).forEach((t) => {
      counts[t] = (counts[t] || 0) + 1;
    }));
    const suggestions = Object.keys(counts)
      .filter((t) => !tags.includes(t))
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, 8);
    el.suggestTags.innerHTML = suggestions.map((t) =>
      '<button type="button" data-addtag="' + escapeHtml(t) + '">+ ' + escapeHtml(t) + '</button>'
    ).join('');
  }

  function renderCustomerList() {
    const set = new Set();
    state.records.forEach((r) => { if (r.customer) set.add(r.customer); });
    el.dlCustomer.innerHTML = Array.from(set).slice(0, 100).map((c) =>
      '<option value="' + escapeHtml(c) + '">').join('');
  }

  function resetForm() {
    el.form.reset();
    el.fId.value = '';
    el.fDate.value = todayISO();
    el.fStatus.value = '已解决';
    el.fStar.checked = false;
    state.editorTags = [];
    state.editorImages = { problem: [], solution: [] };
    state.editorNewImages = new Set();
    state.editingId = null;
    el.editorTitle.textContent = '登记新问题';
    el.editorSub.textContent = '问题现象、当时的回复、相关截图，都记在这里';
    renderCategoryOptions(state.categories[0]);
    renderEditorTags();
    renderUploadGrid('problem');
    renderUploadGrid('solution');
    renderCustomerList();
  }

  async function openEditor(id) {
    resetForm();
    if (id) {
      const rec = await DB.getRecord(id);
      if (!rec) { toast('记录不存在', 'err'); return; }
      state.editingId = id;
      el.fId.value = rec.id;
      el.fTitle.value = rec.title || '';
      el.fDate.value = rec.occurredAt || todayISO();
      renderCategoryOptions(rec.category || CAT_FALLBACK);
      el.fCustomer.value = rec.customer || '';
      el.fChannel.value = rec.channel || '';
      el.fStatus.value = rec.status || '已解决';
      el.fProblem.value = rec.problem || '';
      el.fSolution.value = rec.solution || '';
      el.fNote.value = rec.note || '';
      el.fStar.checked = !!rec.star;
      state.editorTags = (rec.tags || []).slice();
      state.editorImages = {
        problem: (rec.problemImages || []).slice(),
        solution: (rec.solutionImages || []).slice()
      };
      state.editorNewImages = new Set();
      el.editorTitle.textContent = '编辑记录';
      el.editorSub.textContent = '修改后会覆盖原内容，保存即生效';
      renderEditorTags();
      renderUploadGrid('problem');
      renderUploadGrid('solution');
      renderCustomerList();
    }
    setView('editor');
    setTimeout(() => el.fTitle.focus(), 60);
  }

  function renderUploadGrid(kind) {
    const grid = kind === 'problem' ? el.upProblemGrid : el.upSolutionGrid;
    const ids = state.editorImages[kind];
    grid.innerHTML = ids.map((id) =>
      '<div class="thumb" data-thumb="' + escapeHtml(id) + '" data-kind="' + kind + '" data-imgid="' + escapeHtml(id) + '">' +
      '<button type="button" class="thumb-del" data-delimg="' + escapeHtml(id) + '" data-kind="' + kind + '" title="移除">×</button>' +
      '</div>'
    ).join('');
    fillThumbs(grid);
  }

  async function addFilesToUploader(kind, files) {
    const all = Array.from(files || []);
    if (!all.length) return;

    const imgs = [];
    let skipped = 0;
    for (const f of all) {
      if (!f) continue;
      if (/\.(heic|heif)$/i.test(f.name || '')) {
        toast('iPhone 的 HEIC 照片浏览器读不了，请先在相册里转成 JPG', 'err');
        continue;
      }
      if (!f.type || !f.type.startsWith('image/')) {
        skipped++;
        continue;
      }
      imgs.push(f);
    }
    if (skipped) toast('只支持图片文件，已跳过 ' + skipped + ' 个', 'err');
    if (!imgs.length) return;

    toast('正在处理 ' + imgs.length + ' 张图片…');
    for (const f of imgs) {
      try {
        const id = await DB.addImage(f);
        state.editorImages[kind].push(id);
        state.editorNewImages.add(id);
      } catch (e) {
        console.warn(e);
        toast('有图片处理失败：' + (e.message || ''), 'err');
      }
    }
    renderUploadGrid(kind);
  }

  function collectForm() {
    const tags = (state.editorTags || []).slice();
    return {
      id: el.fId.value || '',
      title: el.fTitle.value.trim(),
      occurredAt: el.fDate.value || todayISO(),
      category: el.fCategory.value || CAT_FALLBACK,
      customer: el.fCustomer.value.trim(),
      channel: el.fChannel.value,
      status: el.fStatus.value,
      problem: el.fProblem.value,
      solution: el.fSolution.value,
      note: el.fNote.value,
      tags,
      star: el.fStar.checked,
      problemImages: state.editorImages.problem.slice(),
      solutionImages: state.editorImages.solution.slice(),
      source: 'manual'
    };
  }

  async function saveForm() {
    const data = collectForm();
    if (!data.title) {
      if (data.problem.trim()) {
        data.title = data.problem.trim().replace(/\s+/g, ' ').slice(0, 30);
      } else {
        toast('请先填写标题或问题描述', 'err');
        el.fTitle.focus();
        return;
      }
    }
    if (!data.problem.trim() && !data.solution.trim()) {
      toast('问题描述和解决方法至少填一项', 'err');
      el.fProblem.focus();
      return;
    }

    const isEdit = !!state.editingId;
    let old = null;
    if (isEdit) {
      old = await DB.getRecord(state.editingId);
      // 保留不可编辑字段，避免被覆盖成默认值
      if (old) {
        data.id = old.id;
        data.createdAt = old.createdAt;
        data.useCount = old.useCount || 0;
        data.source = old.source || 'manual';
      }
    }

    const saved = await DB.saveRecord(data);

    if (isEdit && old) {
      await DB.pruneImages(old, saved);
    }

    // 已入库的图片不再算「本次新增」，避免后续取消时误删
    state.editorNewImages.clear();

    await reload();
    state.flashId = saved.id;
    state.limit = 40;
    // 保存后如果被筛选条件挡住了，清掉筛选，确保能看见刚保存的记录
    if (!filteredRecords().some((x) => x.id === saved.id)) clearFilters();
    setView('library');
    toast(isEdit ? '已更新' : '已保存');
    updateStorage();
  }

  async function cancelEdit() {
    const dirty = el.fTitle.value.trim() || el.fProblem.value.trim() ||
      el.fSolution.value.trim() || state.editorImages.problem.length ||
      state.editorImages.solution.length;
    if (dirty) {
      const ok = await confirmDialog({
        title: '放弃这次编辑？',
        text: '已经填写的内容不会保存。',
        okText: '放弃并返回',
        danger: false
      });
      if (!ok) return;
    }
    // 清理本次新加但未保存的图片
    for (const id of state.editorNewImages) {
      try { await DB.deleteImage(id); } catch (e) { /* ignore */ }
    }
    state.editorNewImages.clear();
    setView('library');
  }

  /* ---------------- 详情抽屉 ---------------- */
  function openDrawer(id, opts) {
    const o = opts || {};
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    state.drawerId = id;
    const tokens = tokensOf(state.q);

    const metaParts = [];
    metaParts.push('<span>' + escapeHtml(r.category || CAT_FALLBACK) + '</span>');
    if (r.customer) metaParts.push('<span>' + escapeHtml(r.customer) + '</span>');
    if (r.occurredAt) metaParts.push('<span>' + escapeHtml(fmtDate(r.occurredAt)) + '</span>');
    if (r.channel) metaParts.push('<span>' + escapeHtml(r.channel) + '</span>');
    if (r.useCount) metaParts.push('<span>用过 ' + r.useCount + ' 次</span>');

    const pImgs = r.problemImages || [];
    const sImgs = r.solutionImages || [];
    const imgGrid = (ids, group) => {
      if (!ids.length) return '';
      const cls = ids.length === 1 ? ' single' : (ids.length === 2 ? ' double' : '');
      return '<div class="dw-images' + cls + '">' +
        ids.map((id, i) => '<img data-thumb="' + escapeHtml(id) + '" data-full="' + escapeHtml(id) +
          '" data-group="' + group + '" data-index="' + i + '" alt="">').join('') +
        '</div>';
    };

    const normHTML = (t) => linkify(highlight(t, tokens));

    el.drawerInner.innerHTML = '' +
      '<div class="dw-head">' +
        '<div class="dw-head-top">' +
          '<span class="rc-flag flag-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</span>' +
          (r.source === 'import' ? '<span class="card-note">从表格导入</span>' : '') +
          '<button class="icon-btn dw-close" data-close-drawer title="关闭"><svg width="20" height="20"><use href="#i-close"/></svg></button>' +
        '</div>' +
        '<h2 class="dw-title">' + escapeHtml(r.title || '未命名') + '</h2>' +
        '<div class="dw-meta">' + metaParts.join('') + '</div>' +
        (r.tags && r.tags.length ? '<div class="dw-tags">' +
          r.tags.map((t) => '<span class="tag-pill">#' + escapeHtml(t) + '</span>').join('') + '</div>' : '') +
      '</div>' +
      '<div class="dw-actions">' +
        (r.solution ? '<button class="btn btn-primary btn-sm" data-copy-sol="' + escapeHtml(r.id) + '">' +
          '<svg width="15" height="15"><use href="#i-copy"/></svg>复制解决方法</button>' : '') +
        '<button class="btn btn-ghost btn-sm" data-copy-all="' + escapeHtml(r.id) + '">' +
          '<svg width="15" height="15"><use href="#i-copy"/></svg>复制全文</button>' +
        '<button class="btn btn-ghost btn-sm" data-edit="' + escapeHtml(r.id) + '">' +
          '<svg width="15" height="15"><use href="#i-edit"/></svg>编辑</button>' +
        '<button class="btn btn-ghost btn-sm" data-toggle-star="' + escapeHtml(r.id) + '">' +
          '<svg width="15" height="15"><use href="#i-' + (r.star ? 'star-fill' : 'star') + '"/></svg>' +
          (r.star ? '取消重点' : '标为重点') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-del="' + escapeHtml(r.id) + '" style="margin-left:auto;color:var(--danger)">' +
          '<svg width="15" height="15"><use href="#i-trash"/></svg>删除</button>' +
      '</div>' +
      '<div class="dw-body">' +
        '<div class="dw-section">' +
          '<div class="dw-section-head"><span class="dot dot-problem"></span><span class="dw-section-title is-problem">问题描述</span></div>' +
          '<div class="dw-text' + (r.problem ? '' : ' empty-text') + '">' +
            (r.problem ? normHTML(r.problem) : '没有填写问题描述') + '</div>' +
          imgGrid(pImgs, 'problem') +
        '</div>' +
        '<div class="dw-section">' +
          '<div class="dw-section-head"><span class="dot dot-solution"></span><span class="dw-section-title is-solution">解决方法</span></div>' +
          '<div class="dw-solution"><div class="dw-text' + (r.solution ? '' : ' empty-text') + '">' +
            (r.solution ? normHTML(r.solution) : '还没有记录解决方法') + '</div></div>' +
          imgGrid(sImgs, 'solution') +
        '</div>' +
        (r.note ? '<div class="dw-section">' +
          '<div class="dw-section-head"><span class="dw-section-title">备注</span></div>' +
          '<div class="dw-text" style="font-size:13px;color:var(--text-2)">' + normHTML(r.note) + '</div>' +
        '</div>' : '') +
        '<div class="dw-section" style="border-top:1px solid var(--border);padding-top:16px">' +
          '<div class="dw-section-head"><span class="dw-section-title" style="color:var(--text-3);font-weight:400">' +
            '登记于 ' + escapeHtml(relTime(r.createdAt)) +
            (r.updatedAt && r.updatedAt !== r.createdAt ? ' · 更新于 ' + escapeHtml(relTime(r.updatedAt)) : '') +
          '</span></div>' +
        '</div>' +
      '</div>';

    el.drawer.classList.add('open');
    el.drawerMask.classList.add('show');
    el.drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    el.drawerInner.scrollTop = 0;
    fillThumbs(el.drawerInner);

    // 从列表点开时记一次「使用」，编辑/星标后的重绘不重复计数
    if (o.count !== false) {
      DB.bumpUseCount(r.id).then((n) => {
        const rec = state.records.find((x) => x.id === r.id);
        if (rec) rec.useCount = n;
      });
    }
  }

  function closeDrawer() {
    el.drawer.classList.remove('open');
    el.drawerMask.classList.remove('show');
    el.drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    state.drawerId = null;
  }

  function copyText(text, okMsg) {
    if (!text) { toast('没有可复制的内容', 'err'); return; }
    const done = () => toast(okMsg || '已复制到剪贴板');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      toast('复制失败，请手动选择文字', 'err');
    }
    ta.remove();
  }

  function recordToText(r) {
    const lines = [];
    lines.push('【' + (r.title || '未命名') + '】');
    const meta = [r.category, r.customer, r.occurredAt, r.channel].filter(Boolean);
    if (meta.length) lines.push(meta.join(' · '));
    if (r.problem) { lines.push(''); lines.push('问题：'); lines.push(r.problem); }
    if (r.solution) { lines.push(''); lines.push('解决方法：'); lines.push(r.solution); }
    if (r.note) { lines.push(''); lines.push('备注：'); lines.push(r.note); }
    return lines.join('\n');
  }

  /* ---------------- 灯箱 ---------------- */
  let lbList = [];
  let lbIndex = 0;

  async function openLightbox(ids, index) {
    lbList = ids.slice();
    lbIndex = index || 0;
    await showLb();
    el.lightbox.classList.add('show');
    el.lightbox.setAttribute('aria-hidden', 'false');
  }
  async function showLb() {
    const id = lbList[lbIndex];
    if (!id) return;
    const url = await ensureUrl(id, 'full');
    el.lbImg.src = url || '';
    el.lbCount.textContent = (lbIndex + 1) + ' / ' + lbList.length;
    const multi = lbList.length > 1;
    $('#lbPrev').style.display = multi ? 'grid' : 'none';
    $('#lbNext').style.display = multi ? 'grid' : 'none';
  }
  function closeLightbox() {
    el.lightbox.classList.remove('show');
    el.lightbox.setAttribute('aria-hidden', 'true');
    el.lbImg.src = '';
    lbList = [];
  }
  function lbMove(d) {
    if (lbList.length < 2) return;
    lbIndex = (lbIndex + d + lbList.length) % lbList.length;
    showLb();
  }

  /* ---------------- 统计 ---------------- */
  function renderStats() {
    const recs = state.records;
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const monthCount = recs.filter((r) => {
      if (!r.createdAt) return false;
      const d = new Date(r.createdAt);
      return (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')) === ym;
    }).length;
    const solved = recs.filter((r) => r.status === '已解决').length;
    const pending = recs.filter((r) => r.status !== '已解决').length;
    const rate = recs.length ? Math.round((solved / recs.length) * 100) : 0;
    const imgCount = recs.reduce((n, r) => n + (r.problemImages || []).length + (r.solutionImages || []).length, 0);

    el.statCards.innerHTML = [
      { label: '累计记录', value: recs.length, foot: '本月新增 ' + monthCount + ' 条' },
      { label: '已解决', value: solved, foot: '解决率 ' + rate + '%' },
      { label: '待跟进', value: pending, foot: pending ? '还有待办事项' : '全部处理完毕' },
      { label: '现场图片', value: imgCount, foot: '问题与解决截图' }
    ].map((s) =>
      '<div class="stat-card"><div class="stat-label">' + escapeHtml(s.label) + '</div>' +
      '<div class="stat-value">' + s.value + '</div>' +
      '<div class="stat-foot">' + escapeHtml(s.foot) + '</div></div>'
    ).join('');

    // 分类分布
    const byCat = {};
    recs.forEach((r) => { byCat[r.category || CAT_FALLBACK] = (byCat[r.category || CAT_FALLBACK] || 0) + 1; });
    const catRows = Object.keys(byCat).map((k) => ({ k, n: byCat[k] })).sort((a, b) => b.n - a.n);
    const maxCat = catRows.length ? catRows[0].n : 0;
    el.catChart.innerHTML = catRows.length ? catRows.map((row) =>
      '<div class="bar-row">' +
        '<div class="bar-name" title="' + escapeHtml(row.k) + '">' + escapeHtml(row.k) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (maxCat ? Math.max(4, (row.n / maxCat) * 100) : 0) + '%"></div></div>' +
        '<div class="bar-num">' + row.n + '</div>' +
      '</div>'
    ).join('') : '<p class="para" style="margin:0">还没有数据</p>';

    // 最常查看
    const top = recs.filter((r) => r.useCount > 0).sort((a, b) => b.useCount - a.useCount).slice(0, 6);
    el.topUsed.innerHTML = top.length ? '<div class="top-list">' + top.map((r, i) =>
      '<div class="top-item" data-id="' + escapeHtml(r.id) + '">' +
        '<span class="top-rank">' + (i + 1) + '</span>' +
        '<span class="top-name">' + escapeHtml(r.title || '未命名') + '</span>' +
        '<span class="top-count">' + r.useCount + ' 次</span>' +
      '</div>'
    ).join('') + '</div>' : '<p class="para" style="margin:0">还没有使用记录。打开详情会自动计数。</p>';

    // 趋势
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      days.push({ key, label: (d.getMonth() + 1) + '/' + d.getDate(), n: 0 });
    }
    recs.forEach((r) => {
      const d = r.occurredAt || (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '');
      const hit = days.find((x) => x.key === d);
      if (hit) hit.n++;
    });
    const maxDay = Math.max(1, ...days.map((d) => d.n));
    el.trendChart.innerHTML = days.map((d, i) => {
      // 从最后一天往前隔一天标一次，保证今天有标签
      const showLabel = (days.length - 1 - i) % 2 === 0;
      const h = d.n ? Math.max(8, (d.n / maxDay) * 100) : 0;
      return '<div class="trend-col" title="' + d.key + '：' + d.n + ' 条">' +
        '<div class="trend-bar' + (d.n ? '' : ' zero') + '"' +
          (d.n ? ' style="height:' + h + '%"' : '') + '></div>' +
        '<span class="trend-x">' + (showLabel ? d.label : '') + '</span>' +
      '</div>';
    }).join('');
  }

  /* ---------------- 设置 ---------------- */
  function renderSettings() {
    el.catManage.innerHTML = state.categories.map((c) =>
      '<span class="cat-item">' + escapeHtml(c) +
      '<button data-rmcat="' + escapeHtml(c) + '" title="删除分类">×</button></span>'
    ).join('');
  }

  async function updateStorage() {
    try {
      const u = await DB.usage();
      el.storageText.textContent = fmtBytes(u.bytes);
      // 浏览器配额通常极大，按 200MB 参考展示更有意义
      const pct = Math.min(100, Math.max(1, (u.bytes / (200 * 1024 * 1024)) * 100));
      el.storageBar.style.width = u.bytes ? pct.toFixed(1) + '%' : '0%';
      el.storageBar.parentElement.title = fmtBytes(u.bytes) + ' · ' + u.recordCount + ' 条记录 · ' + u.imageCount + ' 张图片';
      const detail = $('#storageDetail');
      if (detail) {
        detail.textContent = '已用 ' + fmtBytes(u.bytes) + ' · ' + u.recordCount + ' 条记录 · ' + u.imageCount + ' 张图片';
      }
    } catch (e) {
      el.storageText.textContent = '—';
    }
  }

  /* ---------------- 导出 ---------------- */
  function toCSV(records) {
    const head = ['标题', '发生日期', '分类', '客户/供应商', '渠道', '状态', '问题描述', '解决方法', '备注', '标签', '使用次数', '更新时间'];
    const esc = (v) => {
      const s = String(v == null ? '' : v).replace(/\r\n/g, '\n');
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const rows = records.map((r) => [
      r.title, r.occurredAt, r.category, r.customer, r.channel, r.status,
      r.problem, r.solution, r.note, (r.tags || []).join('、'),
      r.useCount || 0,
      r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN') : ''
    ].map(esc).join(','));
    return '\ufeff' + head.join(',') + '\n' + rows.join('\n');
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  async function exportBackup() {
    toast('正在打包，图片多时请稍等…');
    try {
      const data = await DB.exportBackup();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      downloadBlob(blob, '问题手册-完整备份-' + stamp() + '.json');
      toast('备份已导出（' + data.records.length + ' 条记录）');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + (e.message || '未知错误'), 'err');
    }
  }

  async function exportCSV(records) {
    const list = records || state.records;
    if (!list.length) { toast('还没有可导出的记录', 'err'); return; }
    const blob = new Blob([toCSV(list)], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, '问题手册-' + stamp() + '.csv');
    toast('已导出 ' + list.length + ' 条记录');
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('vault-theme', t); } catch (e) { /* ignore */ }
    const dark = t === 'dark';
    if (el.themeSwitch) el.themeSwitch.checked = dark;
    if (el.themeText) el.themeText.textContent = dark ? '浅色模式' : '深色模式';
    const btn = $('#btnTheme');
    if (btn) btn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  /* ---------------- 导入流程 ---------------- */
  async function handleImportFile(file) {
    if (!file) return;
    try {
      const wb = await Importer.readFile(file);
      const sheetNames = wb.SheetNames || [];
      if (!sheetNames.length) { toast('表格里没有工作表', 'err'); return; }

      state.import = {
        wb,
        fileName: file.name,
        sheetName: sheetNames[0],
        parsed: null,
        mapping: {}
      };

      el.sheetSelect.innerHTML = sheetNames.map((n) =>
        '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
      el.sheetSelect.value = sheetNames[0];

      el.impStep1.hidden = true;
      el.impStep2.hidden = false;
      parseCurrentSheet();
      toast('已读取：' + file.name);
    } catch (e) {
      console.error(e);
      toast('读取失败：' + (e.message || '文件格式不支持'), 'err');
    }
  }

  function parseCurrentSheet() {
    if (!state.import) return;
    const ws = state.import.wb.Sheets[state.import.sheetName];
    const hasHeader = el.hasHeader.checked;
    const parsed = Importer.parseSheet(ws, hasHeader);
    state.import.parsed = parsed;

    const mapping = Importer.autoMap(parsed.header);
    state.import.mapping = mapping;

    renderMapping();
    renderPreview();
  }

  const FIELD_LIST = [
    { key: 'title', label: '标题' },
    { key: 'occurredAt', label: '发生日期' },
    { key: 'category', label: '分类' },
    { key: 'customer', label: '客户 / 供应商' },
    { key: 'channel', label: '来源渠道' },
    { key: 'status', label: '处理状态' },
    { key: 'problem', label: '问题描述', required: true },
    { key: 'solution', label: '解决方法', required: true },
    { key: 'note', label: '备注' },
    { key: 'tags', label: '标签' },
    { key: 'problemImages', label: '问题照片' },
    { key: 'solutionImages', label: '解决照片' }
  ];

  function renderMapping() {
    const p = state.import.parsed;
    const map = state.import.mapping;
    const opts = ['<option value="-1">— 不导入 —</option>']
      .concat(p.header.map((h, i) =>
        '<option value="' + i + '">' + escapeHtml(h) + '</option>'));

    el.mapGrid.innerHTML = FIELD_LIST.map((f) => {
      const cur = map[f.key] !== undefined ? map[f.key] : -1;
      const select = '<select class="select" data-map="' + f.key + '">' +
        opts.map((o) => {
          if (o.indexOf('value="-1"') > -1) return o.replace('<option', '<option' + (cur === -1 ? ' selected' : ''));
          const m = o.match(/value="(\d+)"/);
          if (m && +m[1] === cur) return o.replace('<option', '<option selected');
          return o;
        }).join('') + '</select>';
      return '<div class="map-row"><label>' + escapeHtml(f.label) +
        (f.required ? '<i>*</i>' : '') + '</label>' + select + '</div>';
    }).join('');
  }

  function renderPreview() {
    const p = state.import.parsed;
    const mapping = state.import.mapping;
    const rows = p.rows.slice(0, 6);

    const cols = FIELD_LIST.filter((f) => mapping[f.key] !== undefined && mapping[f.key] >= 0);

    if (!p.rows.length) {
      el.previewTable.innerHTML = '<tbody><tr><td style="padding:20px;color:var(--text-3)">这张表没有数据行</td></tr></tbody>';
      el.previewInfo.textContent = '';
      el.btnDoImport.disabled = true;
      return;
    }

    let html = '<thead><tr>' + cols.map((c) => '<th>' + escapeHtml(c.label) + '</th>').join('') + '</tr></thead><tbody>';
    rows.forEach((row) => {
      html += '<tr>' + cols.map((c) => {
        const raw = row[mapping[c.key]];
        // 日期列显示解析后的结果，方便确认
        let v = c.key === 'occurredAt'
          ? (Importer.parseDate(raw) || Importer.cellText(raw))
          : Importer.cellText(raw);
        const short = v.length > 90 ? v.slice(0, 90) + '…' : v;
        return '<td title="' + escapeHtml(v) + '">' + escapeHtml(short) + '</td>';
      }).join('') + '</tr>';
    });
    html += '</tbody>';
    el.previewTable.innerHTML = html;

    el.previewInfo.textContent = '共 ' + p.rows.length + ' 行 × ' + p.width + ' 列，预览前 ' + Math.min(6, p.rows.length) + ' 行';
    el.btnDoImport.disabled = !(mapping.problem !== undefined && mapping.problem >= 0) &&
      !(mapping.solution !== undefined && mapping.solution >= 0);
  }

  async function doImport() {
    if (!state.import || !state.import.parsed) return;
    const p = state.import.parsed;
    const mapping = state.import.mapping;

    if ((mapping.problem === undefined || mapping.problem < 0) &&
        (mapping.solution === undefined || mapping.solution < 0)) {
      toast('至少要对应「问题描述」或「解决方法」其中一列', 'err');
      return;
    }

    const result = Importer.buildRecords(p.rows, mapping, {
      skipDuplicate: el.skipDuplicate.checked,
      mergeTitle: el.mergeTitle.checked
    });

    if (!result.records.length) {
      toast('没有可导入的新记录（可能全部重复或为空）', 'err');
      return;
    }

    // 与库里已有记录去重
    const existing = new Set(state.records.map((r) => (r.title + '|' + r.problem).toLowerCase()));
    const fresh = result.records.filter((r) => !existing.has((r.title + '|' + r.problem).toLowerCase()));
    const dupCount = result.records.length - fresh.length;

    if (!fresh.length) {
      toast('这些记录都已经导入过了', 'err');
      return;
    }

    el.btnDoImport.disabled = true;
    el.btnDoImport.querySelector('span').textContent = '导入中…';

    let ok = 0;
    for (const r of fresh) {
      try {
        await DB.saveRecord(r);
        ok++;
      } catch (e) {
        console.warn('导入失败', r.title, e);
      }
    }

    await reload();

    // 把导入时出现的新分类补进分类表，方便以后筛选
    const known = new Set(state.categories);
    let added = 0;
    state.records.forEach((r) => {
      if (r.category && !known.has(r.category)) {
        known.add(r.category);
        state.categories.push(r.category);
        added++;
      }
    });
    if (added) await DB.setCategories(state.categories);

    await updateStorage();
    el.impStep1.hidden = false;
    el.impStep2.hidden = true;
    state.import = null;
    el.importFile.value = '';
    el.btnDoImport.disabled = false;
    el.btnDoImport.querySelector('span').textContent = '开始导入';

    state.limit = 40;
    state.flashId = null;
    clearFilters();
    setView('library');
    toast('导入完成：新增 ' + ok + ' 条' + (dupCount ? '，跳过重复 ' + dupCount + ' 条' : ''));
  }

  /* ---------------- 事件绑定 ---------------- */

  // 导航
  $$('.nav-item').forEach((n) => {
    n.addEventListener('click', () => setView(n.dataset.view));
  });
  $('#btnOpenSidebar').onclick = openSidebar;
  $('#btnCloseSidebar').onclick = closeSidebar;
  el.scrim.onclick = closeSidebar;

  // 新建
  $('#btnNew').onclick = () => openEditor();
  $('#btnNewTop').onclick = () => openEditor();

  // 搜索
  const onSearch = debounce(() => {
    state.q = el.searchInput.value.trim();
    state.limit = 40;
    if (state.view !== 'library') setView('library');
    else renderLibrary();
  }, 180);
  el.searchInput.addEventListener('input', () => {
    el.searchWrap.classList.toggle('has-value', !!el.searchInput.value);
    onSearch();
  });
  el.searchClear.onclick = () => {
    el.searchInput.value = '';
    el.searchWrap.classList.remove('has-value');
    state.q = '';
    renderLibrary();
    el.searchInput.focus();
  };

  // 筛选
  el.filterCats.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.cat = btn.dataset.cat || '';
    state.limit = 40;
    renderLibrary();
  });
  el.filterStatus.onchange = () => {
    state.status = el.filterStatus.value;
    state.limit = 40;
    renderLibrary();
  };
  el.sortBy.onchange = () => {
    state.sort = el.sortBy.value;
    renderLibrary();
  };
  el.filterStar.onclick = () => {
    state.starOnly = !state.starOnly;
    el.filterStar.classList.toggle('active', state.starOnly);
    state.limit = 40;
    renderLibrary();
  };
  $('#btnResetFilter').onclick = resetFilters;

  // 列表交互
  el.recordList.addEventListener('click', (e) => {
    const starBtn = e.target.closest('[data-star]');
    if (starBtn) {
      e.stopPropagation();
      const id = starBtn.dataset.star;
      DB.toggleStar(id).then((v) => {
        const rec = state.records.find((r) => r.id === id);
        if (rec) rec.star = v;
        renderLibrary();
        toast(v ? '已标为重点' : '已取消重点');
      });
      return;
    }
    const card = e.target.closest('.record-card');
    if (card) openDrawer(card.dataset.id);
  });
  el.recordList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const card = e.target.closest('.record-card');
      if (card) openDrawer(card.dataset.id);
    }
  });

  // 编辑器
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveForm();
  });
  $('#btnSave').onclick = (e) => { e.preventDefault(); saveForm(); };
  $('#btnBackFromEdit').onclick = cancelEdit;
  $('#btnCancelEdit').onclick = cancelEdit;
  $('#btnCancelEdit2').onclick = cancelEdit;

  // 标签
  el.fTags.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      const v = el.fTags.value.trim().replace(/^#/, '');
      if (!v) return;
      state.editorTags = state.editorTags || [];
      if (!state.editorTags.includes(v)) {
        state.editorTags.push(v);
        renderEditorTags();
      }
      el.fTags.value = '';
    } else if (e.key === 'Backspace' && !el.fTags.value) {
      state.editorTags = state.editorTags || [];
      if (state.editorTags.length) {
        state.editorTags.pop();
        renderEditorTags();
      }
    }
  });
  el.tagBox.addEventListener('click', () => el.fTags.focus());
  el.tagList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rmtag]');
    if (!btn) return;
    state.editorTags = (state.editorTags || []).filter((t) => t !== btn.dataset.rmtag);
    renderEditorTags();
  });
  el.suggestTags.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-addtag]');
    if (!btn) return;
    const t = btn.dataset.addtag;
    state.editorTags = state.editorTags || [];
    if (!state.editorTags.includes(t)) {
      state.editorTags.push(t);
      renderEditorTags();
    }
  });

  // 图片上传
  $$('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.pick === 'upSolution' ? 'solution' : 'problem';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => addFilesToUploader(kind, input.files);
      input.click();
    });
  });

  ['upProblem', 'upSolution'].forEach((id) => {
    const box = document.getElementById(id);
    const kind = id === 'upSolution' ? 'solution' : 'problem';
    box.addEventListener('click', (e) => {
      state.lastUploader = kind;
      const del = e.target.closest('[data-delimg]');
      if (del) {
        const imgId = del.dataset.delimg;
        state.editorImages[kind] = state.editorImages[kind].filter((x) => x !== imgId);
        if (state.editorNewImages.has(imgId)) {
          DB.deleteImage(imgId).catch(() => {});
          state.editorNewImages.delete(imgId);
        }
        renderUploadGrid(kind);
        return;
      }
      // 点缩略图预览大图，确认放对了没有
      const thumb = e.target.closest('.thumb');
      if (thumb && thumb.dataset.imgid) {
        const ids = state.editorImages[kind];
        const idx = ids.indexOf(thumb.dataset.imgid);
        openLightbox(ids, idx < 0 ? 0 : idx);
      }
    });
    box.addEventListener('dragenter', (e) => {
      e.preventDefault();
      box.classList.add('dragover');
      state.lastUploader = kind;
    });
    box.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget)) box.classList.remove('dragover');
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        addFilesToUploader(kind, e.dataTransfer.files);
      }
    });
  });

  // 粘贴
  document.addEventListener('paste', (e) => {
    if (state.view !== 'editor') return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFilesToUploader(state.lastUploader || 'problem', files);
    }
  });

  // 抽屉
  el.drawerMask.onclick = closeDrawer;
  el.drawerInner.addEventListener('click', (e) => {
    const t = e.target;

    if (t.closest('[data-close-drawer]')) { closeDrawer(); return; }

    const img = t.closest('[data-full]');
    if (img) {
      const group = img.dataset.group;
      const targetRec = state.records.find((r) => r.id === state.drawerId);
      if (targetRec) {
        const ids = group === 'problem'
          ? (targetRec.problemImages || [])
          : (targetRec.solutionImages || []);
        openLightbox(ids, +img.dataset.index || 0);
      }
      return;
    }

    const copySol = t.closest('[data-copy-sol]');
    if (copySol) {
      const r = state.records.find((x) => x.id === copySol.dataset.copySol);
      if (r) copyText(r.solution, '解决方法已复制');
      return;
    }
    const copyAll = t.closest('[data-copy-all]');
    if (copyAll) {
      const r = state.records.find((x) => x.id === copyAll.dataset.copyAll);
      if (r) copyText(recordToText(r), '全文已复制');
      return;
    }
    const edit = t.closest('[data-edit]');
    if (edit) {
      closeDrawer();
      openEditor(edit.dataset.edit);
      return;
    }
    const star = t.closest('[data-toggle-star]');
    if (star) {
      const id = star.dataset.toggleStar;
      DB.toggleStar(id).then((v) => {
        const rec = state.records.find((r) => r.id === id);
        if (rec) rec.star = v;
        openDrawer(id, { count: false });
        renderLibrary();
        toast(v ? '已标为重点' : '已取消重点');
      });
      return;
    }
    const del = t.closest('[data-del]');
    if (del) {
      const id = del.dataset.del;
      const rec = state.records.find((r) => r.id === id);
      confirmDialog({
        title: '删除这条记录？',
        text: '「' + escapeHtml((rec && rec.title) || '') + '」以及相关图片会被一起删除，无法恢复。',
        okText: '删除'
      }).then(async (ok) => {
        if (!ok) return;
        await DB.deleteRecord(id);
        await reload();
        closeDrawer();
        renderLibrary();
        updateStorage();
        toast('已删除');
      });
    }
  });

  // 灯箱
  $('#lbClose').onclick = closeLightbox;
  $('#lbPrev').onclick = () => lbMove(-1);
  $('#lbNext').onclick = () => lbMove(1);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox) closeLightbox();
  });

  // 弹窗
  el.modalOk.onclick = () => closeModal(true);
  el.modalCancel.onclick = () => closeModal(false);
  el.modalMask.addEventListener('click', (e) => {
    if (e.target === el.modalMask) closeModal(false);
  });

  // 统计项点击
  el.topUsed.addEventListener('click', (e) => {
    const item = e.target.closest('.top-item');
    if (item) openDrawer(item.dataset.id);
  });

  // 设置：分类
  el.catManage.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rmcat]');
    if (!btn) return;
    const cat = btn.dataset.rmcat;
    const used = state.records.filter((r) => r.category === cat).length;
    if (used) {
      toast('该分类下还有 ' + used + ' 条记录，不能删除', 'err');
      return;
    }
    state.categories = state.categories.filter((c) => c !== cat);
    await DB.setCategories(state.categories);
    renderSettings();
    toast('已删除分类');
  });
  $('#btnAddCat').onclick = async () => {
    const v = el.newCatInput.value.trim();
    if (!v) return;
    if (state.categories.includes(v)) { toast('分类已存在', 'err'); return; }
    state.categories.push(v);
    await DB.setCategories(state.categories);
    el.newCatInput.value = '';
    renderSettings();
    toast('已添加分类');
  };
  el.newCatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#btnAddCat').click(); }
  });

  // 设置：主题
  el.themeSwitch.onchange = () => {
    applyTheme(el.themeSwitch.checked ? 'dark' : 'light');
  };
  $('#btnTheme').onclick = toggleTheme;

  // 设置：备份
  $('#btnBackupAll').onclick = exportBackup;
  $('#btnExportCsv').onclick = () => exportCSV(state.records);
  $('#btnExportTop').onclick = () => exportCSV(filteredRecords());
  $('#btnRestore').onclick = () => $('#restoreFile').click();
  $('#restoreFile').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || data.app !== 'issue-vault') throw new Error('不是本工具导出的备份');
      const ok = await confirmDialog({
        title: '恢复备份',
        text: '备份中有 <b>' + (data.records || []).length + '</b> 条记录、' +
          (data.images || []).length + ' 张图片。<br><br>' +
          '选择「确定」会与现有数据<b>合并</b>（同一条记录会被覆盖）；想先清空再恢复，请取消后手动清空数据。',
        okText: '合并恢复'
      });
      if (!ok) return;
      const res = await DB.importBackup(data, 'merge');
      await reload();
      await updateStorage();
      renderLibrary();
      toast('恢复完成：' + res.recCount + ' 条记录、' + res.imgCount + ' 张图片');
    } catch (err) {
      console.error(err);
      toast('恢复失败：' + (err.message || ''), 'err');
    }
  };

  // 清空
  $('#btnGc').onclick = async () => {
    try {
      const n = await DB.gcImages();
      await updateStorage();
      toast(n ? '已清理 ' + n + ' 张未使用的图片' : '没有需要清理的图片');
    } catch (e) {
      toast('清理失败：' + (e.message || ''), 'err');
    }
  };

  $('#btnWipe').onclick = async () => {
    const ok = await confirmDialog({
      title: '清空全部数据？',
      text: '所有记录和图片都会被永久删除，<b>无法恢复</b>。<br>强烈建议先导出完整备份。',
      okText: '确认清空'
    });
    if (!ok) return;
    const ok2 = await confirmDialog({
      title: '再确认一次',
      text: '真的要清空吗？这是最后一次确认。',
      okText: '清空'
    });
    if (!ok2) return;
    await DB.wipeAll();
    urlCache.clear();
    await reload();
    state.categories = await DB.getCategories();
    await updateStorage();
    renderLibrary();
    renderSettings();
    toast('已清空全部数据');
  };

  // 导入
  el.dropzone.onclick = () => el.importFile.click();
  $('#btnPickFile').onclick = (e) => { e.stopPropagation(); el.importFile.click(); };
  el.importFile.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleImportFile(f);
  };
  ['dragenter', 'dragover'].forEach((ev) => {
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('dragover');
    });
  });
  el.dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleImportFile(f);
  });

  el.sheetSelect.onchange = () => {
    if (!state.import) return;
    state.import.sheetName = el.sheetSelect.value;
    parseCurrentSheet();
  };
  el.hasHeader.onchange = () => parseCurrentSheet();
  el.mapGrid.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-map]');
    if (!sel) return;
    const field = sel.dataset.map;
    const val = parseInt(sel.value, 10);
    if (val < 0) delete state.import.mapping[field];
    else state.import.mapping[field] = val;
    renderPreview();
  });
  $('#btnImportCancel').onclick = () => {
    state.import = null;
    el.impStep1.hidden = false;
    el.impStep2.hidden = true;
    el.importFile.value = '';
  };
  el.btnDoImport.onclick = doImport;

  // 顶栏搜索快捷键等
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.view !== 'library') setView('library');
      el.searchInput.focus();
      el.searchInput.select();
      return;
    }
    // Ctrl+N 被浏览器占用（新窗口），改用 Alt+N
    if (e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openEditor();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      if (state.view === 'editor') {
        e.preventDefault();
        saveForm();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (el.lightbox.classList.contains('show')) { closeLightbox(); return; }
      if (el.modalMask.classList.contains('show')) { closeModal(false); return; }
      if (el.drawer.classList.contains('open')) { closeDrawer(); return; }
      if (document.activeElement === el.searchInput && el.searchInput.value) {
        el.searchClear.click();
        return;
      }
    }
    if (el.lightbox.classList.contains('show')) {
      if (e.key === 'ArrowLeft') lbMove(-1);
      if (e.key === 'ArrowRight') lbMove(1);
    }
  });

  // 离开编辑器提醒
  window.addEventListener('beforeunload', (e) => {
    if (state.view === 'editor' && (el.fTitle.value.trim() || el.fProblem.value.trim())) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------------- 初始化 ---------------- */
  let _inited = false;
  async function init() {
    if (_inited) return;
    _inited = true;

    // 主题
    let theme = 'light';
    try {
      theme = localStorage.getItem('vault-theme') || 'light';
    } catch (e) { /* ignore */ }
    applyTheme(theme);

    try {
      await DB.open();
      state.categories = await DB.getCategories();
      await reload();
      // 不在这里自动清理图片：若另一标签页正在编辑，未保存的图片会被误删
    } catch (e) {
      console.error(e);
      toast('数据库初始化失败：' + (e.message || '') + '（请勿直接双击打开 HTML）', 'err');
    }

    el.filterStatus.value = '';
    el.sortBy.value = 'updated';
    resetForm();
    renderLibrary();
    renderSettings();
    updateStorage();
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
