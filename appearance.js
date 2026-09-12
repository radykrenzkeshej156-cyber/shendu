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
    /* 5.1：手帐封面（思想页两本手帐：u=理解 q=问题） */
    jCover: { u: '', q: '' },
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

  /* 5.5：加载外观时把 media-store:// 引用换回 dataURL 存入内存副本，
     保证面板预览和样式渲染直接可用；保存时 compactImages 再转回引用。
     （此前引用换不回图片 = 面板显示空 = 看起来像被重置） */
  async function hydrateImages(rec) {
    for (const m of ['light', 'dark']) {
      const M = rec[m];
      if (!M) continue;
      if (M.homeBg) M.homeBg.img = await resolveImg(M.homeBg.img);
      if (M.hero) M.hero.img = await resolveImg(M.hero.img);
      if (M.readerBg) M.readerBg.img = await resolveImg(M.readerBg.img);
      if (M.jCover) {
        M.jCover.u = await resolveImg(M.jCover.u);
        M.jCover.q = await resolveImg(M.jCover.q);
      }
    }
    return rec;
  }

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
        if (s.jCover && typeof s.jCover === 'object') out[m].jCover = Object.assign(out[m].jCover, s.jCover);
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
      AR = await hydrateImages(mergeDef(rec));
    } catch (e) { AR = AR_DEF(); }
    applyAppearance();
  }
  let lastSaveErr = '';
  async function saveAppearance() {
    if (!AR) return false;
    AR.id = KEY; AR.v = 2;
    try {
      const rows = await window.AiPhone.db.list('settings', { limit: 1000 });
      const norm = (rows || []).map(x => (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') ? { rid: x.id, data: x.data } : { rid: (x && x.id) || null, data: x });
      const found = norm.find(r => r.data && r.data.id === KEY);
      if (found && found.rid) await window.AiPhone.db.update('settings', found.rid, AR);
      else await window.AiPhone.db.create('settings', AR);
      lastSaveErr = '';
      /* 双保险：主题模式同时写一份到 localStorage，宿主重启后首帧前即可恢复 */
      try { localStorage.setItem('deepread_theme', document.body.getAttribute('data-theme') === 'night' ? 'night' : 'day'); } catch (e2) {}
      return true;
    } catch (e) {
      lastSaveErr = (e && (e.message || String(e))) || '未知错误';
      console.warn('[深读] 外观保存失败', e);
      return false;
    }
  }
  /* 5.6.2：保存后回读校验——确认记录真的写进去了、图片字段真的在库里。
     之前保存失败被静默吞掉，用户只能看到「没生效」，无从区分渲染问题还是存储问题 */
  function countImgSlots(rec) {
    let n = 0;
    for (const m of ['light', 'dark']) {
      const M = (rec && rec[m]) || {};
      if (M.homeBg && M.homeBg.img) n++;
      if (M.hero && M.hero.img) n++;
      if (M.readerBg && M.readerBg.img) n++;
      if (M.jCover && M.jCover.u) n++;
      if (M.jCover && M.jCover.q) n++;
    }
    return n;
  }
  async function verifySaved() {
    try {
      const rows = await window.AiPhone.db.list('settings', { limit: 1000 });
      const norm = (rows || []).map(x => (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') ? x.data : x);
      const rec = norm.find(x => x && x.id === KEY);
      if (!rec) return '库里找不到外观记录（写入未成功）';
      const want = countImgSlots(AR), have = countImgSlots(rec);
      if (have < want) return `图片只写入 ${have}/${want} 张（记录可能被存储层截断）`;
      return '';
    } catch (e) { return '校验读取失败：' + ((e && e.message) || e); }
  }

  /* ───────── 字体库（5.4：独立 fonts 集合，一条字体一条记录） ─────────
     5.3 仍重启的根因：字体以数十 MB base64 存在 settings 集合里，
     而 App 每次保存都会 db.list('settings') 全量读集合 —— 每保存一次
     就要解析一次巨型记录，宿主内存压力过大被强制重启。
     现在：字体存独立 'fonts' 集合（settings 彻底瘦身），
     启动时自动迁移旧记录并删除，旧 coset 字体同样收编后清空原字段。 */
  /* 5.6：字体大文件改走媒体库 media.put（Blob 落盘，单件上限 25MB），
     db（fonts 集合）里只存 {id,name,ref,size} 引用记录——彻底避开
     「几十 MB base64 写 db 压垮宿主」。加载时 media.get 换回 base64 注入。
     媒体库不可用时回退：小于 8MB 的字体仍可走 db 存 b64。 */
  let FONTLIB = [];       // [{id, name, ref?, b64?, size, at}]（ref 与 b64 至少有其一）
  const fontB64Cache = new Map();
  let fontlibLoaded = false;

  async function getFontB64(f) {
    if (f.b64) return f.b64;
    if (fontB64Cache.has(f.id)) return fontB64Cache.get(f.id);
    if (f.ref && window.AiPhone.media && window.AiPhone.media.get) {
      try {
        const r = await window.AiPhone.media.get({ ref: f.ref });
        const d = String((r && r.dataUrl) || '');
        const b64 = d.split(',')[1] || '';
        fontB64Cache.set(f.id, b64);
        return b64;
      } catch (e) { console.warn('[深读] 字体读取失败', f.name, e); }
    }
    return '';
  }
  async function loadFontLib() {
    try {
      const rows = await window.AiPhone.db.list('fonts', { limit: 100 });
      FONTLIB = (rows || []).map(r => r.data).filter(f => f && f.id && (f.b64 || f.ref));
    } catch (e) { FONTLIB = []; }
    /* 迁移：旧版 settings:fontlib / settings:coread 里的巨型 base64 → 媒体库，然后清除旧记录 */
    try {
      const srows = await window.AiPhone.db.list('settings', { limit: 1000 });
      const norm = (srows || []).map(x => (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') ? { rid: x.id, data: x.data } : { rid: (x && x.id) || null, data: x });
      const legacy = norm.find(r => r.data && r.data.id === 'fontlib');
      if (legacy && Array.isArray(legacy.data.fonts) && legacy.data.fonts.length) {
        for (const f of legacy.data.fonts) {
          if (f && f.b64 && !FONTLIB.some(x => x.name === f.name)) {
            const ref = await putFont(f.b64);
            FONTLIB.push({ id: f.id || ('font_' + uid9()), name: f.name || '导入的字体', ref, b64: ref ? undefined : f.b64, size: f.b64.length, at: f.at || Date.now() });
          }
        }
        await window.AiPhone.db.delete('settings', legacy.rid);
        await persistFontLib();
      }
      const coread = norm.find(r => r.data && r.data.id === 'coread');
      if (coread && coread.data.rdrFontB64) {
        if (!FONTLIB.some(f => f.name === coread.data.rdrFontName)) {
          const ref = await putFont(coread.data.rdrFontB64);
          FONTLIB.push({ id: 'font_' + uid9(), name: coread.data.rdrFontName || '导入的字体', ref, b64: ref ? undefined : coread.data.rdrFontB64, size: coread.data.rdrFontB64.length, at: Date.now() });
          await persistFontLib();
        }
        coread.data.rdrFontB64 = ''; coread.data.rdrFontName = '';
        await window.AiPhone.db.update('settings', coread.rid, coread.data);
      }
    } catch (e) { console.warn('[深读] 字体库迁移失败', e); }
    fontlibLoaded = true;
    injectFontFaces();
  }
  async function putFont(b64) {
    try {
      const r = await window.AiPhone.media.put({ dataUrl: 'data:font/ttf;base64,' + b64 });
      if (r && r.ref) return r.ref;
    } catch (e) { console.warn('[深读] media.put 失败', e); }
    return null;
  }
  /* 增删字体：有引用走媒体库删除；记录按单条增删，不触碰 settings */
  async function persistFontLib() {
    try {
      const rows = await window.AiPhone.db.list('fonts', { limit: 100 });
      const keep = new Set(FONTLIB.map(f => f.id));
      for (const r of rows) {
        if (r.data && r.data.id && !keep.has(r.data.id)) {
          if (r.data.ref && window.AiPhone.media && window.AiPhone.media.delete) {
            try { await window.AiPhone.media.delete({ ref: r.data.ref }); } catch (e) {}
          }
          await window.AiPhone.db.delete('fonts', r.id);
        }
      }
      for (const f of FONTLIB) {
        const found = rows.find(r => r.data && r.data.id === f.id);
        if (found) await window.AiPhone.db.update('fonts', found.id, f);
        else await window.AiPhone.db.create('fonts', f);
      }
    } catch (e) { console.warn('[深读] 字体库保存失败', e); }
  }
  /* 为库中每个字体注入 @font-face（异步：引用需先换回 base64） */
  let _faceSeq = 0;
  async function injectFontFaces() {
    const seq = ++_faceSeq;
    let st = document.getElementById('arFontFaces');
    if (!st) { st = document.createElement('style'); st.id = 'arFontFaces'; document.head.appendChild(st); }
    const parts = [];
    for (const f of FONTLIB) {
      const b64 = await getFontB64(f);
      if (seq !== _faceSeq) return;
      if (b64) parts.push(`@font-face{font-family:'ARFont_${f.id}';src:url(data:font/ttf;base64,${b64});font-display:swap;}`);
    }
    if (seq !== _faceSeq) return;
    st.textContent = parts.join('\n');
  }
  function fontStack(v) {
    const f = FONTLIB.find(x => x.id === v);
    if (f) return `'ARFont_${f.id}', var(--font-serif), serif`;
    return 'var(--font-serif)';
  }
  function fontOptionsHtml(v) {
    let opts = `<option value=""${!v ? ' selected' : ''}>默认衬线</option>`;
    for (const f of FONTLIB) opts += `<option value="${escHTML(f.id)}"${v === f.id ? ' selected' : ''}>${escHTML(f.name)}</option>`;
    return opts;
  }
  /* 字体库管理 UI：导入 + 列表（删除） */
  function fontLibHtml() {
    return `<div class="ar-sec">字体库</div>
      <div class="field">
        <label>导入字体文件（.ttf / .otf / .woff / .woff2，最大 25MB）</label>
        <input type="file" id="arFontFile" accept=".ttf,.otf,.woff,.woff2">
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn-c" id="arFontAdd" style="flex:1;padding:10px;border-radius:10px;font-size:12.5px;">导入到字体库</button>
        </div>
        <div id="arFontList" style="margin-top:8px;"></div>
      </div>`;
  }
  function renderFontLib(root) {
    const list = root.querySelector('#arFontList');
    if (!list) return;
    if (!FONTLIB.length) { list.innerHTML = '<div class="ar-none">字体库是空的</div>'; return; }
    list.innerHTML = FONTLIB.map(f => `<div class="ar-tpl" data-fid="${escHTML(f.id)}">
      <span class="nm">${escHTML(f.name)}<span style="font-size:10px;color:var(--ink-3);"> · ${(((f.size || (f.b64 ? f.b64.length : 0))) * 0.75 / 1048576).toFixed(1)}MB</span></span>
      <button data-fact="del">删除</button>
    </div>`).join('');
    list.querySelectorAll('button[data-fact="del"]').forEach(b => b.addEventListener('click', async () => {
      const fid = b.closest('.ar-tpl').dataset.fid;
      const f = FONTLIB.find(x => x.id === fid);
      const ok = await uiConfirm('删除字体', '删除「' + (f ? f.name : '') + '」？正在使用它的排版会回退为默认衬线。', '删除');
      if (!ok) return;
      FONTLIB = FONTLIB.filter(x => x.id !== fid);
      await persistFontLib();
      injectFontFaces();
      /* 已选中的字体被删则回退默认 */
      for (const k of ['bodyFont', 'titleFont']) {
        if (draft.common[k] === fid) draft.common[k] = '';
      }
      if (AR.common.bodyFont === fid) AR.common.bodyFont = '';
      if (AR.common.titleFont === fid) AR.common.titleFont = '';
      await saveAppearance();
      applyAppearance();
      renderFontLib(root);
      /* 同步刷新两个字体下拉框 */
      root.querySelectorAll('.ar-select[data-fontk]').forEach(sel => {
        const k = sel.dataset.fontk;
        sel.innerHTML = fontOptionsHtml(draft.common[k]);
      });
      toast('已删除');
    }));
  }
  function bindFontLib(root) {
    const file = root.querySelector('#arFontFile');
    const addBtn = root.querySelector('#arFontAdd');
    if (!file || !addBtn) return;
    addBtn.addEventListener('click', () => {
      const f = file.files && file.files[0];
      if (!f) { toast('先选择字体文件'); return; }
      if (f.size > 25 * 1024 * 1024) { toast('字体过大，媒体库上限 25MB'); return; }
      addBtn.disabled = true;
      toast('正在导入字体…');
      const r = new FileReader();
      r.onload = async () => {
        try {
          const dataUrl = String(r.result || '');
          const b64 = dataUrl.split(',')[1] || '';
          if (!b64) { toast('字体读取失败'); return; }
          /* 5.6：大文件走媒体库 Blob 落盘；db 只存引用记录（几十字节） */
          const ref = await putFont(b64);
          const rec = {
            id: 'font_' + uid9(), name: f.name,
            ref: ref || undefined,
            b64: ref ? undefined : (b64.length <= 8 * 1024 * 1024 ? b64 : undefined),
            size: b64.length, at: Date.now(),
          };
          if (!rec.ref && !rec.b64) { toast('导入失败：媒体库不可用且字体超过 8MB'); return; }
          FONTLIB.push(rec);
          await persistFontLib();
          fontB64Cache.set(rec.id, b64);
          injectFontFaces();
          file.value = '';
          renderFontLib(root);
          /* 立即刷新正文字体/标题字体下拉框，无需重开面板 */
          root.querySelectorAll('.ar-select[data-fontk]').forEach(sel => {
            const k = sel.dataset.fontk;
            sel.innerHTML = fontOptionsHtml(draft.common[k]);
          });
          toast('已导入「' + f.name + '」，下方字体选择框可直接选用');
        } finally {
          addBtn.disabled = false;
        }
      };
      r.onerror = () => { toast('字体读取失败'); addBtn.disabled = false; };
      r.readAsDataURL(f);
    });
    renderFontLib(root);
  }

  /* ───────── 应用：注入覆盖样式（异步：媒体引用需先换回 dataURL） ───────── */
  let _applySeq = 0;
  async function applyAppearance() {
    if (!AR) return;
    const seq = ++_applySeq;
    const theme = document.body.getAttribute('data-theme') === 'night' ? 'dark' : 'light';
    const M = AR[theme] || AR.light;
    const C = M.colors, H = M.homeBg, R = M.readerBg, K = AR.common;
    /* 5.3：media-store:// 引用先换回 dataURL（带缓存），避免 CSS 里出现不可显示的引用 */
    const H2 = Object.assign({}, H, { img: await resolveImg(H.img) });
    const R2 = Object.assign({}, R, { img: await resolveImg(R.img) });
    const J2 = { u: await resolveImg((M.jCover || {}).u), q: await resolveImg((M.jCover || {}).q) };
    if (seq !== _applySeq) return;  // 期间又有新的应用请求，放弃过期结果
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
    /* ② 主页背景图。
       5.6.1 关键修复：5.0 重写时误用了 DOM 中不存在的 .pages-bg 类（回归），
       主页背景一直没有生效。改回覆盖 .pages::before（styles.css 里真实存在的
       全屏幕风层）。不透明度/遮罩用叠加渐变层模拟，不动 ::before 的 opacity，
       避免把底下的 body 底色透出成灰块。 */
    if (H2.img) {
      const size = H2.fit === 'contain' ? 'contain' : H2.fit === 'stretch' ? '100% 100%' : 'cover';
      let veil = '';
      if (H2.mask > 0) veil += `linear-gradient(rgba(0,0,0,${H2.mask}),rgba(0,0,0,${H2.mask})),`;
      if (H2.opacity < .99) veil += `linear-gradient(${hexA(C.bg, 1 - H2.opacity)},${hexA(C.bg, 1 - H2.opacity)}),`;
      css += `.pages::before{background:${veil}url("${H2.img}") center / ${size} no-repeat, var(--bg) !important;}`;
    }
    /* ⑤ 手帐封面（思想页两本手帐） */
    if (J2.u) css += `.journal-cell[data-open="我的理解"] .journal{background-image:url("${J2.u}");background-size:cover;background-position:center;}`;
    if (J2.q) css += `.journal-cell[data-open="问题"] .journal{background-image:url("${J2.q}");background-size:cover;background-position:center;}`;
    /* ③④ 阅读器：背景图存在时强制底层透明（4.9 修复：.reader-inner 底色盖住背景图） */
    if (R2.img) {
      const size = R2.fit === 'contain' ? 'contain' : R2.fit === 'stretch' ? '100% 100%' : 'cover';
      css += `.reader,.reader-scroll,.reader-inner{background:transparent !important;background-color:transparent !important;}`;
      css += `.reader-bgimg{position:absolute;inset:0;z-index:0;pointer-events:none;background-image:url("${R2.img}");background-size:${size};background-position:center;background-repeat:no-repeat;opacity:${R2.opacity};}`;
    } else {
      css += `.reader{background:${R2.color || 'var(--bg-reader)'} !important;}`;
      css += `.reader-bgimg{display:none !important;}`;
    }
    /* ⑤ 通用排版（正文颜色跟随主题 --ink，不再单独设置）
       注意：.reader-scroll 绝不能改 position —— 它靠 absolute+inset:0 撑满滚动，
       5.1 曾误加 position:relative 导致阅读器无法滑动（已修复） */
    css += `.reader-inner{padding:${K.mt}px ${K.mr}px ${K.mb}px ${K.ml}px !important;}
.para{font-family:${fontStack(K.bodyFont)} !important;font-size:${K.bodySize}px !important;color:var(--ink) !important;letter-spacing:${K.ls}em !important;line-height:${K.lh} !important;text-align:${K.bodyAlign} !important;margin:0 0 ${K.pg}px !important;}
.para.head{font-family:${fontStack(K.titleFont)} !important;font-size:${K.titleSize}px !important;color:var(--ink) !important;text-align:${K.titleAlign} !important;font-weight:${K.titleWeight} !important;letter-spacing:${K.ls}em !important;line-height:${K.lh} !important;margin:38px 0 ${Math.max(K.pg, 14)}px !important;}
.chap-title{font-family:${fontStack(K.titleFont)} !important;font-size:${K.titleSize}px !important;color:var(--ink) !important;text-align:${K.titleAlign} !important;font-weight:${K.titleWeight} !important;letter-spacing:.02em;}
.chap-num{color:var(--ink-3) !important;}`;
    if (seq !== _applySeq) return;
    /* 内容守卫：CSS 没变化就绝不重写 style 标签（避免无谓的样式重算触发宿主抖动） */
    const st0 = document.getElementById('arStyle');
    if (st0 && st0.textContent === css) { ensureReaderBgLayer(); return; }
    st.textContent = css;
    ensureArCss();
    ensureReaderBgLayer();
    injectHero();
  }
  /* ───────── 媒体引用（5.3 性能修复核心） ─────────
     此前主页背景/主图/阅读背景/手帐封面全以 base64 dataURL 存进 settings 记录，
     每次保存都要整体序列化几 MB，宿主内存压力过大而被重启。
     现改为：保存时 dataURL → media.put 换成 media-store:// 引用（Blob 落盘），
     显示时 media.get 换回 dataURL（带内存缓存）。 */
  const mediaCache = new Map();
  async function resolveImg(src) {
    if (!src) return '';
    if (!src.startsWith('media-store://')) return src;
    if (mediaCache.has(src)) return mediaCache.get(src);
    try {
      const r = await window.AiPhone.media.get({ ref: src });
      const d = (r && r.dataUrl) || '';
      mediaCache.set(src, d);
      return d;
    } catch (e) { return src; }  /* 换不回时保留原引用，至少下次保存不会把数据弄丢 */
  }
  async function putImg(dataUrl) {
    try {
      const r = await window.AiPhone.media.put({ dataUrl });
      if (r && r.ref) { mediaCache.set(r.ref, dataUrl); return r.ref; }
    } catch (e) { console.warn('[深读] media.put 失败，回退 dataURL 存储', e); }
    return dataUrl;  // 兜底：媒体库不可用时维持旧行为
  }
  /* 5.6：图片已改为压缩后的 dataURL 直接存储（体积小），不再转引用。
     此函数保留为空操作以兼容旧调用点；旧数据里的 media-store:// 引用
     在 hydrateImages 换回后，下次保存会以 dataURL 形式落库。 */
  async function compactImages(rec) { /* no-op since 5.6 */ }
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
    const themeNow = document.body.getAttribute('data-theme') === 'night' ? 'dark' : 'light';
    const src = AR && AR[themeNow] && AR[themeNow].readerBg.img;
    const want = !!src;
    if (layer && src) layer.style.backgroundImage = src.startsWith('media-store://') ? 'none' : `url("${src}")`;
    if (!want) { if (layer) layer.style.backgroundImage = 'none'; return; }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'reader-bgimg';
      reader.insertBefore(layer, reader.firstChild);
    }
  }

  /* ───────── 主页主图注入（5.2 加强节流：内容不变绝不调度，最短间隔 300ms，
       避免设置面板操作时 MutationObserver 高频回调导致宿主重启） ───────── */
  let _heroPending = false;
  let _heroLastRun = 0;
  function injectHero() {
    const now = Date.now();
    if (_heroPending || now - _heroLastRun < 300) return;
    _heroPending = true;
    requestAnimationFrame(() => { _heroPending = false; _heroLastRun = Date.now(); _injectHeroNow(); });
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
  /* 5.6：导入图片一律先压缩（最长边 1600px JPEG，约几百 KB），
     压缩后的 dataURL 体积小，可直接持久化，不再依赖 media.put/get，
     也不存在大记录压垮宿主的问题 */
  function readImgToDraft(file, target, cb) {
    if (file.size > 8 * 1024 * 1024) { toast('图片过大，不超过 8MB'); return; }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 1280;  // 5.6.2：再降一档，压缩后约 200~400KB，排除超长 dataURL 兼容风险
          const ratio = Math.min(1, MAX / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * ratio));
          const h = Math.max(1, Math.round(img.height * ratio));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          target.img = cv.toDataURL('image/jpeg', 0.85);
        } catch (e) {
          target.img = String(r.result);  // 压缩失败用原图
        }
        cb && cb();
      };
      img.onerror = () => { toast('图片读取失败'); };
      img.src = String(r.result);
    };
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
      <div data-bgsec="jcover">
        <div class="ar-sec">手帐封面</div>
        ${imgRow('「理解」手帐封面', '主页 → 思想 → 两本手帐中「理解」的封面图')}
        ${imgRow('「问题」手帐封面', '主页 → 思想 → 两本手帐中「问题」的封面图')}
      </div>
      <div data-bgsec="homebg">
        <div class="ar-sec">主页背景</div>
        ${imgRow('主页背景图', '整个 App 主界面的页面背景，不影响阅读器')}
        ${segRow('填充方式', 'fit', draft[which].homeBg, [{ v: 'cover', l: '填满' }, { v: 'contain', l: '完整' }, { v: 'stretch', l: '拉伸' }])}
        ${sliderRow('图片不透明度', 'opacity', draft[which].homeBg, 0, 1, 0.05)}
        ${sliderRow('暗色遮罩', 'mask', draft[which].homeBg, 0, 0.8, 0.05)}
      </div>
      <div data-bgsec="hero">
        <div class="ar-sec">主页主图</div>
        ${imgRow('主页主图', '主页顶部独立展示的图片卡片')}
      </div>
      <div data-bgsec="rdbg">
        <div class="ar-sec">阅读背景</div>
        ${imgRow('阅读背景图', '只作用于阅读页，设置后阅读页底色自动透明')}
        ${segRow('填充方式', 'fit', draft[which].readerBg, [{ v: 'cover', l: '填满' }, { v: 'contain', l: '完整' }, { v: 'stretch', l: '拉伸' }])}
        ${sliderRow('背景不透明度', 'opacity', draft[which].readerBg, 0.1, 1, 0.05)}
        ${colorRow('阅读背景色', 'color', draft[which].readerBg)}
      </div>`;
    const commonHtml = `
      ${fontLibHtml()}
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
        <span style="flex-shrink:0;font-size:10px;color:var(--ink-3);align-self:center;margin-left:auto;">代码 v5.6.2</span>
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
        <div data-sub="colors" style="display:none;">${colorsHtml('light')}</div>
        <div data-sub="bg" style="display:none;">${bgHtml('light')}</div>`)}
      ${pane('dark', `<div class="ar-modehint">当前正在编辑「深色模式」的外观。保存后可通过主页右上角的深浅模式开关切换查看。</div>
        <div data-sub="colors" style="display:none;">${colorsHtml('dark')}</div>
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
        /* 5.5：二级选择（colors/bg）作为状态记住，切深浅后显式应用到新面板，
           保证「浅色-背景 → 深色」落在「深色-背景」而不是回到颜色 */
        let curSub = 'colors';
        const applySub = () => {
          subTabs.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x.dataset.st === curSub));
          root.querySelectorAll('.ar-pane.sel [data-sub]').forEach(d => {
            d.style.display = d.dataset.sub === curSub ? '' : 'none';
          });
        };
        tabs.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-t]');
          if (!b) return;
          tabs.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          const t = b.dataset.t;
          root.querySelectorAll('.ar-pane').forEach(p => p.classList.toggle('sel', p.dataset.pane === t));
          subWrap.style.display = (t === 'light' || t === 'dark') ? '' : 'none';
          if (t === 'light' || t === 'dark') applySub();
          if (t === 'tpl') renderTplList(root);
        });
        subTabs.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-st]');
          if (!b) return;
          curSub = b.dataset.st;
          applySub();
        });
        /* 绑定：浅色/深色颜色 */
        for (const which of ['light', 'dark']) {
          bindColorRows(root.querySelector(`[data-pane="${which}"] [data-sub="colors"]`), draft[which].colors, COLOR_DEF[which]);
        }
        /* 绑定：浅色/深色背景区。
           5.1 修复：不再按 .field 索引取（拉条等元素不是 .field，索引会错位导致
           bindColorRows 收到 undefined 抛错，onOpen 中断 → 底部按钮全部失灵）。
           改为按 data-bgsec 分组容器定位，每个小节内部再找自己的 .field。 */
        for (const which of ['light', 'dark']) {
          const bg = root.querySelector(`[data-pane="${which}"] [data-sub="bg"]`);
          if (!bg) continue;
          const sec = (name) => bg.querySelector(`[data-bgsec="${name}"]`);
          const fieldIn = (secEl, idx) => secEl ? secEl.querySelectorAll('.field')[idx] : null;
          const segIn = (secEl, name) => secEl ? secEl.querySelector(`.type-chip[data-segk="${name}"]`)?.closest('.field') : null;
          /* 手帐封面：两本各自独立的 imgRow（用代理对象分别读写 jCover.u / jCover.q） */
          const jc = draft[which].jCover;
          const proxy = (k) => ({ get img() { return jc[k]; }, set img(v) { jc[k] = v; } });
          bindImgRow(fieldIn(sec('jcover'), 0), '.field', proxy('u'));
          bindImgRow(fieldIn(sec('jcover'), 1), '.field', proxy('q'));
          /* 主页背景 */
          bindImgRow(fieldIn(sec('homebg'), 0), '.field', draft[which].homeBg);
          bindSegRows(segIn(sec('homebg'), 'fit'), draft[which].homeBg);
          bindSliderRows(sec('homebg'), draft[which].homeBg);
          /* 主图 */
          bindImgRow(fieldIn(sec('hero'), 0), '.field', draft[which].hero);
          /* 阅读背景 */
          bindImgRow(fieldIn(sec('rdbg'), 0), '.field', draft[which].readerBg);
          bindSegRows(segIn(sec('rdbg'), 'fit'), draft[which].readerBg);
          bindSliderRows(sec('rdbg'), draft[which].readerBg);
          bindColorRows(sec('rdbg'), draft[which].readerBg, {});
        }
        /* 通用 */
        const cp = root.querySelector('[data-pane="common"]');
        bindFontLib(cp);
        bindFontRows(cp, draft.common);
        bindSegRows(cp, draft.common);
        bindSliderRows(cp, draft.common);
        /* 模板 */
        root.querySelector('#arTplSave').addEventListener('click', () => saveTemplate(root));
        /* 保存 */
        root.querySelector('#arCancel').addEventListener('click', closeTopSheet);
        const saveBtn = root.querySelector('#arSave');
        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          try {
            const keep = { templates: AR.templates, activeTpl: AR.activeTpl };
            AR = arClone(draft);
            AR.templates = keep.templates; AR.activeTpl = keep.activeTpl;
            await compactImages(AR);
            await hydrateImages(AR);
            const ok = await saveAppearance();
            applyAppearance();
            /* 5.6.2：回读校验，把「保存是否真的落库、图片是否真的存进去」明确反馈出来 */
            const err = ok ? await verifySaved() : ('写入失败：' + lastSaveErr);
            if (err) { toast('保存异常 · ' + err, 4200); return; }
            closeTopSheet();
            const n = countImgSlots(AR);
            toast('外观已更新（深浅两套均已保存' + (n ? ' · 图片 ' + n + ' 张' : '') + '）');
          } finally {
            saveBtn.disabled = false;
          }
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
          await compactImages(AR);
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
    /* 5.2：回调合并到 rAF 且 injectHero 自带节流与内容守卫；
       injectAppearanceBtn 本身有幂等守卫（已存在直接 return），
       不会形成「观察→改DOM→再观察」的循环 */
    let _mutPending = false;
    new MutationObserver(() => {
      if (_mutPending) return;
      _mutPending = true;
      requestAnimationFrame(() => { _mutPending = false; injectAppearanceBtn(); injectHero(); });
    }).observe(body, { childList: true, subtree: true });
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
  loadFontLib();
})();
