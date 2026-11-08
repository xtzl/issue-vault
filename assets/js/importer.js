/* ===========================================================
   问题手册 · 表格导入
   解析 xlsx / xls / csv，自动猜测列对应关系
   =========================================================== */
window.Importer = (function () {
  'use strict';

  /* 字段定义：aliases 越多，自动匹配越准 */
  const FIELDS = [
    {
      key: 'title', label: '标题', required: false,
      aliases: ['标题', '问题标题', '主题', '问题名称', '事项', '问题点', '标题描述']
    },
    {
      key: 'occurredAt', label: '发生日期', required: false,
      aliases: ['日期', '时间', '发生日期', '登记日期', '处理日期', '发生时间', '反馈时间', '日期时间', '创建时间']
    },
    {
      key: 'category', label: '分类', required: false,
      aliases: ['分类', '类型', '问题类型', '类别', '问题分类', '问题类别', '归属']
    },
    {
      key: 'customer', label: '客户 / 供应商', required: false,
      aliases: ['客户', '供应商', '门店', '客户名称', '公司', '商户', '客户/供应商', '客户名', '所属客户', '门店名称']
    },
    {
      key: 'channel', label: '来源渠道', required: false,
      aliases: ['渠道', '来源', '联系方式', '沟通方式', '反馈渠道']
    },
    {
      key: 'status', label: '处理状态', required: false,
      aliases: ['状态', '处理状态', '结果', '是否解决', '处理情况']
    },
    {
      key: 'problem', label: '问题描述', required: true,
      aliases: ['问题描述', '问题', '问题现象', '现象', '描述', '客户问题', '问题内容',
        '反馈内容', '故障描述', '客户反馈', '咨询内容', '问题详情', '具体问题', '反馈问题',
        '问题点', '异常描述', '报错信息', '客户诉求']
    },
    {
      key: 'solution', label: '解决方法', required: true,
      aliases: ['解决方法', '解决', '处理方式', '处理结果', '答复', '回复', '解决方案',
        '解决办法', '处理方案', '回复内容', '处理过程', '处理方法', '答复内容', '怎么处理',
        '如何处理', '处理办法', '应对措施', '处理措施', '解决措施', '回复话术', '话术']
    },
    {
      key: 'note', label: '备注', required: false,
      aliases: ['备注', '说明', '注意事项', '后续', '补充', '其他', '备注说明']
    },
    {
      key: 'tags', label: '标签', required: false,
      aliases: ['标签', '关键词', '关键字', '关键词标签']
    },
    {
      key: 'problemImages', label: '问题照片（链接/文件名）', required: false,
      aliases: ['问题照片', '问题图片', '图片', '照片', '截图', '附图', '图片链接', '图片地址', '截图链接']
    },
    {
      key: 'solutionImages', label: '解决照片（链接/文件名）', required: false,
      aliases: ['解决照片', '解决图片', '处理截图', '结果截图', '处理图片', '回复截图']
    }
  ];

  /* ---------- 文本解码（兼容 GBK 的 CSV） ---------- */
  function decodeText(buf) {
    const bytes = new Uint8Array(buf);
    // UTF-8 BOM
    if (bytes.length > 2 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try {
        return new TextDecoder('gbk').decode(bytes);
      } catch (e2) {
        return new TextDecoder('utf-8').decode(bytes);
      }
    }
  }

  async function readFile(file) {
    if (!window.XLSX) throw new Error('表格解析组件未加载，请刷新页面重试');
    const name = (file.name || '').toLowerCase();
    const buf = await file.arrayBuffer();

    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      const text = decodeText(buf);
      return XLSX.read(text, { type: 'string', cellDates: true, raw: false });
    }
    return XLSX.read(buf, { type: 'array', cellDates: true, raw: false });
  }

  /* ---------- 解析工作表 ---------- */
  function parseSheet(ws, hasHeader) {
    if (!ws) return { header: [], rows: [], width: 0 };
    const aoa = XLSX.utils.sheet_to_json(ws, {
      header: 1, defval: '', blankrows: false, raw: true
    });

    if (!aoa.length) return { header: [], rows: [], width: 0 };

    // 找出实际最大列数
    let width = 0;
    aoa.forEach((r) => { if (r.length > width) width = r.length; });

    // 去掉全空的行（有些表格末尾有格式化的空行）
    const cleaned = aoa.filter((row) => {
      return row.some((cell) => String(cell == null ? '' : cell).trim() !== '');
    });

    let header, rows;
    if (hasHeader) {
      const rawHeader = cleaned[0] || [];
      header = [];
      for (let i = 0; i < width; i++) {
        const v = String(rawHeader[i] == null ? '' : rawHeader[i]).trim();
        header.push(v || ('第 ' + (i + 1) + ' 列'));
      }
      rows = cleaned.slice(1);
    } else {
      header = [];
      for (let i = 0; i < width; i++) header.push('第 ' + (i + 1) + ' 列');
      rows = cleaned;
    }

    // 补齐每行宽度
    rows = rows.map((r) => {
      const out = r.slice(0, width);
      while (out.length < width) out.push('');
      return out;
    });

    return { header, rows, width };
  }

  /* ---------- 表头自动匹配 ---------- */
  const norm = (s) => String(s == null ? '' : s)
    .replace(/[\s\u3000（）()【】\[\]：:、,，.。\/\\\-_*#]/g, '')
    .toLowerCase();

  function autoMap(header) {
    const map = {};        // fieldKey -> columnIndex
    const used = new Set(); // 已占用的列

    const candidates = [];
    FIELDS.forEach((f) => {
      header.forEach((h, idx) => {
        const nh = norm(h);
        if (!nh) return;
        let score = 0;
        f.aliases.forEach((alias) => {
          const na = norm(alias);
          if (!na) return;
          if (nh === na) score = Math.max(score, 100 + na.length);
          else if (nh.includes(na)) score = Math.max(score, 60 + na.length);
          else if (na.includes(nh) && nh.length >= 2) score = Math.max(score, 30 + nh.length);
        });
        if (score > 0) candidates.push({ field: f.key, idx, score });
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    candidates.forEach((c) => {
      if (map[c.field] !== undefined) return;
      if (used.has(c.idx)) return;
      map[c.field] = c.idx;
      used.add(c.idx);
    });
    return map;
  }

  /* ---------- 日期解析 ---------- */
  const pad = (n) => String(n).padStart(2, '0');

  function parseDate(v) {
    if (v === '' || v == null) return '';
    if (v instanceof Date && !isNaN(v)) {
      return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      // Excel 序列号（1900 基准）
      try {
        const d = XLSX.SSF.parse_date_code(v);
        if (d && d.y) return d.y + '-' + pad(d.m) + '-' + pad(d.d);
      } catch (e) { /* ignore */ }
    }
    const s = String(v).trim();
    if (!s) return '';

    let m = s.match(/(\d{4})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return y + '-' + pad(mo) + '-' + pad(d);
    }
    m = s.match(/^(\d{1,2})\s*[\/\-]\s*(\d{1,2})\s*[\/\-]\s*(\d{4})$/);
    if (m) {
      // 优先按 月/日/年 解析；若第一段 > 12 则按 日/月/年
      let mo = +m[1], d = +m[2];
      if (mo > 12 && d <= 12) { const t = mo; mo = d; d = t; }
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return m[3] + '-' + pad(mo) + '-' + pad(d);
      }
    }
    // 无年份：「3月5日」
    m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
    if (m) {
      return new Date().getFullYear() + '-' + pad(+m[1]) + '-' + pad(+m[2]);
    }
    return '';
  }

  /* ---------- 文本清理 ---------- */
  function cellText(v) {
    if (v == null) return '';
    if (v instanceof Date) return parseDate(v);
    if (typeof v === 'number') {
      // 避免 12.0 这种
      return Number.isInteger(v) ? String(v) : String(v);
    }
    return String(v).replace(/\r\n/g, '\n').trim();
  }

  function splitTags(v) {
    if (!v) return [];
    return String(v)
      .split(/[,，、;；\/|\s]+/)
      .map((t) => t.trim())
      .filter((t) => t && t.length <= 20)
      .slice(0, 12);
  }

  const STATUS_SET = ['已解决', '跟进中', '未解决'];
  function normalizeStatus(v, solution) {
    const s = cellText(v);
    if (STATUS_SET.includes(s)) return s;
    if (/未解决|待处理|处理中|跟进|pending|open/i.test(s)) {
      return /未解决|待处理/.test(s) ? '未解决' : '跟进中';
    }
    if (/已解决|完成|解决|done|closed|ok/i.test(s)) return '已解决';
    return solution ? '已解决' : '跟进中';
  }

  /**
   * 生成待导入记录
   * @returns {{records:Array, skipped:number, total:number}}
   */
  function buildRecords(rows, mapping, opts) {
    const o = Object.assign({ mergeTitle: true, skipDuplicate: true }, opts || {});
    const val = (row, key) => {
      const idx = mapping[key];
      if (idx === undefined || idx === null || idx < 0) return '';
      return row[idx];
    };

    const records = [];
    const seen = new Set();
    let skipped = 0;

    rows.forEach((row) => {
      const problem = cellText(val(row, 'problem'));
      const solution = cellText(val(row, 'solution'));
      let title = cellText(val(row, 'title'));
      const customer = cellText(val(row, 'customer'));
      const category = cellText(val(row, 'category'));
      const channel = cellText(val(row, 'channel'));
      const note = cellText(val(row, 'note'));
      const occurredRaw = val(row, 'occurredAt');
      const statusRaw = val(row, 'status');
      const tags = splitTags(cellText(val(row, 'tags')));
      const pImg = cellText(val(row, 'problemImages'));
      const sImg = cellText(val(row, 'solutionImages'));

      // 整行空 → 跳过
      if (!problem && !solution && !title && !customer) { skipped++; return; }

      if (!title && o.mergeTitle) {
        const base = problem || solution || customer;
        title = base.replace(/\s+/g, ' ').slice(0, 30);
        if (base.length > 30) title += '…';
      }
      if (!title) title = '未命名记录';

      // 原表里的图片列：保留为文字线索
      let extra = '';
      if (pImg) extra += '\n\n[原表·问题照片] ' + pImg;
      if (sImg) extra += '\n\n[原表·解决照片] ' + sImg;

      const dedupKey = (title + '|' + problem).toLowerCase();
      if (o.skipDuplicate && seen.has(dedupKey)) { skipped++; return; }
      seen.add(dedupKey);

      records.push({
        title: title.slice(0, 80),
        occurredAt: parseDate(occurredRaw) || new Date().toISOString().slice(0, 10),
        category: category || '其他',
        customer,
        channel: channel || '',
        status: normalizeStatus(statusRaw, solution),
        problem: problem + extra,
        solution: solution,
        note,
        tags,
        problemImages: [],
        solutionImages: [],
        star: false,
        useCount: 0,
        source: 'import'
      });
    });

    return { records, skipped, total: rows.length };
  }

  return {
    FIELDS, readFile, parseSheet, autoMap,
    buildRecords, parseDate, cellText,
    __norm: norm
  };
})();
