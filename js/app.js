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
    weights: DEPT.storagePrefix ? `${DEPT.storagePrefix}_weights` : 'cde_mentor_weights'
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
let GLOSSARY = {};
let METADATA = {};

let statusMap = {};
let searchHistory = [];
let weights = { match: 50, trend: 30, impact: 20 };
const compareSet = new Set();
let expandedThemeId = null;
/** 结果区分类 Tab：all | stable | evolve | pivot */
let tierTab = 'all';
/** 卡片完整画像：id -> { open, tab }；tab = contact|declared|narrative|papers */
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
    const response = await fetch(CONFIG.dataUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    PROFESSORS = data.professors || [];
    THEMES = data.themes || [];
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
function renderBubbles() {
  const field = document.getElementById('bubbleField');
  if (!field) return;

  const html = THEMES.map(theme => {
    const count = theme.profIds.length;
    if (count === 0) {
      const size = 58;
      return `<div class="bubble ghost" style="width:${size}px;height:${size}px;" title="这个方向暂时没有已录入的老师">
        <div class="bname-en">${escapeHtml(theme.nameEn)}</div>
        <div class="bcount">0 位 · 待补充</div>
      </div>`;
    }

    const avgTier = theme.profIds.reduce((sum, id) => {
      const prof = PROFESSORS.find(p => p.id === id);
      return sum + (prof ? CONFIG.TIER_SCORE[prof.tier] : 25);
    }, 0) / count;

    const size = Math.round(64 + Math.sqrt(count) * 46);
    const color = tierColor(avgTier);
    const isExpanded = expandedThemeId === theme.id;

    return `<button class="bubble ${isExpanded ? 'expanded' : ''}" type="button" data-theme-id="${theme.id}"
        style="width:${size}px;height:${size}px;background:${color};"
        title="点击查看这个方向有哪些老师">
      <div class="bname-en">${escapeHtml(theme.nameEn)}</div>
      <div class="bname-zh">${escapeHtml(theme.nameZh)}</div>
      <div class="bcount">${count} 位</div>
    </button>`;
  }).join('');

  field.innerHTML = html;
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

  // Contact rows
  const contactRows = [];
  if (prof.email) contactRows.push({ label: 'Email', value: prof.email });
  if (prof.scholarUrl) contactRows.push({ label: 'Scholar', value: prof.scholarUrl });
  if (prof.personalUrl) contactRows.push({ label: '个人主页', value: prof.personalUrl });
  if (prof.labUrl) contactRows.push({ label: prof.labLabel || '实验室', value: prof.labUrl });
  if (prof.scholarsUrl) contactRows.push({ label: 'CityU Scholars', value: prof.scholarsUrl });

  const latinName = prof.name.replace(/[一-鿿].*$/, '').trim();

  const contactHtml = contactRows.map(r => `
    <div class="contact-row">
      <span class="contact-label">${escapeHtml(r.label)}</span>
      <span class="contact-value">${escapeHtml(r.value)}</span>
      <button class="copy-btn" data-copy-value="${escapeHtml(r.value)}" type="button">复制</button>
    </div>
  `).join('') + `
    <div class="contact-row" style="opacity:.75;">
      <span class="contact-label">打不开?</span>
      <span class="contact-value" style="color:var(--ink-faint);border-bottom:none;">去Scholar搜索框搜「${escapeHtml(latinName)} City University of Hong Kong」</span>
    </div>`;

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

  const ps = portraitState[prof.id] || { open: false, tab: 'contact' };
  const tab = ps.tab || 'contact';
  const open = !!ps.open;
  const tabs = [
    { key: 'contact', label: '联系方式' },
    { key: 'declared', label: '自述' },
    { key: 'narrative', label: '解读' },
    { key: 'papers', label: '论文' }
  ];
  const tabBtns = tabs.map(t =>
    `<button type="button" class="portrait-tab ${tab === t.key ? 'active' : ''}" data-portrait-tab="${t.key}" data-id="${prof.id}">${t.label}</button>`
  ).join('');

  let tabPanel = '';
  if (tab === 'contact') {
    tabPanel = `<div class="contact-list">${contactHtml}</div>`;
  } else if (tab === 'declared') {
    tabPanel = `<ul class="declared-list">${declared || '<li style="color:var(--ink-faint)">暂无自述</li>'}</ul>`;
  } else if (tab === 'narrative') {
    tabPanel = `<p class="narrative">${prof.narrative || '<span style="color:var(--ink-faint)">暂无解读</span>'}</p>`;
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
      const prev = portraitState[id] || { open: false, tab: 'contact' };
      portraitState[id] = { open: !prev.open, tab: prev.tab || 'contact' };
      render();
      return;
    }

    // Portrait inner tabs
    const tabBtn = e.target.closest('[data-portrait-tab]');
    if (tabBtn) {
      const id = tabBtn.getAttribute('data-id');
      const tab = tabBtn.getAttribute('data-portrait-tab');
      const prev = portraitState[id] || { open: true, tab: 'contact' };
      portraitState[id] = { open: true, tab };
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
      box.innerHTML = def
        ? `<b>${escapeHtml(term)}</b>　${escapeHtml(def)}`
        : `<b>${escapeHtml(term)}</b>　<span style="color:var(--amber);">（这个词的解释还没整理，提个醒我下一批补上）</span>`;
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
