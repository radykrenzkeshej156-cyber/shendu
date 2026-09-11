/* ============================================================
   深读 4.9 · appearance.js —— 外观与阅读美化系统
   ------------------------------------------------------------
   五个彼此独立的概念，数据与 UI 全部解耦：
   ① App 主题（浅色/深色完整颜色配置，存于 settings:appearance）
   ② 主页背景图（整个 App 主界面的页面背景，≠阅读背景）
   ③ 主页主图（主页独立展示的图片卡片，≠主页背景）
   ④ 阅读样式（阅读背景色/图 + 正文 + 章节标题）
   ⑤ 阅读间距（字距/行距/段距 + 四向页边距）
   用户模板：保存 ④+⑤ 的组合，可应用/重命名/删除。
   实现方式：运行时注入 <style id="arStyle"> 覆盖 Design Token，
   不改动 styles.css 的原有规则。
   ============================================================ */
'use strict';
(function () {
  const A = window.AiPhone || window.A;
  if (!A) return;

  /* ───────── 默认值 ───────── */
  const AR_DEF = {
    v: 1,
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
    homeBg: { img: '', fit: 'cover', opacity: 1, mask: 0 },
    hero: { img: '' },
    reader: {
      bgColor: '', bgImg: '', fit: 'cover', bgOpacity: 1,
      bodyFont: '', bodySize: 17, bodyColor: '', bodyAlign: 'justify',
      titleFont: '', titleSize: 22, titleColor: '', titleAlign: 'center', titleWeight: '500',
      ls: 0, lh: 2.1, pg: 6, mt: 26, mr: 26, mb: 130, ml: 26,
    },
    templates: [],
    activeTpl: '',
  };
  const KEY = 'appearance';
  let AR = null;          // 已保存的配置
  let draft = null;       // 设置面板里正在编辑的草稿

  function arClone(o) { return JSON.parse(JSON.stringify(o)); }
  function arDefaults() { return arClone(AR_DEF); }
  function mergeDef(saved) {
    const d = arDefaults();
    if (!saved || typeof saved !== 'object') return d;
    const out = d;
    for (const k of ['light', 'dark', 'homeBg', 'hero', 'reader']) {
      if (saved[k] && typeof saved[k] === 'object') out[k] = Object.assign({}, d[k], saved[k]);
    }
    if (Array.isArray(saved.templates)) out.templates = saved.templates;
    out.activeTpl = saved.activeTpl || '';
    return out;
  }

  async function loadAppearance() {
    try {
      const rows = await A.db.list('settings', { limit: 1000 });
      const rec = (rows || []).map(r => (r && r.data) || r).find(x => x && x.id === KEY);
      AR = mergeDef(rec);
    } catch (e) { AR = arDefaults(); }
    applyAppearance();
  }
  async function saveAppearance() {
    try {
      const rows = await A.db.list('settings', { limit: 1000 });
      const found = (rows || []).find(r => r && ((r.data && r.data.id === KEY) || r.id === KEY));
      const recId = found ? (found.id || (found.data && found.data.id)) : null;
      if (found && recId != null && found.data) await A.db.update('settings', found.id, AR);
      else if (found && recId === KEY) await A.db.update('settings', found.id, AR);
      else await A.db.create('settings', AR);
    } catch (e) { console.warn('[深读] 外观保存失败', e); }
  }

  /* ───────── 字体选项 ───────── */
  const FONT_OPTS = [
    { v: '', label: '默认衬线', stack: 'var(--font-serif)' },
    { v: 'songti', label: '宋体', stack: '"Songti SC", "Noto Serif SC", serif' },
    { v: 'kai', label: '楷体', stack: '"Kaiti SC", "KaiTi", serif' },
    { v: 'hei', label: '黑体', stack: '"PingFang SC", "Heiti SC", sans-serif' },
  ];
  function fontStack(v) {
    const f = FONT_OPTS.find(x => x.v === v);
    if (f) return f.stack;
    if (v === 'custom') return "'RdrCustom', var(--font-serif)";
    return 'var(--font-serif)';
  }
  function fontLabel(v) {
    if (v === 'custom') {
      const c = (typeof S !== 'undefined' && S.coset && S.coset.rdrFontName) ? S.coset.rdrFontName : '导入的字体';
      return '自定义 · ' + c;
    }
    const f = FONT_OPTS.find(x => x.v === v);
    return f ? f.label : '默认衬线';
  }
  function hasCustomFont() {
    try { return !!(S.coset && S.coset.rdrFontB64 && S.coset.rdrFontName); } catch (e) { return false; }
  }
  function fontOptionsHtml(v) {
    let opts = FONT_OPTS.map(f => `<option value="${f.v}"${v === f.v ? ' selected' : ''}>${f.label}</option>`).join('');
    if (hasCustomFont()) opts += `<option value="custom"${v === 'custom' ? ' selected' : ''}>${escHTML(fontLabel('custom'))}</option>`;
    return opts;
  }
  function escHTML(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ───────── 应用：注入覆盖样式 ───────── */
  function applyAppearance() {
    if (!AR) return;
    let st = document.getElementById('arStyle');
    if (!st) { st = document.createElement('style'); st.id = 'arStyle'; document.head.appendChild(st); }
    const L = AR.light, D = AR.dark, R = AR.reader, H = AR.homeBg;
    const bgLayer = (img, fit, op, mask, sel) => {
      if (!img) return '';
      const size = fit === 'contain' ? 'contain' : fit === 'stretch' ? '100% 100%' : 'cover';
      const maskLayer = mask > 0 ? `, linear-gradient(rgba(0,0,0,${mask}),rgba(0,0,0,${mask}))` : '';
      return `${sel}{background-image:url("${img}")${maskLayer} !important;background-size:${size} !important;background-position:center !important;background-repeat:no-repeat !important;background-color:transparent !important;opacity:${op} !important;}`;
    };
    let css = '';
    /* ① 浅色主题颜色（完整独立配置，不是反色） */
    css += `[data-theme="day"]{--accent:${L.accent};--bg:${L.bg};--bg-reader:${L.bg};--surface:${hexA(L.surface,.66)};--surface-2:${hexA(L.overlay,.8)};--glass-strong:${hexA(L.overlay,.84)};--glass:${hexA(L.surface,.6)};--ink:${L.ink};--ink-2:${L.ink2};--ink-3:${L.ink3};--gold:${L.accentText};--accent-text:${L.accentText};--line:${L.line};--line-soft:${L.stroke};--glass-border:${L.stroke};--accent-soft:${hexA(L.accent,.08)};}`;
    css += `[data-theme="day"] mark.rl-resonate{background:${hexA(L.highlight,.34)} !important;}
[data-theme="day"] mark.rl-coread{text-decoration-color:${hexA(L.underline,.8)} !important;}
[data-theme="day"] mark.rl-insight{text-decoration-color:${hexA(L.underline,.55)} !important;}
[data-theme="day"] mark.rl-question{text-decoration-color:${hexA(L.highlight,.6)} !important;}`;
    /* ① 深色主题颜色（独立配置） */
    css += `[data-theme="night"]{--accent:${D.accent};--bg:${D.bg};--bg-reader:${D.bg};--surface:${hexA(D.surface,.55)};--surface-2:${hexA(D.overlay,.6)};--glass-strong:${hexA(D.overlay,.82)};--glass:${hexA(D.surface,.58)};--ink:${D.ink};--ink-2:${D.ink2};--ink-3:${D.ink3};--gold:${D.accentText};--accent-text:${D.accentText};--line:${D.line};--line-soft:${D.stroke};--glass-border:${D.stroke};--accent-soft:${hexA(D.accent,.1)};}`;
    css += `[data-theme="night"] mark.rl-resonate{background:${hexA(D.highlight,.3)} !important;}
[data-theme="night"] mark.rl-coread{text-decoration-color:${hexA(D.underline,.8)} !important;}
[data-theme="night"] mark.rl-insight{text-decoration-color:${hexA(D.underline,.55)} !important;}
[data-theme="night"] mark.rl-question{text-decoration-color:${hexA(D.highlight,.6)} !important;}`;
    /* ② 主页背景图（只作用于主界面 pages 层，绝不碰阅读器） */
    if (H.img) {
      css += `.pages::before{background:transparent !important;}
.pages-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;}`;
      const size = H.fit === 'contain' ? 'contain' : '100% 100%';
      css += `.pages-bg{background-image:url("${H.img}");background-size:${H.fit === 'stretch' ? '100% 100%' : (H.fit === 'contain' ? 'contain' : 'cover')};background-position:center;background-repeat:no-repeat;opacity:${H.opacity};}`;
      if (H.mask > 0) css += `.pages-bg::after{content:'';position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,${H.mask}),rgba(0,0,0,${H.mask}));}`;
      css += bgLayer(H.img, H.fit, H.opacity, H.mask, '.pages::before');
    }
    /* ④⑤ 阅读样式与间距（只作用于 .reader 内部） */
    const bgc = R.bgColor || 'var(--bg-reader)';
    css += `.reader{background:${bgc} !important;}`;
    if (R.bgImg) {
      const size = R.fit === 'contain' ? 'contain' : '100% 100%';
      css += `.reader-bgimg{position:absolute;inset:0;z-index:0;pointer-events:none;background-image:url("${R.bgImg}");background-size:${size};background-position:center;background-repeat:no-repeat;opacity:${R.bgOpacity};}`;
      if (R.bgOpacity >= .99) css += `.reader-bgimg::after{content:'';position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,${R.bgOpacity > 1 ? 0 : 0}),rgba(0,0,0,0));}`;
    } else css += `.reader-bgimg{display:none !important;}`;
    css += `.reader-scroll{position:relative;z-index:1;}
.reader-inner{padding:${R.mt}px ${R.mr}px ${R.mb}px ${R.ml}px !important;}
.para{font-family:${fontStack(R.bodyFont)} !important;font-size:${R.bodySize}px !important;${R.bodyColor ? `color:${R.bodyColor} !important;` : ''}letter-spacing:${R.ls}em !important;line-height:${R.lh} !important;text-align:${R.bodyAlign} !important;margin:0 0 ${R.pg}px !important;}
.para.head{font-family:${fontStack(R.titleFont)} !important;font-size:${R.titleSize}px !important;${R.titleColor ? `color:${R.titleColor} !important;` : ''}text-align:${R.titleAlign} !important;font-weight:${R.titleWeight} !important;letter-spacing:${R.ls}em !important;line-height:${R.lh} !important;margin:38px 0 ${Math.max(R.pg, 14)}px !important;}
.chap-title{font-family:${fontStack(R.titleFont)} !important;font-size:${R.titleSize}px !important;${R.titleColor ? `color:${R.titleColor} !important;` : ''}text-align:${R.titleAlign} !important;font-weight:${R.titleWeight} !important;letter-spacing:.02em;}
.chap-num{color:${R.titleColor || 'var(--ink-3)'} !important;}`;
    st.textContent = css;
    ensureReaderBgLayer();
  }
  /* hex → rgba（支持 #rgb/#rrggbb 与已是 rgba 的输入） */
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
  /* 阅读器背景图层（打开阅读器时确保存在） */
  function ensureReaderBgLayer() {
    const reader = document.getElementById('reader');
    if (!reader) return;
    let layer = reader.querySelector('.reader-bgimg');
    if (!AR.reader.bgImg) { if (layer) layer.style.backgroundImage = 'none'; return; }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'reader-bgimg';
      reader.insertBefore(layer, reader.firstChild);
    }
  }

  /* ───────── 主页主图：包装 renderDesk，在标题行下方注入图片卡片 ───────── */
  const _origRenderDesk = window.renderDesk;
  window.renderDesk = async function (...args) {
    const r = await _origRenderDesk.apply(this, args);
    try {
      if (AR && AR.hero && AR.hero.img) {
        const body = document.getElementById('deskBody');
        if (body && !body.querySelector('.ar-hero')) {
          const fig = document.createElement('div');
          fig.className = 'ar-hero';
          fig.innerHTML = `<img src="${escHTML(AR.hero.img)}" alt="">`;
          body.insertBefore(fig, body.firstChild);
        }
      }
    } catch (e) {}
    return r;
  };
  /* 主题切换时联动重涂（浅色/深色主题各自独立颜色一起切换） */
  const _origApplyTheme = window.applyTheme;
  window.applyTheme = function (t) {
    _origApplyTheme(t);
    applyAppearance();
  };

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
        const d = (defaults || AR_DEF)[k] || '';
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
  function bindSliderRows(root, obj, unit) {
    root.querySelectorAll('.ar-srow').forEach(row => {
      const k = row.dataset.k;
      const val = row.querySelector('.ar-sval');
      row.querySelector('input[type=range]').addEventListener('input', (e) => {
        obj[k] = parseFloat(e.target.value);
        val.textContent = e.target.value + (unit || '');
        draft._touchReader = true;
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
    const render = () => { prev.innerHTML = obj.img ? `<img src="${escHTML(obj.img)}" alt="">` : '<span class="ar-none">未设置 · 使用页面背景色</span>'; };
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
  /* ───────── 面板样式（自注入，不动 styles.css） ───────── */
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
.ar-srow input[type=range]{flex:1.2;}
.ar-sval{font-size:12px;color:var(--ink-3);min-width:44px;text-align:right;}
.ar-imgprev img{max-width:100%;border-radius:10px;margin-top:8px;}
.ar-none{font-size:12px;color:var(--ink-3);}
.ar-tpl{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line-soft);}
.ar-tpl .nm{flex:1;font-size:13.5px;}
.ar-tpl button{padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);font-size:12px;color:var(--ink-2);}
.ar-sec{font-size:12px;color:var(--ink-3);margin:14px 0 4px;letter-spacing:.08em;}
`;
    document.head.appendChild(st);
  }

  /* ───────── 设置面板 ───────── */
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
    draft._touchReader = false;
    const pane = (id, inner) => `<div class="ar-pane" data-pane="${id}">${inner}</div>`;
    const themeHtml = (which, title) =>
      `<div class="ar-sec">${title}</div>` + THEME_KEYS.map(k => colorRow(THEME_LABELS[k] || k, k, draft[which])).join('');
    const html = `
      <div class="ar-tabs" id="arTabs">
        <button data-t="theme" class="sel">主题颜色</button>
        <button data-t="home">主页背景</button>
        <button data-t="hero">主页主图</button>
        <button data-t="reader">阅读样式</button>
        <button data-t="space">阅读间距</button>
        <button data-t="tpl">模板</button>
      </div>
      ${pane('theme',
        themeHtml('light', '雾白（浅色）主题') + themeHtml('dark', '炭黑（深色）主题'))}
      ${pane('home', `
        ${imgRow('主页背景图', '整个 App 主界面的页面背景，不影响阅读器')}
        ${segRow('填充方式', 'fit', draft.homeBg, [{ v: 'cover', l: '填满' }, { v: 'contain', l: '完整' }, { v: 'stretch', l: '拉伸' }])}
        ${sliderRow('图片不透明度', 'opacity', draft.homeBg, 0, 1, 0.05)}
        ${sliderRow('暗色遮罩', 'mask', draft.homeBg, 0, 0.8, 0.05)}`)}
      ${pane('hero', imgRow('主页主图', '主页顶部独立展示的图片卡片，删除后还原默认标题'))}
      ${pane('reader', `
        <div class="ar-sec">背景</div>
        ${colorRow('阅读背景色', 'bgColor', draft.reader)}
        ${imgRow('阅读背景图', '只作用于阅读页')}
        ${segRow('填充方式', 'fit', draft.reader, [{ v: 'cover', l: '填满' }, { v: 'contain', l: '完整' }, { v: 'stretch', l: '拉伸' }])}
        ${sliderRow('背景不透明度', 'bgOpacity', draft.reader, 0.1, 1, 0.05)}
        <div class="ar-sec">正文</div>
        ${fontRow('正文字体', 'bodyFont', draft.reader)}
        ${sliderRow('字号', 'bodySize', draft.reader, 13, 26, 1, 'px')}
        ${colorRow('正文颜色', 'bodyColor', draft.reader)}
        ${segRow('对齐', 'bodyAlign', draft.reader, [{ v: 'justify', l: '两端' }, { v: 'left', l: '左对齐' }])}
        <div class="ar-sec">章节标题</div>
        ${fontRow('标题字体', 'titleFont', draft.reader)}
        ${sliderRow('字号', 'titleSize', draft.reader, 16, 34, 1, 'px')}
        ${colorRow('标题颜色', 'titleColor', draft.reader)}
        ${segRow('对齐', 'titleAlign', draft.reader, [{ v: 'center', l: '居中' }, { v: 'left', l: '左对齐' }])}
        ${sliderRow('字重', 'titleWeight', draft.reader, 300, 800, 100)}`)}
      ${pane('space', `
        ${sliderRow('字距', 'ls', draft.reader, 0, 0.2, 0.01, 'em')}
        ${sliderRow('行距', 'lh', draft.reader, 1.4, 3, 0.05)}
        ${sliderRow('段距', 'pg', draft.reader, 0, 20, 1, 'px')}
        ${sliderRow('上边距', 'mt', draft.reader, 0, 80, 2, 'px')}
        ${sliderRow('右边距', 'mr', draft.reader, 0, 80, 2, 'px')}
        ${sliderRow('下边距', 'mb', draft.reader, 40, 260, 10, 'px')}
        ${sliderRow('左边距', 'ml', draft.reader, 0, 80, 2, 'px')}`)}
      ${pane('tpl', `
        <button class="btn-p" id="arTplSave" style="width:100%;padding:11px;border-radius:10px;">把当前「阅读样式 + 间距」存为模板</button>
        <div id="arTplList" style="margin-top:8px;"></div>
        <div style="font-size:12px;color:var(--ink-3);margin-top:8px;">模板只保存阅读相关设置（背景/字体/间距），不包含主题颜色与主页背景。</div>`)}
      <div class="btn-row" style="margin-top:14px;">
        <button class="btn-c" id="arCancel">取消</button>
        <button class="btn-p" id="arSave">保存并应用</button>
      </div>`;

    openSheet({
      title: '外观',
      html,
      onOpen: (root, mask) => {
        /* 标签页切换 */
        const tabs = root.querySelector('#arTabs');
        tabs.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-t]');
          if (!b) return;
          tabs.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          root.querySelectorAll('.ar-pane').forEach(p => p.classList.toggle('sel', p.dataset.pane === b.dataset.t));
          if (b.dataset.t === 'tpl') renderTplList(root);
        });
        /* 主题颜色 */
        bindColorRows(root.querySelector('[data-pane="theme"]'), null, null);
        root.querySelectorAll('[data-pane="theme"] .ar-crow').forEach(row => {
          /* 两套主题的同名 key 分开绑定 */
        });
        bindThemeColors(root);
        /* 主页背景 / 主图 */
        bindImgRow(root.querySelector('[data-pane="home"]'), '.field', draft.homeBg);
        bindSegRows(root.querySelector('[data-pane="home"]'), draft.homeBg);
        bindSliderRows(root.querySelector('[data-pane="home"]'), draft.homeBg);
        bindImgRow(root.querySelector('[data-pane="hero"]'), '.field', draft.hero);
        /* 阅读样式 */
        const rp = root.querySelector('[data-pane="reader"]');
        bindColorRows(rp, draft.reader, AR_DEF.reader);
        bindImgRow(rp, '.field', draft.reader);
        bindSegRows(rp, draft.reader);
        bindSliderRows(rp, draft.reader);
        bindFontRows(rp, draft.reader);
        /* 间距 */
        bindSliderRows(root.querySelector('[data-pane="space"]'), draft.reader);
        /* 模板 */
        root.querySelector('#arTplSave').addEventListener('click', () => saveTemplate(root));
        /* 底部按钮 */
        root.querySelector('#arCancel').addEventListener('click', closeTopSheet);
        root.querySelector('#arSave').addEventListener('click', async () => {
          const keepTpl = { templates: AR.templates, activeTpl: AR.activeTpl };
          AR = arClone(draft);
          AR.templates = keepTpl.templates; AR.activeTpl = keepTpl.activeTpl;
          delete AR._touchReader;
          await saveAppearance();
          applyAppearance();
          closeTopSheet();
          toast('外观已更新');
        });
        mask.addEventListener('click', (e) => { if (e.target === mask) closeTopSheet(); }, { once: true });
      },
    });
  }
  /* 主题颜色的两套（light/dark）分开绑定 */
  function bindThemeColors(root) {
    {
      const pane = root.querySelector('[data-pane="theme"]');
      /* 第 0 个 .ar-sec 之后直到下一个 .ar-sec 之前是 light，其后是 dark */
      pane.querySelectorAll('.ar-crow').forEach(row => {
        let prev = row.previousElementSibling;
        while (prev) { if (prev.classList && prev.classList.contains('ar-sec')) { cur = prev.textContent.includes('炭黑') ? 'dark' : 'light'; break; } prev = prev.previousElementSibling; }
        const k = row.dataset.k;
        const hexEl = row.querySelector('.ar-hex');
        const sw = row.querySelector('.ar-swatch');
        row.querySelector('input[type=color]').addEventListener('input', (e) => {
          draft[which][k] = e.target.value;
          hexEl.textContent = e.target.value;
          sw.style.background = e.target.value;
        });
        row.querySelector('.ar-creset').addEventListener('click', () => {
          const d = AR_DEF[which][k];
          draft[which][k] = d;
          hexEl.textContent = d;
          sw.style.background = d;
          row.querySelector('input[type=color]').value = normHex(d, '#888888');
        });
      });
    });
  }

  /* ───────── 模板（保存 ④阅读样式 + ⑤间距） ───────── */
  async function saveTemplate(root) {
    const list = root.querySelector('#arTplList');
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
          AR.templates.push({ id: 'tpl_' + uid(), name: nm, reader: arClone(draft.reader), at: Date.now() });
          await saveAppearance();
          renderTplList(root);
          toast('模板已保存');
        });
        m2.addEventListener('click', (e) => { if (e.target === m2) closeTopSheet(); }, { once: true });
      },
    });
  }
  function renderTplList(root) {
    const list = root.querySelector('#arTplList');
    if (!list) return;
    if (!AR.templates.length) { list.innerHTML = '<div class="ar-none" style="padding:10px 0;">还没有模板</div>'; return; }
    list.innerHTML = AR.templates.map(t => `<div class="ar-tpl" data-tid="${esc(t.id)}">
      <span class="nm">${esc(t.name)}</span>
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
        draft.reader = arClone(t.reader);
        AR.activeTpl = t.id;
        await saveAppearance();
        applyAppearance();
        toast('已应用「' + t.name + '」，面板内数值已同步');
      } else if (act === 'rename') {
        openSheet({
          title: '重命名模板',
          html: `<div class="field"><input type="text" id="arTplRn" value="${esc(t.name)}"></div>
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
  /* 「此刻」页设置按钮旁注入「外观」入口 */
  const _origRenderDesk2 = window.renderDesk;
  window.renderDesk = async function (...args) {
    const r = await _origRenderDesk2.apply(this, args);
    try {
      const dst = document.getElementById('deskSettings');
      if (dst && !document.getElementById('deskAppearance')) {
        const btn = document.createElement('button');
        btn.id = 'deskAppearance';
        btn.className = 'h-btn';
        btn.textContent = '外观';
        btn.addEventListener('click', openAppearanceSettings);
        dst.parentNode.insertBefore(btn, dst);
      }
    } catch (e) {}
    return r;
  };
  window.DeepReadAppearance = {
    open: openAppearanceSettings,
    reload: loadAppearance,
    get: () => AR,
  };
  loadAppearance();
})();