/**
 * CDE Mentor Navigator - Phase 1
 * Shared app for EE / CS (configure via window.DEPT_CONFIG)
 */

// ======== CONFIGURATION ========
const DEPT = window.DEPT_CONFIG || {};
const CONFIG = {
  dataUrl: DEPT.dataUrl || 'data/professors.json',
  deptShort: DEPT.deptShort || 'EE',
  deptTitle: DEPT.deptTitle || 'CityU EE 导师筛选器',
  STORAGE_KEYS: {
    // EE 保持旧 key，避免已有「我的清单」丢失；CS 等用 storagePrefix
    statusMap: DEPT.storagePrefix ? `${DEPT.storagePrefix}_status_map` : 'cde_mentor_status_map',
    searchHistory: DEPT.storagePrefix ? `${DEPT.storagePrefix}_search_history` : 'cde_mentor_search_history',
    weights: DEPT.storagePrefix ? `${DEPT.storagePrefix}_weights` : 'cde_mentor_weights',
    errorReports: DEPT.storagePrefix ? `${DEPT.storagePrefix}_error_reports` : 'cde_mentor_error_reports'
  },
  MAX_COMPARE: 3,
  PRESET_KEYWORDS: DEPT.presetKeywords || ['AI', '机器人', '芯片', '天线', '电力电子', '无线通信', '密码学', '脑机接口', '图像处理'],
  TIER_LABEL: {
    stable: '稳健经典型 —— 方向多年一致,没有明显转向',
    evolve: '稳中拓新型 —— 主体方向不变,正向新应用延伸',
    pivot: '快速转向型 —— 近年明显往新热点靠拢'
  },
  TIER_SHORT: {
    stable: '稳健经典',
    evolve: '稳中拓新',
    pivot: '快速转向'
  },
  TIER_SCORE: { stable: 25, evolve: 55, pivot: 85 },
  TIER_GAUGE_X: { stable: 15, evolve: 48, pivot: 82 },
  STATUS_OPTIONS: [
    { key: 'none', label: '未标记' },
    { key: 'contacted', label: '已联系' },
    { key: 'interested', label: '感兴趣' },
    { key: 'dropped', label: '放弃' }
  ],
  LOG_FLOOR: Math.log10(500),
  LOG_CEIL: Math.log10(40000)
};

// ======== STATE ========
let PROFESSORS = [];
let THEMES = [];
let THEME_CONTINENTS = [];
let GLOSSARY = {};
let METADATA = {};

let statusMap = {};
let searchHistory = [];
let weights = { match: 50, trend: 30, impact: 20 };
const compareSet = new Set();
let expandedThemeId = null;
/** 结果区分类 Tab：all | stable | evolve | pivot */
let tierTab = 'all';
/** 卡片完整画像：id -> { open, tab, industrySub }
 *  tab = contact|declared|narrative|papers|industry
 *  industrySub = labs|industry|links
 */
const portraitState = {};

// ======== UTILITY FUNCTIONS ========
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function parseTags(raw) {
  if (!raw) return [];
  return raw.toLowerCase()
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function tierColor(score) {
  // 低分=稳健(青绿) → 高分=快速转向(琥珀)
  const teal = [94, 234, 212];
  const amber = [244, 163, 64];
  const t = Math.max(0, Math.min(100, score)) / 100;
  const r = Math.round(teal[0] + (amber[0] - teal[0]) * t);
  const g = Math.round(teal[1] + (amber[1] - teal[1]) * t);
  const b = Math.round(teal[2] + (amber[2] - teal[2]) * t);
  return `rgb(${r},${g},${b})`;
}

function getInitials(name) {
  return name.split(',')[0].trim().slice(0, 2).toUpperCase();
}

function getShortName(name) {
  return name.split(',')[0].trim();
}

function lookupGlossary(term) {
  if (!term) return null;
  if (GLOSSARY[term]) return GLOSSARY[term];
  const lower = String(term).toLowerCase();
  for (const [k, v] of Object.entries(GLOSSARY)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/** 词典正文常带「Term：…」前缀；展示时标题已加粗，去掉重复前缀 */
function glossaryBodyText(term, def) {
  if (!def) return '';
  let body = String(def).trim();
  if (!term) return body;
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  body = body.replace(new RegExp(`^${escaped}\\s*[:：]\\s*`, 'i'), '');
  return body;
}

/** 旧占位文案：看起来像解释，其实没说词义 */
function isGlossaryStub(def) {
  if (!def) return true;
  const s = String(def);
  return (
    s.includes('该方向常用术语') ||
    s.includes('批量占位') ||
    s.includes('更白话的解释会在后续') ||
    s.includes('可结合该老师近期论文') ||
    /^（暂无白话解释）/.test(s)
  );
}

function getIndustryProfile(prof) {
  const ip = prof.industryProfile || {};
  return {
    collaboratingLabs: Array.isArray(ip.collaboratingLabs) ? ip.collaboratingLabs : [],
    industryLinks: Array.isArray(ip.industryLinks) ? ip.industryLinks : [],
    linkedinUrl: ip.linkedinUrl || null,
    internshipHint: ip.internshipHint || 'unknown',
    verifiedAt: ip.verifiedAt || null,
    quality: ip.quality || (ip.collaboratingLabs?.length || ip.industryLinks?.length || ip.linkedinUrl ? 'curated' : 'empty')
  };
}

function getRecruiting(prof) {
  const r = prof.recruiting || {};
  return {
    status: r.status || 'unknown', // open | closed | unknown
    note: r.note || '',
    sourceUrl: r.sourceUrl || null,
    textFragment: r.textFragment || null,
    urlFragment: r.urlFragment || null,
    updatedAt: r.updatedAt || null
  };
}

function isUsableHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  // 目录页 / 空 persons 列表不算有效个人链接
  if (/scholars\.cityu\.edu\.hk\/en\/persons\/?$/i.test(u)) return false;
  if (/scholars\.cityu\.edu\.hk\/en\/persons\/?\?/i.test(u)) return false;
  return true;
}

function buildRecruitingBanner(prof) {
  const r = getRecruiting(prof);
  // 仅当老师公开页写了招生线索、且我们有可点来源时才展示；unknown / 无链接一律不写
  if (r.status !== 'open' && r.status !== 'closed') return '';
  if (!isUsableHttpUrl(r.sourceUrl)) return '';

  const labelMap = {
    open: '公开信息显示可能在招',
    closed: '公开信息未显示在招'
  };
  const cls = `recruiting-banner status-${r.status}`;
  const note = r.note ? `<div class="recruiting-note">${escapeHtml(r.note)}</div>` : '';
  const href = resolveExternalUrl({
    url: r.sourceUrl,
    textFragment: r.textFragment,
    urlFragment: r.urlFragment
  });
  const link = `<a class="industry-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">看来源</a>`;
  const when = r.updatedAt ? `<span class="recruiting-when">核验 ${escapeHtml(r.updatedAt)}</span>` : '';
  return `<div class="${cls}">
    <div class="recruiting-title">${labelMap[r.status]}</div>
    ${note}
    <div class="recruiting-meta">${when} ${link}</div>
  </div>`;
}

function buildContactPanel(prof) {
  const ip = getIndustryProfile(prof);
  const items = [];
  if (prof.email) {
    items.push({
      label: 'Email',
      value: prof.email,
      href: `mailto:${prof.email}`,
      openLabel: '发邮件'
    });
  }
  if (isUsableHttpUrl(prof.personalUrl)) {
    items.push({ label: '个人主页', value: prof.personalUrl, href: prof.personalUrl, openLabel: '打开' });
  }
  if (isUsableHttpUrl(prof.scholarsUrl)) {
    items.push({ label: 'CityUHK Scholars', value: prof.scholarsUrl, href: prof.scholarsUrl, openLabel: '打开' });
  }
  if (isUsableHttpUrl(prof.scholarUrl)) {
    items.push({ label: 'Google Scholar', value: prof.scholarUrl, href: prof.scholarUrl, openLabel: '打开' });
  }
  if (ip.linkedinUrl) {
    items.push({ label: 'LinkedIn', value: ip.linkedinUrl, href: ip.linkedinUrl, openLabel: '打开' });
  }
  if (prof.labUrl) {
    items.push({
      label: prof.labLabel || '实验室主页',
      value: prof.labUrl,
      href: prof.labUrl,
      openLabel: '打开'
    });
  }

  const latinName = prof.name.replace(/[一-鿿].*$/, '').trim();
  const recruiting = buildRecruitingBanner(prof);
  if (!items.length) {
    return `${recruiting}
      <p class="industry-empty">暂无联系方式。</p>
      <p class="industry-empty">可去 Scholar 搜索「${escapeHtml(latinName)} City University of Hong Kong」。</p>`;
  }

  const cards = items.map(item => `
    <li class="contact-card">
      <div class="contact-card-label">${escapeHtml(item.label)}</div>
      <div class="contact-card-value">${escapeHtml(item.value)}</div>
      <div class="contact-card-actions">
        <a class="contact-open-btn" href="${escapeHtml(item.href)}" ${item.href.startsWith('mailto:') ? '' : 'target="_blank" rel="noopener"'}>${escapeHtml(item.openLabel)}</a>
        <button class="copy-btn contact-copy-btn" data-copy-value="${escapeHtml(item.value)}" type="button">复制</button>
      </div>
    </li>
  `).join('');

  return `
    ${recruiting}
    <ul class="contact-cards">${cards}</ul>
    <p class="contact-fallback">打不开链接时：去 Scholar 搜索「${escapeHtml(latinName)} City University of Hong Kong」</p>`;
}

function buildIndustryPanel(prof, industrySub) {
  const ip = getIndustryProfile(prof);
  // 外链已并入「联系方式」，不再保留第三子 Tab
  let sub = industrySub || 'labs';
  if (sub === 'links') sub = 'labs';
  const subs = [
    { key: 'labs', label: '合作 Lab' },
    { key: 'industry', label: '产业线索' }
  ];
  const subBtns = subs.map(s =>
    `<button type="button" class="industry-subtab ${sub === s.key ? 'active' : ''}" data-industry-sub="${s.key}" data-id="${prof.id}">${s.label}</button>`
  ).join('');

  let body = '';
  if (sub === 'industry') {
    if (!ip.industryLinks.length) {
      body = `<p class="industry-empty">暂无公开可见的产业线索（公司 / 联合项目 / 顾问岗 / 毕业生去向）。${ip.quality === 'empty' ? '（多数老师仍待人工补录）' : ''}</p>`;
    } else {
      body = `<ul class="industry-list">${ip.industryLinks.map(item => {
        const org = escapeHtml(item.org || '未命名机构');
        const rel = item.relation ? `<span class="industry-kind">${escapeHtml(item.relation)}</span>` : '';
        const note = item.note ? `<div class="industry-note">${escapeHtml(item.note)}</div>` : '';
        const href = resolveExternalUrl(item);
        const link = href
          ? `<a class="industry-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">打开链接</a>`
          : '';
        const src = item.source ? `<span class="industry-src">来源：${escapeHtml(item.source)}</span>` : '';
        return `<li><div class="industry-title">${org} ${rel}</div>${note}<div class="industry-meta">${src} ${link}</div></li>`;
      }).join('')}</ul>`;
    }
  } else if (!ip.collaboratingLabs.length) {
    body = `<p class="industry-empty">暂无公开记录的合作 Lab / 联合实验室。${ip.quality === 'empty' ? '（多数老师仍待人工补录；精修试点已开始填）' : ''}</p>`;
  } else {
    body = `<ul class="industry-list">${ip.collaboratingLabs.map(item => {
      const name = escapeHtml(item.name || '未命名');
      const kind = item.kind ? `<span class="industry-kind">${escapeHtml(item.kind)}</span>` : '';
      const note = item.note ? `<div class="industry-note">${escapeHtml(item.note)}</div>` : '';
      const href = resolveExternalUrl(item);
      const link = href
        ? `<a class="industry-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">打开链接</a>`
        : '';
      const src = item.source ? `<span class="industry-src">来源：${escapeHtml(item.source)}</span>` : '';
      return `<li><div class="industry-title">${name} ${kind}</div>${note}<div class="industry-meta">${src} ${link}</div></li>`;
    }).join('')}</ul>`;
  }

  return `
    <div class="industry-panel">
      <p class="industry-disclaimer">公开信息显示可能存在产业接口</p>
      <div class="industry-subtabs industry-subtabs-2" role="tablist">${subBtns}</div>
      <div class="industry-subbody">${body}</div>
      ${ip.verifiedAt ? `<p class="industry-verified">核验：${escapeHtml(ip.verifiedAt)} · ${escapeHtml(ip.quality)}</p>` : ''}
    </div>`;
}

/** 尽量跳到外链相关段落：优先自定义 fragment；否则用 Chromium 文本片段 #:~:text= */
function resolveExternalUrl(item) {
  if (!item || !item.url) return '';
  const base = String(item.url).split('#')[0];
  if (item.urlFragment) {
    const frag = String(item.urlFragment).replace(/^#/, '');
    return `${base}#${frag}`;
  }
  if (item.textFragment) {
    // https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments
    const t = encodeURIComponent(String(item.textFragment)).replace(/-/g, '%2D');
    return `${base}#:~:text=${t}`;
  }
  if (item.url.includes('#')) return item.url;
  return item.url;
}

function nameMatches(prof, nameQuery) {
  if (!nameQuery) return true;
  const q = nameQuery.trim().toLowerCase();
  if (!q) return true;
  const full = (prof.name || '').toLowerCase();
  const short = getShortName(prof.name || '').toLowerCase();
  const compact = full.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const qCompact = q.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  return full.includes(q) || short.includes(q) || (qCompact && compact.includes(qCompact));
}

// ======== LOCAL STORAGE ========
function storageGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Storage get failed:', e);
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Storage set failed:', e);
  }
}

// ======== DATA LOADING ========
async function loadData() {
  try {
    // 避免浏览器缓存旧 JSON，导致合作试点数据「看不见」
    const url = `${CONFIG.dataUrl}${CONFIG.dataUrl.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    PROFESSORS = data.professors || [];
    THEMES = data.themes || [];
    THEME_CONTINENTS = data.themeContinents || [];
    GLOSSARY = data.glossary || {};
    METADATA = data.metadata || {};

    return true;
  } catch (error) {
    console.error('Failed to load data:', error);
    showError('数据加载失败。请用本地服务器打开（python3 -m http.server），不要直接双击 HTML。');
    return false;
  }
}

function showError(message) {
  const grid = document.getElementById('cardGrid');
  if (grid) {
    grid.innerHTML = `<div class="empty-state">⚠ ${escapeHtml(message)}</div>`;
  }
}

// ======== SCORING ========
function computeScores(prof, userTags, w) {
  let matchScore;
  if (userTags.length === 0) {
    matchScore = 100;
  } else {
    const pool = (prof.matchTags || []).map(t => t.toLowerCase());
    const namePool = (prof.name || '').toLowerCase();
    let hits = 0;
    userTags.forEach(ut => {
      const hit =
        namePool.includes(ut) ||
        pool.some(pt => pt.includes(ut) || ut.includes(pt));
      if (hit) hits++;
    });
    matchScore = Math.round((hits / userTags.length) * 100);
  }

  const trendScore = CONFIG.TIER_SCORE[prof.tier];

  const logVal = Math.log10(prof.scopusCitations + 1);
  const impactScore = Math.round(
    Math.max(0, Math.min(100, ((logVal - CONFIG.LOG_FLOOR) / (CONFIG.LOG_CEIL - CONFIG.LOG_FLOOR)) * 100))
  );

  const totalW = (w.match + w.trend + w.impact) || 1;
  const composite = Math.round(
    (w.match * matchScore + w.trend * trendScore + w.impact * impactScore) / totalW
  );

  return { matchScore, trendScore, impactScore, composite };
}

// ======== RENDER: BUBBLES ========
/** 横版「学科大陆」画布：相近方向同区，整图等比缩放 */
const BUBBLE_MAP_W = 1100;

function bubbleMapSize(count) {
  if (!count) return 58;
  return Math.round(60 + Math.sqrt(count) * 28);
}

function bubbleLayoutRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), s | 1) + Math.imul(s ^ (s >>> 7), s | 61)) >>> 0;
    return s / 4294967296;
  };
}

/** 大陆在画布上的相对中心（横版地图坐标 0–1）——仅作回退参考 */
function continentAnchorLayout(n) {
  const presets = [
    [0.18, 0.28], [0.52, 0.26], [0.84, 0.30],
    [0.28, 0.70], [0.62, 0.72], [0.88, 0.68]
  ];
  if (n <= presets.length) return presets.slice(0, n);
  const out = presets.slice();
  for (let i = presets.length; i < n; i++) {
    out.push([(i % 3 + 0.5) / 3, 0.35 + Math.floor(i / 3) * 0.32]);
  }
  return out.slice(0, n);
}

function packClusterNodes(nodes, centerX, centerY, rng) {
  if (!nodes.length) return;
  // 大泡在中心（主干），小泡在外圈（分支）；间距按直径严格不重叠
  nodes.sort((a, b) => b.size - a.size);
  const gap = 16;

  nodes.forEach((node, i) => {
    if (i === 0) {
      node.cx = centerX;
      node.cy = centerY;
      return;
    }
    const prev = nodes[0];
    const baseR = (prev.size + node.size) / 2 + gap + (i - 1) * 10;
    const angle = (i / nodes.length) * Math.PI * 2 + rng() * 0.35 + i * 0.5;
    node.cx = centerX + Math.cos(angle) * baseR;
    node.cy = centerY + Math.sin(angle) * baseR * 0.78;
  });

  for (let iter = 0; iter < 80; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.cx - b.cx;
        let dy = a.cy - b.cy;
        let dist = Math.hypot(dx, dy);
        const minDist = (a.size + b.size) / 2 + gap;
        if (dist < 0.01) {
          dx = rng() - 0.5;
          dy = rng() - 0.5;
          dist = 0.01;
        }
        if (dist < minDist) {
          const push = (minDist - dist) * 0.62;
          const ux = dx / dist;
          const uy = dy / dist;
          const total = a.size + b.size;
          const wa = b.size / total;
          const wb = a.size / total;
          a.cx += ux * push * wa;
          a.cy += uy * push * wa;
          b.cx -= ux * push * wb;
          b.cy -= uy * push * wb;
        }
      }
    }
  }

  nodes.forEach((node, i) => {
    node.z = 2 + i;
  });
}

/**
 * 在原点打包一簇，返回平移前的节点与包围盒尺寸。
 */
function measurePackedCluster(nodes, rng) {
  const packed = nodes.map(n => ({ ...n }));
  packClusterNodes(packed, 0, 0, rng);
  const minX = Math.min(...packed.map(n => n.cx - n.size / 2));
  const maxX = Math.max(...packed.map(n => n.cx + n.size / 2));
  const minY = Math.min(...packed.map(n => n.cy - n.size / 2));
  const maxY = Math.max(...packed.map(n => n.cy + n.size / 2));
  return {
    nodes: packed,
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * 学科大陆布局：每块大陆独占互不重叠的槽位，泡不跨界、名字不挡泡。
 * 返回 { positions, continents, width, height }
 */
function layoutBubbleContinentMap(items) {
  const W = BUBBLE_MAP_W;
  const pad = 16;
  const GAP = 36;
  const LABEL_BAND = 56;
  const HALO_PAD = 28;
  const byId = Object.fromEntries(items.map(it => [it.theme.id, it]));
  const rng = bubbleLayoutRng(20260717 + items.length * 13);

  let continents = Array.isArray(THEME_CONTINENTS) ? THEME_CONTINENTS.slice() : [];
  continents = continents
    .map(c => ({
      ...c,
      themeIds: (c.themeIds || []).filter(id => byId[id])
    }))
    .filter(c => c.themeIds.length);

  const covered = new Set(continents.flatMap(c => c.themeIds));
  const orphans = items.filter(it => !covered.has(it.theme.id));
  if (orphans.length) {
    continents.push({
      id: 'other',
      nameZh: '其他方向',
      nameEn: 'Other',
      blurb: '尚未归入主干族的方向',
      themeIds: orphans.map(o => o.theme.id)
    });
  }

  if (!continents.length) {
    const positions = [];
    let x = pad;
    let y = pad;
    let rowH = 0;
    items.forEach(it => {
      if (x + it.size > W - pad) {
        x = pad;
        y += rowH + 14;
        rowH = 0;
      }
      positions.push({ ...it, left: x, top: y, continentId: null });
      x += it.size + 12;
      rowH = Math.max(rowH, it.size);
    });
    return {
      positions,
      continents: [],
      width: W,
      height: Math.ceil(y + rowH + pad)
    };
  }

  // 1) 各大陆本地打包，量尺寸
  const clusters = continents.map(c => {
    const seed = c.themeIds.map(id => ({ ...byId[id], continentId: c.id }));
    const measured = measurePackedCluster(seed, rng);
    return { continent: c, ...measured };
  });

  // 2) First-fit decreasing：尽量填满每行，避免上排只剩两块大空白
  const usableW = W - pad * 2;
  const ordered = clusters
    .map((cluster, index) => ({
      ...cluster,
      index,
      slotW: cluster.width + HALO_PAD * 2,
      // 标签放底部：上方泡区 + 底部名字带
      slotH: cluster.height + LABEL_BAND + HALO_PAD + 16
    }))
    .sort((a, b) => b.slotW - a.slotW);

  const rows = [];
  ordered.forEach(cluster => {
    let placed = false;
    for (const row of rows) {
      const used = row.reduce((s, c) => s + c.slotW, 0) + GAP * row.length;
      if (used + cluster.slotW <= usableW + 0.5) {
        row.push(cluster);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([cluster]);
  });

  // 恢复原始大陆顺序观感：同行内按数据顺序排
  rows.forEach(row => row.sort((a, b) => a.index - b.index));

  const allNodes = [];
  const continentMeta = [];
  let cursorY = pad;

  rows.forEach(row => {
    const rowH = Math.max(...row.map(c => c.slotH));
    const rowContentW = row.reduce((s, c) => s + c.slotW, 0) + GAP * Math.max(0, row.length - 1);
    let cursorX = pad + Math.max(0, (usableW - rowContentW) / 2);

    row.forEach(cluster => {
      const slotW = cluster.slotW;
      const slotH = rowH;
      const slotLeft = cursorX;
      const slotTop = cursorY;

      // 泡只放在框的上半；底部 LABEL_BAND 专留给大陆名
      const contentOriginX = slotLeft + HALO_PAD - cluster.minX;
      const contentOriginY = slotTop + HALO_PAD + 8 - cluster.minY;

      cluster.nodes.forEach(node => {
        node.cx += contentOriginX;
        node.cy += contentOriginY;
        allNodes.push(node);
      });

      const innerLeft = slotLeft + HALO_PAD;
      const innerRight = slotLeft + slotW - HALO_PAD;
      const innerTop = slotTop + HALO_PAD + 6;
      const innerBottom = slotTop + slotH - LABEL_BAND - 8;
      const slotNodes = cluster.nodes;

      for (let iter = 0; iter < 36; iter++) {
        for (let i = 0; i < slotNodes.length; i++) {
          for (let j = i + 1; j < slotNodes.length; j++) {
            const a = slotNodes[i];
            const b = slotNodes[j];
            let dx = a.cx - b.cx;
            let dy = a.cy - b.cy;
            let dist = Math.hypot(dx, dy) || 0.01;
            const minDist = (a.size + b.size) / 2 + 14;
            if (dist < minDist) {
              const push = (minDist - dist) * 0.5;
              a.cx += (dx / dist) * push * 0.5;
              a.cy += (dy / dist) * push * 0.5;
              b.cx -= (dx / dist) * push * 0.5;
              b.cy -= (dy / dist) * push * 0.5;
            }
          }
        }
        slotNodes.forEach(node => {
          const r = node.size / 2;
          node.cx = Math.min(innerRight - r, Math.max(innerLeft + r, node.cx));
          node.cy = Math.min(innerBottom - r, Math.max(innerTop + r, node.cy));
        });
      }

      const maxY = Math.max(...slotNodes.map(n => n.cy + n.size / 2));
      const haloLeft = slotLeft;
      const haloTop = slotTop;
      const haloRight = slotLeft + slotW;
      const haloBottom = Math.max(slotTop + slotH, maxY + LABEL_BAND + 12);

      continentMeta.push({
        id: cluster.continent.id,
        nameZh: cluster.continent.nameZh || cluster.continent.nameEn || cluster.continent.id,
        blurb: cluster.continent.blurb || '',
        left: haloLeft,
        top: haloTop,
        width: haloRight - haloLeft,
        height: haloBottom - haloTop,
        labelX: (haloLeft + haloRight) / 2,
        // 名字贴在本大陆框底部，不会被上方大陆的泡挡住
        labelY: haloBottom - LABEL_BAND / 2
      });

      cursorX += slotW + GAP;
    });

    cursorY += rowH + GAP;
  });

  const positions = allNodes.map(node => ({
    ...node,
    left: node.cx - node.size / 2,
    top: node.cy - node.size / 2
  }));

  const maxBottom = Math.max(
    ...positions.map(p => p.top + p.size),
    ...continentMeta.map(c => c.top + c.height),
    cursorY,
    280
  );
  const maxRight = Math.max(
    ...positions.map(p => p.left + p.size),
    ...continentMeta.map(c => c.left + c.width),
    W * 0.85
  );

  return {
    positions,
    continents: continentMeta,
    width: Math.ceil(Math.max(W, maxRight + pad)),
    height: Math.ceil(maxBottom + pad)
  };
}

function scaleBubbleField() {
  const viewport = document.getElementById('bubbleFieldViewport');
  const field = document.getElementById('bubbleField');
  if (!viewport || !field || !field.children.length) return;

  const mapW = Number(field.dataset.mapW) || BUBBLE_MAP_W;
  const mapH = Number(field.dataset.mapH) || 540;

  field.style.zoom = '';
  field.style.width = `${mapW}px`;
  field.style.height = `${mapH}px`;
  field.style.transformOrigin = 'top center';

  const available = viewport.getBoundingClientRect().width || viewport.clientWidth || mapW;
  if (available < 32) return;
  const scale = Math.min(1, available / mapW);

  field.style.transform = `scale(${scale})`;
  viewport.style.overflow = 'hidden';
  viewport.style.height = `${Math.ceil(mapH * scale) + 2}px`;
}

function renderBubbles() {
  const field = document.getElementById('bubbleField');
  if (!field) return;

  const items = THEMES.map(theme => {
    const count = theme.profIds.length;
    const size = bubbleMapSize(count);
    let avgTier = 25;
    if (count > 0) {
      avgTier = theme.profIds.reduce((sum, id) => {
        const prof = PROFESSORS.find(p => p.id === id);
        return sum + (prof ? CONFIG.TIER_SCORE[prof.tier] : 25);
      }, 0) / count;
    }
    return {
      theme,
      count,
      size,
      color: count ? tierColor(avgTier) : null,
      isExpanded: expandedThemeId === theme.id
    };
  });

  const map = layoutBubbleContinentMap(items);
  field.dataset.mapW = String(map.width);
  field.dataset.mapH = String(map.height);

  const continentHtml = (map.continents || []).map(c => `
    <div class="continent-halo" style="left:${c.left}px;top:${c.top}px;width:${c.width}px;height:${c.height}px;" aria-hidden="true"></div>
    <div class="continent-label" style="left:${c.labelX}px;top:${c.labelY}px;" title="${escapeHtml(c.blurb || c.nameZh)}">${escapeHtml(c.nameZh)}</div>
  `).join('');

  const bubbleHtml = map.positions.map(p => {
    const t = p.theme;
    if (p.count === 0) {
      return `<div class="bubble ghost" style="width:${p.size}px;height:${p.size}px;left:${p.left}px;top:${p.top}px;" title="这个方向暂时没有已录入的老师">
        <div class="bname-en">${escapeHtml(t.nameEn)}</div>
        <div class="bcount">0</div>
      </div>`;
    }
    return `<button class="bubble ${p.isExpanded ? 'expanded' : ''}" type="button" data-theme-id="${t.id}"
        style="width:${p.size}px;height:${p.size}px;left:${p.left}px;top:${p.top}px;background:${p.color};z-index:${p.z || 2};"
        aria-label="${escapeHtml(t.nameEn)} ${escapeHtml(t.nameZh)}，点击查看老师名单">
      <div class="bname-en">${escapeHtml(t.nameEn)}</div>
      <div class="bname-zh">${escapeHtml(t.nameZh)}</div>
      <div class="bcount">${p.count} 位</div>
    </button>`;
  }).join('');

  field.innerHTML = continentHtml + bubbleHtml;
  scaleBubbleField();
  requestAnimationFrame(() => scaleBubbleField());
  renderThemeExpand();
}

function renderThemeExpand() {
  const el = document.getElementById('themeExpand');
  if (!el) return;

  if (!expandedThemeId) {
    el.innerHTML = '';
    return;
  }

  const theme = THEMES.find(t => t.id === expandedThemeId);
  if (!theme || theme.profIds.length === 0) {
    el.innerHTML = '';
    return;
  }

  const chips = theme.profIds.map(id => {
    const prof = PROFESSORS.find(p => p.id === id);
    if (!prof) return '';
    return `<button class="name-chip" data-target="card-${id}" type="button">${escapeHtml(getShortName(prof.name))} →</button>`;
  }).join('');

  el.innerHTML = `<div class="theme-expand-inner">
    <h5>${escapeHtml(theme.nameZh)}(${theme.profIds.length}位)· 点名字跳到对应卡片</h5>
    <div class="chips">${chips}</div>
  </div>`;
}

// ======== RENDER: CARD ========
function renderCard(prof, scores, userTags) {
  const initials = getInitials(prof.name);
  const status = statusMap[prof.id] || 'none';
  const compareChecked = compareSet.has(prof.id);
  const compareDisabled = !compareChecked && compareSet.size >= CONFIG.MAX_COMPARE;

  // Status badge
  const statusBadge = status !== 'none'
    ? `<div class="status-flag status-${status}">${CONFIG.STATUS_OPTIONS.find(o => o.key === status)?.label || ''}</div>`
    : '';

  // Status options
  const statusOptionsHtml = CONFIG.STATUS_OPTIONS.map(o =>
    `<option value="${o.key}" ${o.key === status ? 'selected' : ''}>${o.label}</option>`
  ).join('');

  // Tags（扑克牌卡片上只展示前几个，完整信息在展开区）
  const classicChips = (prof.classicTags || []).slice(0, 4).map(t =>
    `<button class="chip classic" data-term="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`
  ).join('');

  const emergingChips = (prof.emergingTags || []).slice(0, 4).map(t =>
    `<button class="chip emerging" data-term="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`
  ).join('');

  const declared = (prof.selfDeclared || []).map(t => `<li>${escapeHtml(t)}</li>`).join('');
  const recent = (prof.recentPapers || []).map(t => `<li>${t}</li>`).join('');
  const oneLiner = prof.oneLiner
    ? `<p class="one-liner">${escapeHtml(prof.oneLiner)}</p>`
    : '';

  const matchNote = userTags.length ? `<span title="关键词匹配度">匹配 ${scores.matchScore}</span>` : '';

  const tierBadge = `<div class="tier-badge tier-${prof.tier}" title="${escapeHtml(CONFIG.TIER_LABEL[prof.tier] || '')}">${CONFIG.TIER_SHORT[prof.tier] || prof.tier}</div>`;

  const ps = portraitState[prof.id] || { open: false, tab: 'contact', industrySub: 'labs' };
  const tab = ps.tab || 'contact';
  const industrySub = ps.industrySub || 'labs';
  const open = !!ps.open;
  const tabs = [
    { key: 'contact', label: '联系方式' },
    { key: 'declared', label: '自述' },
    { key: 'narrative', label: '解读' },
    { key: 'papers', label: '论文' },
    { key: 'industry', label: '合作' }
  ];
  const tabBtns = tabs.map(t =>
    `<button type="button" class="portrait-tab ${tab === t.key ? 'active' : ''}" data-portrait-tab="${t.key}" data-id="${prof.id}">${t.label}</button>`
  ).join('');

  let tabPanel = '';
  if (tab === 'contact') {
    tabPanel = buildContactPanel(prof);
  } else if (tab === 'declared') {
    tabPanel = `<ul class="declared-list">${declared || '<li style="color:var(--ink-faint)">暂无自述</li>'}</ul>`;
  } else if (tab === 'narrative') {
    tabPanel = `<p class="narrative">${prof.narrative || '<span style="color:var(--ink-faint)">暂无解读</span>'}</p>`;
  } else if (tab === 'papers') {
    tabPanel = `<ul class="recent-list">${recent || '<li style="color:var(--ink-faint)">暂无论文条目</li>'}</ul>`;
  } else if (tab === 'industry') {
    tabPanel = buildIndustryPanel(prof, industrySub);
  } else {
    tabPanel = `<ul class="recent-list">${recent || '<li style="color:var(--ink-faint)">暂无论文条目</li>'}</ul>`;
  }

  return `
  <div class="card tier-${prof.tier} ${open ? 'portrait-open' : ''}" id="card-${prof.id}">
    <div class="card-head">
      <div class="avatar">${initials}</div>
      <div class="head-text">
        <h3>${escapeHtml(prof.name)}</h3>
        <div class="role">${escapeHtml(prof.role)}</div>
      </div>
      <div class="head-right">
        ${tierBadge}
        <div class="score-badge">
          <div class="num">${scores.composite}</div>
          <div class="lbl">综合得分</div>
          ${statusBadge}
        </div>
      </div>
    </div>

    ${oneLiner}

    <div class="card-controls-row">
      <label class="ctrl-compare">
        <input type="checkbox" class="compare-check" data-id="${prof.id}" ${compareChecked ? 'checked' : ''} ${compareDisabled ? 'disabled' : ''}>
        对比
      </label>
      <label class="ctrl-status">
        标记
        <select class="status-select" data-id="${prof.id}">${statusOptionsHtml}</select>
      </label>
    </div>

    <div class="stats-row">
      <span>Scopus <b>${prof.scopusCitations != null ? Number(prof.scopusCitations).toLocaleString() : '—'}</b></span>
      <span>h <b>${prof.hIndex != null ? prof.hIndex : '—'}</b></span>
      <span>活跃 <b>${scores.trendScore}</b></span>
      <span>影响 <b>${scores.impactScore}</b></span>
      ${matchNote ? `<span>${matchNote}</span>` : ''}
    </div>

    <div class="section-block">
      <h4>经典方向 <span class="chip-hint">点词看解释</span></h4>
      <div class="chips">${classicChips || '<span class="chip">待补充</span>'}</div>
    </div>

    <div class="section-block">
      <h4>新兴 / 活跃 <span class="chip-hint">点词看解释</span></h4>
      <div class="chips">${emergingChips || '<span class="chip">待补充</span>'}</div>
      <div class="glossary-box" id="glossary-${prof.id}"></div>
    </div>

    <div class="portrait-panel">
      <button type="button" class="portrait-toggle ${open ? 'is-open' : ''}" data-portrait-toggle="${prof.id}">
        <span class="portrait-toggle-icon">${open ? '▼' : '▸'}</span>
        <span class="portrait-toggle-text">${open ? '收起完整画像' : '展开完整画像'}</span>
      </button>
      <div class="portrait-body ${open ? 'show' : ''}">
        <div class="portrait-tabs" role="tablist">${tabBtns}</div>
        <p class="portrait-scroll-hint">↕ 下方内容区可上下滚动（右侧有滚动条）</p>
        <div class="portrait-tab-panel" data-active-tab="${tab}" tabindex="0">${tabPanel}</div>
      </div>
    </div>
  </div>`;
}

// ======== RENDER: MAIN ========
function render() {
  const raw = document.getElementById('interestInput').value;
  const userTags = parseTags(raw);
  const nameQuery = (document.getElementById('nameInput')?.value || '').trim();

  weights = {
    match: Number(document.getElementById('wMatch').value),
    trend: Number(document.getElementById('wTrend').value),
    impact: Number(document.getElementById('wImpact').value)
  };

  // Update weight displays
  document.getElementById('wMatchVal').textContent = weights.match;
  document.getElementById('wTrendVal').textContent = weights.trend;
  document.getElementById('wImpactVal').textContent = weights.impact;

  // Active tags
  const activeTagsEl = document.getElementById('activeTags');
  activeTagsEl.innerHTML = userTags.map(t => `<span>${escapeHtml(t)}</span>`).join('');

  // Filter by name + tier tab, then score and sort
  const filtered = PROFESSORS.filter(p => {
    if (!nameMatches(p, nameQuery)) return false;
    if (tierTab !== 'all' && p.tier !== tierTab) return false;
    return true;
  });
  const scored = filtered.map(p => ({ p, s: computeScores(p, userTags, weights) }));
  scored.sort((a, b) => b.s.composite - a.s.composite);

  const nameNote = nameQuery ? ` · 姓名「${nameQuery}」` : '';
  const tierNote = tierTab === 'all' ? '' : ` · ${CONFIG.TIER_SHORT[tierTab]}`;
  document.getElementById('resultsCount').textContent = `共 ${scored.length} 位${tierNote}${nameNote}`;

  const grid = document.getElementById('cardGrid');
  if (scored.length === 0) {
    grid.innerHTML = `<div class="empty-state">这个分类下没有匹配的导师 —— 试试切换 Tab，或换个姓名/关键词</div>`;
  } else {
    grid.innerHTML = scored.map(({ p, s }) => renderCard(p, s, userTags)).join('');
  }

  renderPresetChips();
  renderTierTabs();
}

function renderTierTabs() {
  const el = document.getElementById('tierTabs');
  if (!el) return;

  const nameQuery = (document.getElementById('nameInput')?.value || '').trim();
  const base = PROFESSORS.filter(p => nameMatches(p, nameQuery));
  const counts = {
    all: base.length,
    stable: base.filter(p => p.tier === 'stable').length,
    evolve: base.filter(p => p.tier === 'evolve').length,
    pivot: base.filter(p => p.tier === 'pivot').length
  };

  const tabs = [
    { key: 'all', label: '全部' },
    { key: 'stable', label: CONFIG.TIER_SHORT.stable },
    { key: 'evolve', label: CONFIG.TIER_SHORT.evolve },
    { key: 'pivot', label: CONFIG.TIER_SHORT.pivot }
  ];

  el.innerHTML = tabs.map(t =>
    `<button type="button" class="tier-tab tier-tab-${t.key} ${tierTab === t.key ? 'active' : ''}" data-tier-tab="${t.key}">
      ${escapeHtml(t.label)} <span class="tier-tab-count">${counts[t.key]}</span>
    </button>`
  ).join('');
}

// ======== PRESET & HISTORY CHIPS ========
function renderPresetChips() {
  const el = document.getElementById('presetChips');
  if (!el) return;

  const current = parseTags(document.getElementById('interestInput').value);
  el.innerHTML = CONFIG.PRESET_KEYWORDS.map(k => {
    const active = current.includes(k.toLowerCase());
    return `<button type="button" class="quick-chip ${active ? 'active' : ''}" data-kw="${escapeHtml(k)}">${escapeHtml(k)}</button>`;
  }).join('');
}

function toggleKeywordInInput(kw) {
  const input = document.getElementById('interestInput');
  let tags = parseTags(input.value);
  const kwLower = kw.toLowerCase();

  if (tags.includes(kwLower)) {
    tags = tags.filter(t => t !== kwLower);
  } else {
    tags.push(kwLower);
  }

  input.value = tags.join(', ');
  render();
}

function renderHistoryChips() {
  const row = document.getElementById('historyRow');
  const el = document.getElementById('historyChips');
  if (!row || !el) return;

  if (searchHistory.length === 0) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'flex';
  el.innerHTML = searchHistory.map(h =>
    `<button type="button" class="quick-chip" data-history="${escapeHtml(h)}">${escapeHtml(h)}</button>`
  ).join('');
}

function commitHistory(value) {
  const v = value.trim();
  if (!v) return;

  searchHistory = searchHistory.filter(h => h.toLowerCase() !== v.toLowerCase());
  searchHistory.unshift(v);
  searchHistory = searchHistory.slice(0, 5);

  storageSet(CONFIG.STORAGE_KEYS.searchHistory, searchHistory);
  renderHistoryChips();
}

// ======== COMPARE ========
function renderCompareBar() {
  const bar = document.getElementById('compareBar');
  if (compareSet.size === 0) {
    bar.classList.remove('show');
    return;
  }

  bar.classList.add('show');

  const chips = [...compareSet].map(id => {
    const prof = PROFESSORS.find(p => p.id === id);
    const shortName = prof ? getShortName(prof.name) : id;
    return `<span class="compare-chip">${escapeHtml(shortName)}<button class="compare-remove" data-id="${id}" type="button" aria-label="移除">✕</button></span>`;
  }).join('');

  document.getElementById('compareChips').innerHTML = chips;
  document.getElementById('compareCountText').textContent = `已选 ${compareSet.size}/${CONFIG.MAX_COMPARE}`;
  document.getElementById('compareViewBtn').disabled = compareSet.size < 2;
}

function flashCompareBarMessage(msg) {
  const bar = document.getElementById('compareBar');
  bar.classList.add('show');
  document.getElementById('compareCountText').textContent = msg;
  setTimeout(renderCompareBar, 1800);
}

function buildCompareTable() {
  const ids = [...compareSet];
  const profs = ids.map(id => PROFESSORS.find(p => p.id === id)).filter(Boolean);

  if (profs.length < 2) {
    return '<p style="color:var(--ink-dim);">至少选2位才能对比。</p>';
  }

  const n = profs.length;
  const restWidth = (84 / n).toFixed(1);
  const colgroup = `<colgroup><col style="width:16%">` + profs.map(() => `<col style="width:${restWidth}%">`).join('') + `</colgroup>`;
  const colHeaders = profs.map(p => `<th>${escapeHtml(getShortName(p.name))}</th>`).join('');

  const rows = [
    ['职称', profs.map(p => escapeHtml(p.role))],
    ['方向类型', profs.map(p => `<span style="color:${tierColor(CONFIG.TIER_SCORE[p.tier])};font-weight:600;">${escapeHtml(CONFIG.TIER_LABEL[p.tier].split(' —')[0])}</span>`)],
    ['一句话总结', profs.map(p => escapeHtml(p.oneLiner || ''))],
    ['经典方向', profs.map(p => p.classicTags.slice(0, 4).map(t => `<span class="mini-chip classic">${escapeHtml(t)}</span>`).join(''))],
    ['新兴方向', profs.map(p => p.emergingTags.slice(0, 4).map(t => `<span class="mini-chip emerging">${escapeHtml(t)}</span>`).join(''))],
    ['学术影响力', profs.map(p => `Scopus被引 <b>${p.scopusCitations.toLocaleString()}</b><br>h-index <b>${p.hIndex}</b>`)],
    ['Email', profs.map(p => `<span style="font-family:var(--mono);font-size:.78rem;">${escapeHtml(p.email)}</span>`)]
  ];

  const bodyRows = rows.map(([label, cells]) =>
    `<tr><th>${escapeHtml(label)}</th>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`
  ).join('');

  return `<table class="compare-table">${colgroup}<thead><tr><th></th>${colHeaders}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

// ======== MY LIST ========
function buildMyListContent() {
  const groups = [
    { key: 'contacted', label: '已联系' },
    { key: 'interested', label: '感兴趣' },
    { key: 'dropped', label: '放弃' },
    { key: 'none', label: '未标记' }
  ];

  return groups.map(g => {
    const ids = PROFESSORS.filter(p => (statusMap[p.id] || 'none') === g.key).map(p => p.id);
    const items = ids.map(id => {
      const prof = PROFESSORS.find(p => p.id === id);
      return `<li><button class="mylist-name" data-target="card-${id}" type="button">${escapeHtml(getShortName(prof.name))}</button></li>`;
    }).join('') || '<li style="color:var(--ink-faint);list-style:none;">暂无</li>';

    return `<div class="mylist-group"><h4>${g.label}(${ids.length})</h4><ul>${items}</ul></div>`;
  }).join('');
}

function openMyList() {
  document.getElementById('myListContent').innerHTML = buildMyListContent();
  showOverlay('myListOverlay');
}

function exportMyListCsv() {
  const rows = [['状态', '姓名', '职务', '邮箱', '方向类型', '一句话', 'Scholar']];
  const order = ['interested', 'contacted', 'dropped', 'none'];
  const labelOf = Object.fromEntries(CONFIG.STATUS_OPTIONS.map(o => [o.key, o.label]));

  order.forEach(status => {
    PROFESSORS.filter(p => (statusMap[p.id] || 'none') === status).forEach(p => {
      rows.push([
        labelOf[status] || status,
        p.name || '',
        p.role || '',
        p.email || '',
        CONFIG.TIER_SHORT[p.tier] || p.tier || '',
        (p.oneLiner || '').replace(/"/g, '""'),
        p.scholarUrl || ''
      ]);
    });
  });

  const marked = rows.length - 1;
  if (marked === 0) {
    alert('清单还是空的：先在卡片上把老师标记为「感兴趣 / 已联系 / 放弃」。');
    return;
  }

  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `mentor-list-${CONFIG.deptShort}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ======== OVERLAY ========
function showOverlay(id) {
  document.getElementById(id).classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeOverlay(id) {
  document.getElementById(id).classList.remove('show');
  document.body.style.overflow = '';
}

// ======== SCROLL ========
function scrollToCard(domId) {
  closeOverlay('compareOverlay');
  closeOverlay('myListOverlay');

  const target = document.getElementById(domId);
  if (!target) return;

  target.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'center'
  });

  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1300);
}

function flashGuideTarget(el) {
  if (!el) return;
  el.classList.add('guide-flash');
  setTimeout(() => el.classList.remove('guide-flash'), 2200);
}

function jumpToGuideTarget(selector, fallback) {
  let el = selector ? document.querySelector(selector) : null;
  if ((!el || (el.id === 'compareBar' && !el.classList.contains('show'))) && fallback) {
    el = document.querySelector(fallback);
  }
  if (!el) return;

  // 浮动按钮 / 清单：直接打开清单，并闪一下按钮
  if (el.id === 'myListBtn') {
    flashGuideTarget(el);
    openMyList();
    return;
  }

  // 纠错板：展开后再滚过去
  if (el.id === 'qualityBoard' && !el.open) el.open = true;
  if (el.id === 'sectionMethodology' && el.matches('details') && !el.open) el.open = true;

  // 「老师卡片」：滚到当前列表第一张卡片顶部，不要停在漂移仪图例
  if (el.id === 'cardGrid') {
    const firstCard = el.querySelector('.card');
    if (firstCard) el = firstCard;
  }

  // 卡片区 / 分类区：对齐到区块开头，别滚到一大片中间
  const alignStart = new Set([
    'cardGrid',
    'sectionResults',
    'sectionBubble',
    'sectionFilter',
    'sectionSearch',
    'sectionWeights',
    'tierLegend'
  ]);
  let block = 'center';
  if (el.id === 'compareBar') block = 'end';
  else if (el.classList?.contains('card') || alignStart.has(el.id)) block = 'start';

  el.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block
  });
  flashGuideTarget(el);
}

function wireGuideSteps() {
  const body = document.getElementById('guideBody');
  if (!body || body.dataset.wired === '1') return;
  body.dataset.wired = '1';
  body.addEventListener('click', (e) => {
    const step = e.target.closest('[data-guide-target]');
    if (!step) return;
    const target = step.getAttribute('data-guide-target');
    const fallback = step.getAttribute('data-guide-fallback');
    closeOverlay('guideOverlay');
    // 等遮罩关掉再滚，避免 body overflow:hidden 干扰
    requestAnimationFrame(() => {
      setTimeout(() => jumpToGuideTarget(target, fallback), 40);
    });
  });
}

// ======== COPY TO CLIPBOARD ========
async function copyToClipboard(value, btn) {
  const restore = btn.textContent;
  const done = () => {
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = restore;
      btn.classList.remove('copied');
    }, 1500);
  };

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      done();
    } else {
      throw new Error('Clipboard API unavailable');
    }
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (err) {
      btn.textContent = '请手动选中文字';
      setTimeout(() => { btn.textContent = restore; }, 1500);
    }
  }
}

// ======== EVENT HANDLERS ========
function setupEventListeners() {
  // Bubble clicks
  document.getElementById('bubbleField').addEventListener('click', (e) => {
    const b = e.target.closest('.bubble');
    if (!b || b.classList.contains('ghost')) return;

    const themeId = b.getAttribute('data-theme-id');
    expandedThemeId = (expandedThemeId === themeId) ? null : themeId;
    renderBubbles();
  });

  // 窄屏：整块 bubble 地图等比缩放（与下方卡片重排不同）
  let bubbleScaleRaf = 0;
  const onBubbleScale = () => {
    cancelAnimationFrame(bubbleScaleRaf);
    bubbleScaleRaf = requestAnimationFrame(() => scaleBubbleField());
  };
  window.addEventListener('resize', onBubbleScale);
  if (typeof ResizeObserver !== 'undefined') {
    const vp = document.getElementById('bubbleFieldViewport');
    if (vp) new ResizeObserver(onBubbleScale).observe(vp);
  }

  // Theme expand name chips
  document.getElementById('themeExpand').addEventListener('click', (e) => {
    const nc = e.target.closest('.name-chip');
    if (!nc) return;
    scrollToCard(nc.getAttribute('data-target'));
  });

  // Input
  const interestInput = document.getElementById('interestInput');
  interestInput.addEventListener('input', render);
  interestInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitHistory(e.target.value);
  });
  interestInput.addEventListener('blur', (e) => {
    commitHistory(e.target.value);
  });

  const nameInput = document.getElementById('nameInput');
  if (nameInput) {
    nameInput.addEventListener('input', render);
  }

  // Sliders
  ['wMatch', 'wTrend', 'wImpact'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
  });

  // Reset
  document.getElementById('resetBtn').addEventListener('click', () => {
    interestInput.value = '';
    if (nameInput) nameInput.value = '';
    tierTab = 'all';
    document.getElementById('wMatch').value = 50;
    document.getElementById('wTrend').value = 30;
    document.getElementById('wImpact').value = 20;
    render();
  });

  // Tier classification tabs
  document.getElementById('tierTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tier-tab]');
    if (!btn) return;
    tierTab = btn.getAttribute('data-tier-tab') || 'all';
    render();
  });

  // Preset chips
  document.getElementById('presetChips').addEventListener('click', (e) => {
    const b = e.target.closest('.quick-chip');
    if (!b) return;
    toggleKeywordInInput(b.getAttribute('data-kw'));
  });

  // History chips
  document.getElementById('historyChips').addEventListener('click', (e) => {
    const b = e.target.closest('.quick-chip');
    if (!b) return;
    document.getElementById('interestInput').value = b.getAttribute('data-history');
    render();
  });

  // Card grid: copy, glossary, portrait toggle/tabs, status, compare
  document.getElementById('cardGrid').addEventListener('click', (e) => {
    // Copy button
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const val = copyBtn.getAttribute('data-copy-value');
      copyToClipboard(val, copyBtn);
      return;
    }

    // Expand / collapse portrait
    const toggleBtn = e.target.closest('[data-portrait-toggle]');
    if (toggleBtn) {
      const id = toggleBtn.getAttribute('data-portrait-toggle');
      const prev = portraitState[id] || { open: false, tab: 'contact', industrySub: 'labs' };
      portraitState[id] = {
        open: !prev.open,
        tab: prev.tab || 'contact',
        industrySub: prev.industrySub || 'labs'
      };
      render();
      return;
    }

    // Portrait inner tabs
    const tabBtn = e.target.closest('[data-portrait-tab]');
    if (tabBtn) {
      const id = tabBtn.getAttribute('data-id');
      const tab = tabBtn.getAttribute('data-portrait-tab');
      const prev = portraitState[id] || { open: true, tab: 'contact', industrySub: 'labs' };
      portraitState[id] = {
        open: true,
        tab,
        industrySub: tab === 'industry' ? (prev.industrySub || 'labs') : (prev.industrySub || 'labs')
      };
      render();
      return;
    }

    // Industry nested subtabs
    const industrySubBtn = e.target.closest('[data-industry-sub]');
    if (industrySubBtn) {
      const id = industrySubBtn.getAttribute('data-id');
      const industrySub = industrySubBtn.getAttribute('data-industry-sub') || 'labs';
      const prev = portraitState[id] || { open: true, tab: 'industry', industrySub: 'labs' };
      portraitState[id] = { open: true, tab: 'industry', industrySub };
      render();
      return;
    }

    // Glossary chip：再点同一关键词 = 收起解释
    const chipBtn = e.target.closest('.chip[data-term]');
    if (chipBtn) {
      const term = chipBtn.getAttribute('data-term');
      const card = chipBtn.closest('.card');
      const box = card.querySelector('.glossary-box');
      const isSameOpen =
        box.classList.contains('show') &&
        box.getAttribute('data-active-term') === term;

      card.querySelectorAll('.chip[data-term]').forEach(c => c.classList.remove('active'));

      if (isSameOpen) {
        box.classList.remove('show');
        box.removeAttribute('data-active-term');
        box.innerHTML = '';
        return;
      }

      const def = lookupGlossary(term);
      const body = glossaryBodyText(term, def);
      if (!def || isGlossaryStub(def)) {
        box.innerHTML = `<b>${escapeHtml(term)}</b>　<span style="color:var(--amber);">暂时还没有这个词的白话解释（词义说明待补）。</span>`;
      } else {
        box.innerHTML = `<b>${escapeHtml(term)}</b>　${escapeHtml(body)}`;
      }
      box.setAttribute('data-active-term', term);
      box.classList.add('show');
      chipBtn.classList.add('active');
      box.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return;
    }
  });

  // Card grid: change events (status, compare checkbox)
  document.getElementById('cardGrid').addEventListener('change', (e) => {
    // Status select
    const sel = e.target.closest('.status-select');
    if (sel) {
      const id = sel.getAttribute('data-id');
      statusMap[id] = sel.value;
      storageSet(CONFIG.STORAGE_KEYS.statusMap, statusMap);
      render();
      return;
    }

    // Compare checkbox
    const chk = e.target.closest('.compare-check');
    if (chk) {
      const id = chk.getAttribute('data-id');
      if (chk.checked) {
        if (compareSet.size >= CONFIG.MAX_COMPARE) {
          chk.checked = false;
          flashCompareBarMessage('最多对比3位,先取消一个再选');
          return;
        }
        compareSet.add(id);
      } else {
        compareSet.delete(id);
      }
      renderCompareBar();
      render();
    }
  });

  // Compare bar remove
  document.getElementById('compareChips').addEventListener('click', (e) => {
    const rm = e.target.closest('.compare-remove');
    if (!rm) return;
    compareSet.delete(rm.getAttribute('data-id'));
    renderCompareBar();
    render();
  });

  // Compare view button
  document.getElementById('compareViewBtn').addEventListener('click', () => {
    if (compareSet.size < 2) return;
    document.getElementById('compareTableWrap').innerHTML = buildCompareTable();
    showOverlay('compareOverlay');
  });

  // Overlay close buttons
  document.querySelectorAll('.overlay-close').forEach(btn => {
    btn.addEventListener('click', () => closeOverlay(btn.getAttribute('data-close')));
  });

  // Overlay click outside
  document.querySelectorAll('.overlay').forEach(ov => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeOverlay(ov.id);
    });
  });

  // Guide / tutorial button（与清单同款右上角 tab）
  document.getElementById('guideBtn')?.addEventListener('click', () => {
    showOverlay('guideOverlay');
  });
  wireGuideSteps();

  // My list button
  document.getElementById('myListBtn').addEventListener('click', openMyList);

  // My list overlay: click on names
  document.getElementById('myListOverlay').addEventListener('click', (e) => {
    const nm = e.target.closest('.mylist-name');
    if (nm) scrollToCard(nm.getAttribute('data-target'));
  });

  // Export my list
  document.getElementById('exportListBtn')?.addEventListener('click', exportMyListCsv);

  // Clear status button
  let clearArmed = false;
  document.getElementById('clearStatusBtn').addEventListener('click', () => {
    const btn = document.getElementById('clearStatusBtn');
    if (!clearArmed) {
      clearArmed = true;
      btn.textContent = '再点一次确认清空';
      setTimeout(() => {
        clearArmed = false;
        btn.textContent = '清空所有标记';
      }, 3000);
      return;
    }
    clearArmed = false;
    statusMap = {};
    storageSet(CONFIG.STORAGE_KEYS.statusMap, statusMap);
    btn.textContent = '清空所有标记';
    openMyList();
    render();
  });

  // Back to top
  window.addEventListener('scroll', () => {
    const btn = document.getElementById('backToTopBtn');
    if (window.scrollY > 400) btn.classList.add('show');
    else btn.classList.remove('show');
  });

  document.getElementById('backToTopBtn').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
}

// ======== INITIALIZATION ========
function updateVersionUI() {
  const siteVersion = METADATA.siteVersion || (METADATA.version ? `v${METADATA.version}` : 'v1.2.0');
  const dataVersion = METADATA.version ? `v${METADATA.version}` : siteVersion;
  const lastUpdated = METADATA.lastUpdated || '—';
  const count = PROFESSORS.length;

  document.title = `导师筛选器 ${siteVersion} · ${CONFIG.deptTitle}`;

  const eyebrow = document.getElementById('versionEyebrow');
  if (eyebrow) eyebrow.textContent = `站点 ${siteVersion} · 数据 ${dataVersion}`;

  const versionPill = document.getElementById('versionPill');
  if (versionPill) {
    versionPill.textContent = `站点 ${siteVersion}`;
    versionPill.title = `数据 ${dataVersion} · 更新 ${lastUpdated} · 共 ${count} 位导师`;
  }

  const dataDatePill = document.getElementById('dataDatePill');
  if (dataDatePill) dataDatePill.textContent = `数据更新 ${lastUpdated}`;

  const profCountPill = document.getElementById('profCountPill');
  if (profCountPill) profCountPill.textContent = `${count} 位全职教职`;

  const footerNote = document.getElementById('footerVersionNote');
  if (footerNote) {
    footerNote.textContent = `CDE Mentor Navigator · Phase ${METADATA.phase || 1} · 站点 ${siteVersion} · 数据 ${dataVersion} · 最后更新 ${lastUpdated}`;
  }

  const bubbleCount = document.getElementById('bubbleCount');
  if (bubbleCount) bubbleCount.textContent = String(count);

  updateQualityBoard();
}

function getErrorReports() {
  const list = storageGet(CONFIG.STORAGE_KEYS.errorReports);
  return Array.isArray(list) ? list : [];
}

function saveErrorReports(list) {
  storageSet(CONFIG.STORAGE_KEYS.errorReports, list);
}

function professorOptionsHtml(selectedId) {
  const opts = PROFESSORS.map(p => {
    const sel = p.id === selectedId ? ' selected' : '';
    return `<option value="${escapeHtml(p.id)}"${sel}>${escapeHtml(p.name)}</option>`;
  }).join('');
  return `<option value="">—— 选择老师（可选）——</option>${opts}`;
}

function renderErrorReportList() {
  const box = document.getElementById('errorReportList');
  if (!box) return;
  const list = getErrorReports();
  if (!list.length) {
    box.innerHTML = `<p class="quality-footnote">本机还没有纠错记录。提交后会留在这台浏览器，方便你导出给维护者定点改。</p>`;
    return;
  }
  box.innerHTML = `<ol class="error-report-items">${list.slice().reverse().map((r, idx) => {
    const n = list.length - idx;
    const who = r.profName || r.profId || '（未指定老师）';
    const wrong = escapeHtml((r.wrongSnippet || '').slice(0, 120));
    const fix = escapeHtml((r.correction || '').slice(0, 120));
    return `<li>
      <div class="error-report-item-head"><b>#${n}</b> · ${escapeHtml(who)} · <span>${escapeHtml(r.createdAt || '')}</span></div>
      <div class="error-report-item-row"><span>出错原文</span>${wrong || '—'}</div>
      <div class="error-report-item-row"><span>建议改成</span>${fix || '—'}</div>
    </li>`;
  }).join('')}</ol>`;
}

function updateQualityBoard() {
  const summaryEl = document.getElementById('qualityBoardSummary');
  const bodyEl = document.getElementById('qualityBoardBody');
  if (!summaryEl || !bodyEl) return;

  const n = getErrorReports().length;
  summaryEl.innerHTML = n
    ? `发现信息有误？点这里纠错 · 本机已记 <b>${n}</b> 条`
    : '发现信息有误？点这里纠错';

  bodyEl.innerHTML = `
    <p class="report-lead">看到错的方向 / 链接 / 数字？把<strong>出错原文</strong>贴上来，再写<strong>你认为对的内容</strong>——像填空题一样，方便后面定点改数据。</p>
    <form class="error-report-form" id="errorReportForm">
      <label class="report-field">
        <span>哪位老师（可选）</span>
        <select id="reportProfId">${professorOptionsHtml('')}</select>
      </label>
      <label class="report-field">
        <span>出错的部分（直接复制粘贴）</span>
        <textarea id="reportWrong" rows="3" placeholder="例如：把卡片/联系方式里写错的那一句整段贴进来" required></textarea>
      </label>
      <label class="report-field">
        <span>你觉得应改成什么</span>
        <textarea id="reportFix" rows="3" placeholder="例如：正确邮箱 / 正确主页链接 / 正确方向表述…" required></textarea>
      </label>
      <label class="report-field">
        <span>补充说明（可选）</span>
        <input id="reportNote" type="text" placeholder="例如：来源是老师 2026 主页 About 段" autocomplete="off">
      </label>
      <div class="report-actions">
        <button type="submit" class="report-btn primary">提交到本机</button>
        <button type="button" class="report-btn" id="reportExportBtn">导出 JSON</button>
        <button type="button" class="report-btn" id="reportCopyBtn">复制全部</button>
        <button type="button" class="report-btn ghost" id="reportClearBtn">清空本机记录</button>
      </div>
      <p class="quality-footnote" id="reportFormHint">目前没有后端邮箱接口：记录保存在你浏览器 localStorage，导出/复制后发给维护者即可定点修改。</p>
    </form>
    <div id="errorReportList" class="error-report-list"></div>`;

  renderErrorReportList();
  wireErrorReportForm();
}

function wireErrorReportForm() {
  const form = document.getElementById('errorReportForm');
  if (!form || form.dataset.wired === '1') return;
  form.dataset.wired = '1';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const profId = (document.getElementById('reportProfId')?.value || '').trim();
    const prof = PROFESSORS.find(p => p.id === profId);
    const wrongSnippet = (document.getElementById('reportWrong')?.value || '').trim();
    const correction = (document.getElementById('reportFix')?.value || '').trim();
    const note = (document.getElementById('reportNote')?.value || '').trim();
    const hint = document.getElementById('reportFormHint');
    if (!wrongSnippet || !correction) {
      if (hint) hint.textContent = '请至少填写「出错的部分」和「应改成什么」。';
      return;
    }
    const entry = {
      id: `err_${Date.now()}`,
      dept: CONFIG.deptShort,
      profId: profId || null,
      profName: prof ? prof.name : null,
      wrongSnippet,
      correction,
      note: note || null,
      pageUrl: location.href.split('#')[0],
      createdAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    };
    const list = getErrorReports();
    list.push(entry);
    saveErrorReports(list);
    updateQualityBoard();
    const board = document.getElementById('qualityBoard');
    if (board) board.open = true;
    const hintAfter = document.getElementById('reportFormHint');
    if (hintAfter) hintAfter.textContent = '已保存到本机。可点「导出 JSON」或「复制全部」发给维护者。';
  });

  document.getElementById('reportExportBtn')?.addEventListener('click', () => {
    const list = getErrorReports();
    const blob = new Blob([JSON.stringify({ dept: CONFIG.deptShort, exportedAt: new Date().toISOString(), reports: list }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mentor-error-reports-${CONFIG.deptShort}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('reportCopyBtn')?.addEventListener('click', async () => {
    const list = getErrorReports();
    const text = JSON.stringify({ dept: CONFIG.deptShort, reports: list }, null, 2);
    const hint = document.getElementById('reportFormHint');
    try {
      await navigator.clipboard.writeText(text);
      if (hint) hint.textContent = '已复制全部纠错 JSON 到剪贴板。';
    } catch (err) {
      if (hint) hint.textContent = '复制失败，请改用「导出 JSON」。';
    }
  });

  document.getElementById('reportClearBtn')?.addEventListener('click', () => {
    if (!getErrorReports().length) return;
    if (!confirm('清空本机全部纠错记录？此操作不可撤销。')) return;
    saveErrorReports([]);
    updateQualityBoard();
    const board = document.getElementById('qualityBoard');
    if (board) board.open = true;
  });
}

function updateStorageStatusNote() {
  const el = document.getElementById('storageStatusNote');
  if (!el) return;

  const isLocalStorageAvailable = (() => {
    try {
      const test = '__test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch (e) {
      return false;
    }
  })();

  el.textContent = isLocalStorageAvailable
    ? '✓ 已支持跨会话保存标记/搜索记录'
    : '⚠ 当前浏览器不支持localStorage,标记/搜索记录仅本次有效';
}

async function init() {
  // Load data
  const loaded = await loadData();
  if (!loaded) return;

  // Load saved state
  statusMap = storageGet(CONFIG.STORAGE_KEYS.statusMap) || {};
  searchHistory = storageGet(CONFIG.STORAGE_KEYS.searchHistory) || [];
  const savedWeights = storageGet(CONFIG.STORAGE_KEYS.weights);
  if (savedWeights) {
    weights = savedWeights;
    document.getElementById('wMatch').value = weights.match;
    document.getElementById('wTrend').value = weights.trend;
    document.getElementById('wImpact').value = weights.impact;
  }

  // Update UI
  updateVersionUI();
  updateStorageStatusNote();
  updateQualityBoard();
  renderBubbles();
  renderHistoryChips();
  setupEventListeners();
  render();
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
