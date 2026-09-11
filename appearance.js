/* ============================================================
   深读 5.0 · appearance.js —— 外观系统（深浅双模式重构版）
   ------------------------------------------------------------
   5.0 结构：
   ① common —— 通用：阅读间距 + 阅读正文/章节排版（字号/对齐/字重）
   ② light / dark —— 各自独立一套外观：
      · colors   主题颜色（12 项）
      · homeBg   主页背景图
      · hero     主页主图
      · readerBg 阅读背景（色/图）
   ③ templates —— 模板：同时保存 common + light + dark，
      应用模板时深浅两套一起切换。
   修复：
   - 持久化：记录始终带 id:'appearance'，重启后可识别（4.9 丢失根因）。
   - 阅读器背景：背景图存在时强制 .reader/.reader-scroll/.reader-inner 透明。
   - 宿主重启抖动：主图注入去抖 + 只在内容变化时才动 DOM。
   ============================================================ */
'use strict';
(function () {
  if (!window.AiPhone) return;

  /* ───────── 默认值 ───────── */
  const COLOR_DEF = {
    light: {
      accent: '#3a3a3e', bg: '#f2f2f3', surface: '#ffffff', overlay: '#f4f4f6',
      ink: '#161618', ink2: '#55555a', ink3: '#9a9aa1', accentText: '#3a3a3e',
      highlight: '#a8c4d6', underline: '#788ca0',
      line: '#e3e3e6', stroke: '#f0f0f2',
    },
    dark: {
      accent: '#c9c9cf', bg: '#161617', surface: '#262629', overlay: '#303034',
      ink: '#ececef', ink2: '#a9a9b0', ink3: '#6f6f76', accentText: '#c9c9cf',
      highlight: '#a8c4d6', underline: '#788ca0',
      line: '#2c2c30', stroke: '#232326',
    },
  };
  const MODE_DEF = () => ({
    colors: arClone(COLOR_DEF.light),
    homeBg: { img: '', fit: 'cover', opacity: 1, mask: 0 },
    hero: { img: '' },
    readerBg: { color: '', img: '', fit: 'cover', opacity: 1 },
  });
  const COMMON_DEF = {
    bodyFont: '', bodySize: 17, bodyAlign: 'justify',
    titleFont: '', titleSize: 22, titleAlign: 'center', titleWeight: '500',
    ls: 0, lh: 2.1, pg: 6, mt: 26, mr: 26, mb: 130, ml: 26,
  };
  const KEY = 'appearance';
  const AR_DEF = () => ({
    id: KEY, v: 2,
    common: arClone(COMMON_DEF),
    light: MODE_DEF(),
    dark: Object.assign(MODE_DEF(), { colors: arClone(COLOR_DEF.dark) }),
    templates: [], activeTpl: '',
  });

  let AR = null;
  let draft = null;

  function arClone(o) { return JSON.parse(JSON.stringify(o)); }
  function escHTML(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* 归一化：兼容 4.9 旧数据迁移 */
  function mergeDef(saved) {
    const d = AR_DEF();
    if (!saved || typeof saved !== 'object') return d;
    const out = d;
    if (saved.common && typeof saved.common === 'object') out.common = Object.assign({}, COMMON_DEF, saved.common);
    for (const m of ['light', 'dark']) {
      const s = saved[m];
      if (s && typeof s === 'object') {
        out[m].colors = Object.assign({}, COLOR_DEF[m], s.colors ||
          /* 4.9 迁移：旧版颜色直接平铺在 light/dark 上 */
          ((s.accent || s.bg || s.ink) ? Object.assign({}, COLOR_DEF[m], s) : {}));
        if (s.homeBg && typeof s.homeBg === 'object') out[m].homeBg = Object.assign(out[m].homeBg, s.homeBg);
        if (s.hero && typeof s.hero === 'object') out[m].hero = Object.assign(out[m].hero, s.hero);
        /* 4.9 迁移：旧 reader.bgImg/bgColor → readerBg */
        const r = s.reader || {};
        if (r.bgImg) out[m].readerBg.img = r.bgImg;
        if (r.fit) out[m].readerBg.fit = r.fit;
        if (r.bgOpacity != null) out[m].readerBg.opacity = r.bgOpacity;
        if (r.bgColor) out[m].readerBg.color = r.bgColor;
      }
    }
    if (Array.isArray(saved.templates)) {
      /* 4.9 模板只存了 reader → 迁移为 common */
      out.templates = saved.templates.map(t => ({
        id: t.id || ('tpl_' + uid9()), name: t.name || '未命名', at: t.at || Date.now(),
        common: t.common || (t.reader ? Object.assign({}, COMMON_DEF, t.reader) : arClone(COMMON_DEF)),
        light: t.light || null, dark: t.dark || null,
      }));
    }
    out.activeTpl = saved.activeTpl || '';
    return out;
  }
  function uid9() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ───────── 持久化（核心修复：记录必须带 id） ───────── */
  async function loadAppearance() {
    try {
      const rows = await window.AiPhone.db.list('settings', { limit: 1000 });
      const norm = (rows || []).map(x => (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') ? x.data : x);
      const rec = norm.find(x => x && x.id === KEY);
      AR = mergeDef(rec);
    } catch (e) { AR = AR_DEF(); }
    applyAppearance();
  }
  async function saveAppearance() {
    if (!AR) return;
    AR.id = KEY; AR.v = 2;
    try {
      const rows = await window.AiPhone.db.list('settings', { limit: 1000 });
      const norm = (rows || []).map(x => (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') ? { rid: x.id, data: x.data } : { rid: (x && x.id) || null, data: x });
      const found = norm.find(r => r.data && r.data.id === KEY);
      if (found && found.rid) await window.AiPhone.db.update('settings', found.rid, AR);
      else await window.AiPhone.db.create('settings', AR);
      /* 双保险：主题模式同时写一份到 localStorage，宿主重启后首帧前即可恢复 */
      try { localStorage.setItem('deepread_theme', document.body.getAttribute('data-theme') === 'night' ? 'night' : 'day'); } catch (e2) {}
    } catch (e) { console.warn('[深读] 外观保存失败', e); }
  }

  /* ───────── 字体（5.0：移除宋体/楷体/黑体，只保留默认衬线与导入字体） ───────── */
  function hasCustomFont() {
    try { return !!(S.coset && S.coset.rdrFontB64 && S.coset.rdrFontName); } catch (e) { return false; }
  }
  function fontStack(v) {
    if (v === 'custom' && hasCustomFont()) return "'RdrCustom', var(--font-serif)";
    return 'var(--font-serif)';
  }
  function fontOptionsHtml(v) {
    let opts = `<option value=""${!v ? ' selected' : ''}>默认衬线</option>`;
    if (hasCustomFont()) opts += `<option value="custom"${v === 'custom' ? ' selected' : ''}>导入的字体</option>`;
    return opts;
  }

  /* ───────── 应用：注入覆盖样式 ───────── */
  function applyAppearance() {
    if (!AR) return;
    const theme = document.body.getAttribute('data-theme') === 'night' ? 'dark' : 'light';
    const M = AR[theme] || AR.light;
    const C = M.colors, H = M.homeBg, R = M.readerBg, K = AR.common;
    let st = document.getElementById('arStyle');
    if (!st) { st = document.createElement('style'); st.id = 'arStyle'; document.head.appendChild(st); }
    const sel = `[data-theme="${theme === 'dark' ? 'night' : 'day'}"]`;
    let css = '';
    /* ① 主题颜色（当前模式一套） */
    css += `${sel}{--accent:${C.accent};--bg:${C.bg};--bg-reader:${C.bg};--surface:${hexA(C.surface,.66)};--surface-2:${hexA(C.overlay,.8)};--glass-strong:${hexA(C.overlay,.84)};--glass:${hexA(C.surface,.6)};--ink:${C.ink};--ink-2:${C.ink2};--ink-3:${C.ink3};--gold:${C.accentText};--accent-text:${C.accentText};--line:${C.line};--line-soft:${C.stroke};--glass-border:${C.stroke};--accent-soft:${hexA(C.accent,.08)};}`;
    css += `${sel} mark.rl-resonate{background:${hexA(C.highlight,.32)} !important;}
${sel} mark.rl-coread{text-decoration-color:${hexA(C.underline,.8)} !important;}
${sel} mark.rl-insight{text-decoration-color:${hexA(C.underline,.55)} !important;}
${sel} mark.rl-question{text-decoration-color:${hexA(C.highlight,.6)} !important;}`;
    /* ② 主页背景图 */
    if (H.img) {
      const size = H.fit === 'contain' ? 'contain' : H.fit === 'stretch' ? '100% 100%' : 'cover';
      css += `.pages-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:url("${H.img}");background-size:${size};background-position:center;background-repeat:no-repeat;opacity:${H.opacity};}`;
      if (H.mask > 0) css += `.pages-bg::after{content:'';position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,${H.mask}),rgba(0,0,0,${H.mask}));}`;
    } else css += `.pages-bg{display:none !important;}`;
    /* ③④ 阅读器：背景图存在时强制底层透明（4.9 修复：.reader-inner 底色盖住背景图） */
    if (R.img) {
      const size = R.fit === 'contain' ? 'contain' : R.fit === 'stretch' ? '100% 100%' : 'cover';
      css += `.reader,.reader-scroll,.reader-inner{background:transparent !important;background-color:transparent !important;}`;
      css += `.reader-bgimg{position:absolute;inset:0;z-index:0;pointer-events:none;background-image:url("${R.img}");background-size:${size};background-position:center;background-repeat:no-repeat;opacity:${R.opacity};}`;
    } else {
      css += `.reader{background:${R.color || 'var(--bg-reader)'} !important;}`;
      css += `.reader-bgimg{display:none !important;}`;
    }
    /* ⑤ 通用排版（正文颜色跟随主题 --ink，不再单独设置） */
    css += `.reader-scroll{z-index:1;position:relative;}
.reader-inner{padding:${K.mt}px ${K.mr}px ${K.mb}px ${K.ml}px !important;}
.para{font-family:${fontStack(K.bodyFont)} !important;font-size:${K.bodySize}px !important;color:var(--ink) !important;letter-spacing:${K.ls}em !important;line-height:${K.lh} !important;text-align:${K.bodyAlign} !important;margin:0 0 ${K.pg}px !important;}
.para.head{font-family:${fontStack(K.titleFont)} !important;font-size:${K.titleSize}px !important;color:var(--ink) !important;text-align:${K.titleAlign} !important;font-weight:${K.titleWeight} !important;letter-spacing:${K.ls}em !important;line-height:${K.lh} !important;margin:38px 0 ${Math.max(K.pg, 14)}px !important;}
.chap-title{font-family:${fontStack(K.titleFont)} !important;font-size:${K.titleSize}px !important;color:var(--ink) !important;text-align:${K.titleAlign} !important;font-weight:${K.titleWeight} !important;letter-spacing:.02em;}
.chap-num{color:var(--ink-3) !important;}`;
    st.textContent = css;
    ensureArCss();
    ensureReaderBgLayer();
    injectHero();
  }
  function hexA(c, a) {
    if (!c) return c;
    const s = String(c).trim();
    if (s.startsWith('rgba') || s.startsWith('rgb')) return s;
    let h = s.replace('#', '');
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length !== 6) return s;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  /* 阅读器背景图层：打开阅读器时确保存在 */
  function ensureReaderBgLayer() {
    const reader = document.getElementById('reader');
    if (!reader) return;
    let layer = reader.querySelector('.reader-bgimg');
    const want = !!(AR && AR[document.body.getAttribute('data-theme') === 'night' ? 'dark' : 'light'].readerBg.img);
    if (!want) { if (layer) layer.style.backgroundImage = 'none'; return; }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'reader-bgimg';
      reader.insertBefore(layer, reader.firstChild);
    }
  }

  /* ───────── 主页主图注入（5.0 修复：去抖 + 内容不变绝不动 DOM，避免宿主重启抖动） ───────── */
  let _heroPending = false;
  function injectHero() {
    if (_heroPending) return;
    _heroPending = true;
    requestAnimationFrame(() => { _heroPending = false; _injectHeroNow(); });
  }
  function _injectHeroNow() {
    try {
      const body = document.getElementById('deskBody');
      if (!body) return;
      const old = body.querySelector('.ar-hero');
      const src = (AR && AR[document.body.getAttribute('data-theme') === 'night' ? 'dark' : 'light'].hero.img) || '';
      if (!src) { if (old) old.remove(); return; }
      if (old) { if (old._arHeroSrc === src) return; old._arHeroSrc = src; old.querySelector('img').src = src; return; }
      const fig = document.createElement('div');
      fig.className = 'ar-hero';
      fig._arHeroSrc = src;
      fig.innerHTML = `<img src="${escHTML(src)}" alt="">`;
      const head = body.querySelector('.h-row');
      if (head && head.nextElementSibling) body.insertBefore(fig, head.nextElementSibling);
      else if (head) head.after(fig);
      else body.insertBefore(fig, body.firstChild);
    } catch (e) { console.warn('[深读] 主图注入失败', e); }
  }
  /* 主题切换联动重涂 */
  function watchTheme() {
    new MutationObserver(() => applyAppearance()).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ───────── 通用控件 ───────── */
  function colorRow(label, key, obj) {
    const cur = obj[key] || '';
    return `<div class="ar-crow" data-k="${key}">
      <span class="ar-cl">${escHTML(label)}</span>
      <span class="ar-hex">${escHTML(cur || '—')}</span>
      <label class="ar-swatch" style="background:${escHTML(cur || '#8888')}">
        <input type="color" value="${normHex(cur, '#888888')}">
      </label>
      <button class="ar-creset" title="恢复此色默认">↺</button>
    </div>`;
  }
  function normHex(c, fb) {
    const s = String(c || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s.slice(1).split('').map(x => x + x).join('');
    if (s.startsWith('rgb')) {
      const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
      if (m) return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
    }
    return fb;
  }
  function bindColorRows(root, obj, defaults) {
    root.querySelectorAll('.ar-crow').forEach(row => {
      const k = row.dataset.k;
      const hexEl = row.querySelector('.ar-hex');
      const sw = row.querySelector('.ar-swatch');
      row.querySelector('input[type=color]').addEventListener('input', (e) => {
        obj[k] = e.target.value;
        hexEl.textContent = e.target.value;
        sw.style.background = e.target.value;
      });
      row.querySelector('.ar-creset').addEventListener('click', () => {
        const d = (defaults || {})[k] || '';
        obj[k] = d;
        hexEl.textContent = d || '—';
        sw.style.background = d || '#8888';
        row.querySelector('input[type=color]').value = normHex(d, '#888888');
      });
    });
  }
  function sliderRow(label, key, obj, min, max, step, unit) {
    return `<div class="ar-srow" data-k="${key}">
      <span class="ar-cl">${escHTML(label)}</span>
      <span class="ar-sval">${obj[key]}${unit || ''}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${obj[key]}">
    </div>`;
  }
  function bindSliderRows(root, obj) {
    root.querySelectorAll('.ar-srow').forEach(row => {
      const k = row.dataset.k;
      const val = row.querySelector('.ar-sval');
      row.querySelector('input[type=range]').addEventListener('input', (e) => {
        obj[k] = parseFloat(e.target.value);
        val.textContent = e.target.value;
      });
    });
  }
  function imgRow(label, hint) {
    return `<div class="field"><label>${escHTML(label)}</label>
      <input type="file" accept="image/*">
      <div class="ar-imgprev"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn-c ar-imgswap" style="flex:1;padding:10px;border-radius:10px;font-size:12.5px;">更换图片</button>
        <button class="btn-c ar-imgdel" style="flex:1;padding:10px;border-radius:10px;font-size:12.5px;">删除图片</button>
      </div>
      <div style="font-size:12px;color:var(--ink-3);margin-top:6px;">${escHTML(hint || '')}</div></div>`;
  }
  function readImgToDraft(file, target, cb) {
    if (file.size > 2 * 1024 * 1024) { toast('图片过大，不超过 2MB'); return; }
    const r = new FileReader();
    r.onload = () => { target.img = String(r.result); cb && cb(); };
    r.onerror = () => toast('图片读取失败');
    r.readAsDataURL(file);
  }
  function bindImgRow(root, sel, obj, onChange) {
    const wrap = root.querySelector(sel);
    if (!wrap) return;
    const file = wrap.querySelector('input[type=file]');
    const prev = wrap.querySelector('.ar-imgprev');
    const render = () => { prev.innerHTML = obj.img ? `<img src="${escHTML(obj.img)}" alt="">` : '<span class="ar-none">未设置</span>'; };
    render();
    file.addEventListener('change', () => {
      const f = file.files[0]; if (!f) return;
      readImgToDraft(f, obj, () => { render(); onChange && onChange(); });
    });
    wrap.querySelector('.ar-imgswap').addEventListener('click', () => file.click());
    wrap.querySelector('.ar-imgdel').addEventListener('click', () => { obj.img = ''; render(); onChange && onChange(); });
  }
  function segRow(label, key, obj, options) {
    return `<div class="field"><label>${escHTML(label)}</label>
      <div class="type-chips">${options.map(o => `<button class="type-chip${obj[key] === o.v ? ' sel' : ''}" data-segk="${key}" data-segv="${o.v}">${escHTML(o.l)}</button>`).join('')}</div></div>`;
  }
  function bindSegRows(root, obj, onChange) {
    root.querySelectorAll('.type-chip[data-segk]').forEach(c => c.addEventListener('click', () => {
      const k = c.dataset.segk;
      root.querySelectorAll(`.type-chip[data-segk="${k}"]`).forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
      obj[k] = c.dataset.segv;
      onChange && onChange();
    }));
  }
  function fontRow(label, key, obj) {
    return `<div class="field"><label>${escHTML(label)}</label>
      <select class="ar-select" data-fontk="${key}">${fontOptionsHtml(obj[key])}</select></div>`;
  }
  function bindFontRows(root, obj) {
    root.querySelectorAll('.ar-select[data-fontk]').forEach(sel => sel.addEventListener('change', () => {
      obj[sel.dataset.fontk] = sel.value;
    }));
  }
  /* ───────── 面板样式 ───────── */
  function ensureArCss() {
    if (document.getElementById('arPanelCss')) return;
    const st = document.createElement('style');
    st.id = 'arPanelCss';
    st.textContent = `
.ar-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:10px;}
.ar-tabs button{flex-shrink:0;padding:7px 13px;border-radius:100px;border:1px solid var(--line);background:var(--surface);color:var(--ink-2);font-size:12.5px;}
.ar-tabs button.sel{background:var(--accent);color:var(--bg);border-color:var(--accent);}
.ar-pane{display:none;}.ar-pane.sel{display:block;}
.ar-crow,.ar-srow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);}
.ar-cl{flex:1;font-size:13px;color:var(--ink-2);}
.ar-hex{font-size:11px;color:var(--ink-3);font-family:monospace;}
.ar-swatch{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);overflow:hidden;position:relative;}
.ar-swatch input[type=color]{position:absolute;inset:-6px;width:44px;height:44px;border:none;padding:0;cursor:pointer;}
.ar-creset{width:28px;height:28px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink-3);font-size:13px;}
.ar-srow input[type=range]{flex:1.2;accent-color:var(--accent);}
.ar-sval{font-size:12px;color:var(--ink-3);min-width:44px;text-align:right;}
.ar-imgprev img{max-width:180px;max-height:120px;object-fit:cover;border-radius:10px;margin-top:8px;display:block;}
.ar-none{font-size:12px;color:var(--ink-3);}
.ar-tpl{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line-soft);}
.ar-tpl .nm{flex:1;font-size:13.5px;}
.ar-tpl button{padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);font-size:12px;color:var(--ink-2);}
.ar-sec{font-size:12px;color:var(--ink-3);margin:14px 0 4px;letter-spacing:.08em;}
.ar-hero{margin:18px 0 6px;border-radius:var(--radius-lg,18px);overflow:hidden;border:1px solid var(--line-soft,rgba(0,0,0,.06));box-shadow:var(--shadow-1,0 1px 2px rgba(0,0,0,.05));aspect-ratio:16/9;background:var(--surface-2,rgba(0,0,0,.04));}
.ar-hero img{width:100%;height:100%;object-fit:cover;display:block;}
.ar-modehint{font-size:12px;color:var(--ink-3);margin:4px 0 10px;line-height:1.6;}
`;
    document.head.appendChild(st);
  }

  /* ───────── 设置面板（5.0：模板 / 通用 / 浅色 / 深色） ───────── */
  const THEME_LABELS = {
    accent: '强调色', bg: '页面背景', surface: '卡片底色', overlay: '浮层底色',
    ink: '主文字', ink2: '次文字', ink3: '弱文字', accentText: '点缀文字',
    highlight: '荧光高亮', underline: '划线颜色', line: '分隔线', stroke: '描边',
  };
  const THEME_KEYS = ['accent', 'bg', 'surface', 'overlay', 'ink', 'ink2', 'ink3', 'accentText', 'highlight', 'underline', 'line', 'stroke'];

  function openAppearanceSettings() {
    if (!window.openSheet) { toast('面板组件未就绪'); return; }
    ensureArCss();
    draft = arClone(AR);
    const pane = (id, inner) => `<div class="ar-pane" data-pane="${id}">${inner}</div>`;
    const colorsHtml = (which) =>
      THEME_KEYS.map(k => colorRow(THEME_LABELS[k] || k, k, draft[which].colors)).join('');
    const bgHtml = (which) => `
      <div class="ar-sec">主页背景</div>
      ${imgRow('主页背景图', '整个 App 主界面的页面背景，不影响阅读器')}
      ${segRow('填充方式', 'fit', draft[which].homeBg, [{ v: 'cover', l: '填满' }, { v: 'contain', l: '完整' }, { v: 'stretch', l: '拉伸' }])}
      ${sliderRow('图片不透明度', 'opacity', draft[which].homeBg, 0, 1, 0.05)}
      ${sliderRow('暗色遮罩', 'mask', draft[which].homeBg, 0, 0.8, 0.05)}
      <div class="ar-sec">主页主图</div>
      ${imgRow('主页主图', '主页顶部独立展示的图片卡片')}
      <div class="ar-sec">阅读背景</div>
      ${colorRow('阅读背景色', 'color', draft[which].readerBg)}
      ${imgRow('阅读背景图', '只作用于阅读页，设置后阅读页底色自动透明')}
      ${segRow('填充方式', 'fit', draft[which].readerBg, [{ v: 'cover', l: '填满' }, { v: 'contain', l: '完整' }, { v: 'stretch', l: '拉伸' }])}
      ${sliderRow('背景不透明度', 'opacity', draft[which].readerBg, 0.1, 1, 0.05)}`;
    const commonHtml = `
      <div class="ar-sec">排版</div>
      ${fontRow('正文字体', 'bodyFont', draft.common)}
      ${sliderRow('正文字号', 'bodySize', draft.common, 13, 26, 1)}
      ${segRow('正文对齐', 'bodyAlign', draft.common, [{ v: 'justify', l: '两端' }, { v: 'left', l: '左对齐' }])}
      ${fontRow('标题字体', 'titleFont', draft.common)}
      ${sliderRow('标题字号', 'titleSize', draft.common, 16, 34, 1)}
      ${segRow('标题对齐', 'titleAlign', draft.common, [{ v: 'center', l: '居中' }, { v: 'left', l: '左对齐' }])}
      ${sliderRow('标题字重', 'titleWeight', draft.common, 300, 800, 100)}
      <div class="ar-sec">间距</div>
      ${sliderRow('字距', 'ls', draft.common, 0, 0.2, 0.01)}
      ${sliderRow('行距', 'lh', draft.common, 1.4, 3, 0.05)}
      ${sliderRow('段距', 'pg', draft.common, 0, 20, 1)}
      ${sliderRow('上边距', 'mt', draft.common, 0, 80, 2)}
      ${sliderRow('右边距', 'mr', draft.common, 0, 80, 2)}
      ${sliderRow('下边距', 'mb', draft.common, 40, 260, 10)}
      ${sliderRow('左边距', 'ml', draft.common, 0, 80, 2)}`;
    const tplHtml = `
      <button class="btn-p" id="arTplSave" style="width:100%;padding:11px;border-radius:10px;">把当前外观存为模板</button>
      <div style="font-size:12px;color:var(--ink-3);margin:8px 0 4px;">模板会同时保存：通用排版 + 浅色外观 + 深色外观（含主题颜色、主页背景/主图、阅读背景）。应用模板时深浅两套一起切换。</div>
      <div id="arTplList" style="margin-top:8px;"></div>`;

    const html = `
      <div class="ar-tabs" id="arTabs">
        <button data-t="tpl" class="sel">模板</button>
        <button data-t="common">通用</button>
        <button data-t="light">浅色</button>
        <button data-t="dark">深色</button>
      </div>
      <div id="arSub" style="display:none;">
        <div class="ar-tabs" id="arSubTabs">
          <button data-st="colors" class="sel">颜色</button>
          <button data-st="bg">背景</button>
        </div>
      </div>
      ${pane('tpl', tplHtml)}
      ${pane('common', commonHtml)}
      ${pane('light', `<div class="ar-modehint">当前正在编辑「浅色模式」的外观。保存后可通过主页右上角的深浅模式开关切换查看。</div>
        <div data-sub="colors">${colorsHtml('light')}</div>
        <div data-sub="bg" style="display:none;">${bgHtml('light')}</div>`)}
      ${pane('dark', `<div class="ar-modehint">当前正在编辑「深色模式」的外观。保存后可通过主页右上角的深浅模式开关切换查看。</div>
        <div data-sub="colors">${colorsHtml('dark')}</div>
        <div data-sub="bg" style="display:none;">${bgHtml('dark')}</div>`)}
      <div class="btn-row" style="margin-top:14px;">
        <button class="btn-c" id="arCancel">取消</button>
        <button class="btn-p" id="arSave">保存并应用</button>
      </div>`;

    openSheet({
      title: '外观',
      html,
      onOpen: (root, mask) => {
        const tabs = root.querySelector('#arTabs');
        const subWrap = root.querySelector('#arSub');
        const subTabs = root.querySelector('#arSubTabs');
        /* 顶级标签切换：浅色/深色显示二级「颜色/背景」 */
        tabs.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-t]');
          if (!b) return;
          tabs.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          const t = b.dataset.t;
          root.querySelectorAll('.ar-pane').forEach(p => p.classList.toggle('sel', p.dataset.pane === t));
          subWrap.style.display = (t === 'light' || t === 'dark') ? '' : 'none';
          if (t === 'tpl') renderTplList(root);
        });
        subTabs.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-st]');
          if (!b) return;
          subTabs.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          const st = b.dataset.st;
          root.querySelectorAll('.ar-pane.sel [data-sub]').forEach(d => {
            d.style.display = d.dataset.sub === st ? '' : 'none';
          });
        });
        /* 绑定：浅色/深色颜色 */
        for (const which of ['light', 'dark']) {
          bindColorRows(root.querySelector(`[data-pane="${which}"] [data-sub="colors"]`), draft[which].colors, COLOR_DEF[which]);
        }
        /* 绑定：浅色/深色背景区（field 顺序：0主页背景图 1填充 2不透明度 3遮罩 4主图 5阅读背景色 6阅读背景图 7填充 8不透明度） */
        for (const which of ['light', 'dark']) {
          const bg = root.querySelector(`[data-pane="${which}"] [data-sub="bg"]`);
          const fields = bg.querySelectorAll('.field');
          bindImgRow(fields[0], '.field', draft[which].homeBg);
          bindSegRows(fields[1], draft[which].homeBg);
          bindSliderRows(fields[2], draft[which].homeBg);
          bindSliderRows(fields[3], draft[which].homeBg);
          bindImgRow(fields[4], '.field', draft[which].hero);
          bindColorRows(fields[5], draft[which].readerBg, {});
          bindImgRow(fields[6], '.field', draft[which].readerBg);
          bindSegRows(fields[7], draft[which].readerBg);
          bindSliderRows(fields[8], draft[which].readerBg);
        }
        /* 通用 */
        const cp = root.querySelector('[data-pane="common"]');
        bindFontRows(cp, draft.common);
        bindSegRows(cp, draft.common);
        bindSliderRows(cp, draft.common);
        /* 模板 */
        root.querySelector('#arTplSave').addEventListener('click', () => saveTemplate(root));
        /* 保存 */
        root.querySelector('#arCancel').addEventListener('click', closeTopSheet);
        root.querySelector('#arSave').addEventListener('click', async () => {
          const keep = { templates: AR.templates, activeTpl: AR.activeTpl };
          AR = arClone(draft);
          AR.templates = keep.templates; AR.activeTpl = keep.activeTpl;
          await saveAppearance();
          applyAppearance();
          closeTopSheet();
          toast('外观已更新（深浅两套均已保存）');
        });
        mask.addEventListener('click', (e) => { if (e.target === mask) closeTopSheet(); }, { once: true });
      },
    });
  }

  /* ───────── 模板（5.0：保存 通用 + 浅色 + 深色 全套） ───────── */
  async function saveTemplate(root) {
    openSheet({
      title: '模板名称',
      html: `<div class="field"><input type="text" id="arTplName" placeholder="如：睡前羊皮卷"></div>
        <div class="btn-row"><button class="btn-c" id="arTplCancel">取消</button><button class="btn-p" id="arTplOk">保存</button></div>`,
      onOpen: (r2, m2) => {
        r2.querySelector('#arTplCancel').addEventListener('click', closeTopSheet);
        r2.querySelector('#arTplOk').addEventListener('click', async () => {
          const nm = r2.querySelector('#arTplName').value.trim();
          if (!nm) { toast('起个名字'); return; }
          closeTopSheet();
          AR.templates.push({
            id: 'tpl_' + uid9(), name: nm, at: Date.now(),
            common: arClone(draft.common),
            light: arClone(draft.light),
            dark: arClone(draft.dark),
          });
          AR.activeTpl = '';
          await saveAppearance();
          renderTplList(root);
          toast('模板已保存（含深浅两套外观）');
        });
        m2.addEventListener('click', (e) => { if (e.target === m2) closeTopSheet(); }, { once: true });
      },
    });
  }
  function renderTplList(root) {
    const list = root.querySelector('#arTplList');
    if (!list) return;
    if (!AR.templates.length) { list.innerHTML = '<div class="ar-none" style="padding:10px 0;">还没有模板</div>'; return; }
    list.innerHTML = AR.templates.map(t => `<div class="ar-tpl" data-tid="${escHTML(t.id)}">
      <span class="nm">${escHTML(t.name)}${AR.activeTpl === t.id ? ' <span style="font-size:10px;color:var(--gold);">· 使用中</span>' : ''}</span>
      <button data-act="apply">应用</button>
      <button data-act="rename">改名</button>
      <button data-act="del">删除</button>
    </div>`).join('');
    list.querySelectorAll('.ar-tpl button').forEach(b => b.addEventListener('click', async () => {
      const tid = b.closest('.ar-tpl').dataset.tid;
      const t = AR.templates.find(x => x.id === tid);
      if (!t) return;
      const act = b.dataset.act;
      if (act === 'apply') {
        draft.common = arClone(t.common || COMMON_DEF);
        draft.light = arClone(t.light || MODE_DEF());
        draft.dark = arClone(t.dark || Object.assign(MODE_DEF(), { colors: arClone(COLOR_DEF.dark) }));
        AR.activeTpl = t.id;
        await saveAppearance();
        applyAppearance();
        closeTopSheet();
        openAppearanceSettings();
        toast('已应用「' + t.name + '」，深浅两套外观已同步切换');
      } else if (act === 'rename') {
        openSheet({
          title: '重命名模板',
          html: `<div class="field"><input type="text" id="arTplRn" value="${escHTML(t.name)}"></div>
            <div class="btn-row"><button class="btn-c" id="rnC">取消</button><button class="btn-p" id="rnO">确定</button></div>`,
          onOpen: (r2) => {
            r2.querySelector('#rnC').addEventListener('click', closeTopSheet);
            r2.querySelector('#rnO').addEventListener('click', async () => {
              const v = r2.querySelector('#arTplRn').value.trim();
              if (v) { t.name = v; await saveAppearance(); renderTplList(root); }
              closeTopSheet();
            });
          },
        });
      } else if (act === 'del') {
        const ok = await uiConfirm('删除模板', '删除「' + t.name + '」？', '删除');
        if (!ok) return;
        AR.templates = AR.templates.filter(x => x.id !== tid);
        if (AR.activeTpl === tid) AR.activeTpl = '';
        await saveAppearance();
        renderTplList(root);
        toast('已删除');
      }
    }));
  }

  /* ───────── 启动挂接 ───────── */
  function injectAppearanceBtn() {
    try {
      if (document.getElementById('deskAppearance')) return;
      const dst = document.getElementById('deskSettings');
      if (!dst || !dst.parentNode) return;
      const btn = document.createElement('button');
      btn.id = 'deskAppearance';
      btn.className = 'h-btn';
      btn.textContent = '外观';
      btn.addEventListener('click', openAppearanceSettings);
      dst.parentNode.insertBefore(btn, dst);
    } catch (e) {}
  }
  function watchDesk() {
    injectAppearanceBtn();
    injectHero();
    watchTheme();
    const body = document.getElementById('deskBody');
    if (!body || body._arWatch) return;
    body._arWatch = true;
    /* 5.0：回调里只调度一次 rAF 注入 + 内容比对，避免观察循环导致宿主频繁重启 */
    new MutationObserver(() => { injectAppearanceBtn(); injectHero(); })
      .observe(body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchDesk);
  } else {
    watchDesk();
  }
  let _tries = 0;
  const _iv = setInterval(() => {
    injectAppearanceBtn();
    injectHero();
    if (++_tries > 20 || document.getElementById('deskAppearance')) clearInterval(_iv);
  }, 500);
  window.DeepReadAppearance = {
    open: openAppearanceSettings,
    reload: loadAppearance,
    get: () => AR,
  };
  loadAppearance();
})();
