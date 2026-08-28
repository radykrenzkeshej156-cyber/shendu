/* ============================================================
   深读 3.1 · app.js —— 认知架构 + 智能沉淀 + 三视图思想空间
   ------------------------------------------------------------
   核心循环：书 → 概念 → 我与书互动（理解/问题/共鸣）→ 实践 → 改变 → 新的理解

   数据表：
   - books     {id, version:2, title, author, format, coverColor, chapterMeta,
                currentChapterId, currentParaNum, currentScrollRatio, ...}
   - chapters  {id, bookId, idx, title, text, paraStart, paraCount, summary, summaryAt}
   - insights  {id, rootId, type:'概念'|'我的理解'|'实践'|'改变', text, tags[],
                keywords[], bookId, chapterId, paraNum, quote, practiceKind,
                createdAt, growthAt, pending}
   - questions {id, text, tags[], keywords[], bookId, chapterId, paraNum, quote,
                status, answerText, answeredAt, createdAt}
   - annotations {id, type:'resonate'|'note', selectedText, content, bookId,
                chapterId, paraNum, createdAt}
   - sessions  {id, bookId, chapterId, paraNum, quote, topic, msgs[], createdAt}
   - traces    {id, bookId, chapterId, paraNum, type, sessionId, summary, ts}
   - timeline  {id, kind, text, bookId, ts}
   - tags      {id, name, n}
   - settings  {id:'coread', companionId, ctxMsgs, card}
   - state     {id:'reading', bookId, chapterId, paraNum, scrollRatio}
   - meta      {id:'change_last', at}
   ============================================================ */
'use strict';
const A = window.AiPhone;
const $id = (id) => typeof id === 'string' ? document.getElementById(id.replace(/^#/, '')) : null;
const $q = (sel) => typeof sel === 'string' ? document.querySelector(sel) : null;
const $qa = (sel) => typeof sel === 'string' ? Array.from(document.querySelectorAll(sel)) : [];

/* ───────── 工具 ───────── */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function uid() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
let _toastTimer = null;
function toast(msg, dur = 2200) {
  const t = $id('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), dur);
}
function fmtDay(ts) { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; }
function fmtWeek(ts) { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; }
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  return fmtWeek(ts);
}

/* ───────── 六大类型体系 ───────── */
const TYPE_META = {
  '概念':     { label: '概念',   sub: '书里的思想',    em: '◇', css: 't-concept' },
  '我的理解': { label: '理解',   sub: '你的思想',      em: '·', css: 't-understand' },
  '问题':     { label: '问题',   sub: '悬而未决',      em: '？' },
  '共鸣':     { label: '共鸣',   sub: '收藏的瞬间',    em: '♥' },
  '实践':     { label: '实践',   sub: '书进入生活',    em: '→', css: 't-practice' },
  '改变':     { label: '改变',   sub: '长期形成',      em: '◆', css: 't-change' },
};
const TYPE_ORDER = ['概念', '我的理解', '问题', '共鸣', '实践', '改变'];
const AI_SUGGEST_TYPES = ['概念', '我的理解', '问题'];
function displayType(raw) {
  if (TYPE_META[raw]) return raw;
  if (raw === '悬题') return '问题';
  return '我的理解';
}
function typeEm(type) { return (TYPE_META[type] || {}).em || '·'; }
function typeSub(type) { return (TYPE_META[type] || {}).sub || ''; }

/* ───────── DB helpers ───────── */
function normRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map(x => {
    if (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') return { id: x.id, data: x.data };
    return { id: (x && x.id) || null, data: x };
  });
}
async function listCol(col, full = false) {
  const q = full ? { since: '0000' } : { limit: 1000 };
  try { return normRows(await A.db.list(col, q)); }
  catch (e) { console.warn('db.list', col, e); return []; }
}
async function upsert(col, rec) {
  const rows = await listCol(col);
  const found = rows.find(r => r.data && r.data.id === rec.id);
  if (found) await A.db.update(col, found.id, rec);
  else await A.db.create(col, rec);
}
async function removeById(col, id) {
  const rows = await listCol(col, true);
  const found = rows.find(r => r.data && r.data.id === id);
  if (found) await A.db.delete(col, found.id);
}
async function listData(col, full = false) {
  const rows = await listCol(col, full);
  return rows.map(r => r.data).filter(Boolean);
}

/* ───────── 主题标签库（用户检索 + AI 召回共用同一套） ───────── */
let S = null;  // 见文件尾 init 前定义

async function loadTags() { S.tags = await listData('tags', true); return S.tags; }
async function allTagNames() {
  const t = await listData('tags', true);
  return t.sort((a, b) => (b.n || 0) - (a.n || 0)).map(x => x.name);
}
function mergeTags(arr) { return Array.from(new Set(arr.map(t => String(t).trim()).filter(Boolean))).slice(0, 5); }
async function bumpTags(names) {
  for (const n of (names || [])) {
    const rows = await listCol('tags', true);
    const f = rows.find(r => r.data && r.data.name === n);
    if (f) { f.data.n = (f.data.n || 0) + 1; await A.db.update('tags', f.id, f.data); }
    else await A.db.create('tags', { id: 'tag_' + uid(), name: n, n: 1 });
  }
  await loadTags();
}
/* 优先复用已有标签：在已有标签里按子串/包含关系找可复用项 */
function mapToExisting(tag, existing) {
  const t = String(tag).trim();
  if (!t) return '';
  if (existing.includes(t)) return t;
  /* 已有标签是候选的子串（如已有"控制"，新词"控制欲"）→ 复用已有 */
  for (const e of existing) {
    if (e.length >= 2 && t.includes(e)) return e;
    if (t.length >= 2 && e.includes(t)) return t;
  }
  return t;
}
async function normalizeTags(names) {
  const existing = await allTagNames();
  const out = [];
  for (const raw of (names || [])) {
    const mapped = mapToExisting(String(raw).trim(), existing);
    if (!mapped || out.includes(mapped)) continue;
    out.push(mapped);
  }
  return out.slice(0, 5);
}

/* ───────── 共读设置 ───────── */
const DEFAULT_CARD = '性格：一位温和而有深度的共读者。\n说话方式：简短、真诚、口语化。\n共读方式：先复述你理解到的意思，再提一个真正值得想的问题。\n禁止：不要为了体现角色而故意反驳；不要为了显聪明而批判；不要为了人设扭曲书本内容；优先帮用户思考，而不是表演角色。';
async function loadCoreadSettings() {
  const rows = await listData('settings');
  const s = rows.find(x => x.id === 'coread');
  if (s) {
    S.companionId = s.companionId || null;
    S.coset = { ctxMsgs: s.ctxMsgs || 10, card: s.card != null ? s.card : '' };
  } else {
    S.coset = { ctxMsgs: 10, card: '' };
  }
}
async function saveCoreadSettings() {
  await upsert('settings', { id: 'coread', companionId: S.companionId, ctxMsgs: S.coset.ctxMsgs, card: S.coset.card });
}

/* ───────── 章节切分 ───────── */
const CHAPTER_RE = /^(第[\d一二三四五六七八九十百千万零〇两]+[章节回卷篇部]|序章|序言|尾声|终章|引子|楔子|后记|跋|附录|Chapter\s+\d+|#+\s+|第[\d一二三四五六七八九十百千万零〇两]+章[:\s])/i;
function splitBook(content) {
  const rawLines = String(content).split(/\n/);
  const chapters = [];
  let cur = null;
  for (const line of rawLines) {
    const t = line.trim();
    if (CHAPTER_RE.test(t) && t.length <= 60) {
      if (cur) chapters.push(cur);
      cur = { title: t, lines: [] };
    } else {
      if (!cur) cur = { title: '开篇', lines: [] };
      cur.lines.push(line);
    }
  }
  if (cur) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: '开篇', lines: rawLines });
  return chapters.filter(c => c.lines.some(l => l.trim())).map(c => ({
    title: c.title || '开篇',
    text: c.lines.join('\n').replace(/\n{3,}/g, '\n\n'),
  }));
}
function parasOf(text) {
  return text.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => ({ t: s, head: CHAPTER_RE.test(s) || false }));
}
function extractUnit(chapterText, paraLocal, budget = 2600) {
  const paras = parasOf(chapterText);
  if (!paras.length) return chapterText.slice(0, budget);
  let lo = Math.max(0, paraLocal), hi = Math.min(paras.length - 1, paraLocal);
  let chars = paras[paraLocal] ? paras[paraLocal].t.length : 0;
  while (chars < budget && (lo > 0 || hi < paras.length - 1)) {
    if (lo > 0) { lo--; chars += paras[lo].t.length + 2; }
    if (chars >= budget) break;
    if (hi < paras.length - 1) { hi++; chars += paras[hi].t.length + 2; }
  }
  return paras.slice(lo, hi + 1).map(p => p.t).join('\n');
}

/* ───────── 章节地图（懒生成，服务 AI 上下文） ───────── */
async function chapterSummary(ch) {
  if (ch && ch.summary && ch.summaryAt) return ch.summary;
  return '';
}
async function generateChapterSummary(ch) {
  if (!ch || !ch.text) return '';
  if (ch.summary && ch.summaryAt) return ch.summary;
  if (!S.companionId) return '';
  try {
    const unit = extractUnit(ch.text, 0, 5000);
    const result = await A.ai.generate({
      characterId: S.companionId,
      appTags: ['deepread', 'chapter-map'],
      instruction: `这是《${S.rBook ? S.rBook.title : ''}》的一节原文（节选${unit.length < ch.text.length ? '，全文更长' : ''}）。请输出这一节的「章节地图」，它只用于之后的共读对话快速定位上下文，不是给读者看的读书总结。必须覆盖：
【本节核心思想】1-3 句
【重要概念】条文列出，每个概念一句话
【作者论证/思想如何推进】简要说明
【与前后文的关系】如能判断
严格控制在 180 字内，只写地图本身，不要寒暄。`,
    });
    const text = (result.text || '').trim();
    if (text) {
      ch.summary = text;
      ch.summaryAt = Date.now();
      const rows = await listCol('chapters', true);
      const found = rows.find(r => r.data && r.data.id === ch.id);
      if (found) { found.data.summary = text; found.data.summaryAt = Date.now(); await A.db.update('chapters', found.id, found.data); }
    }
    return ch.summary || '';
  } catch (e) { return ch.summary || ''; }
}/* ───────── 加载 ───────── */
async function loadAll() {
  const [books, groups, insights, questions, timeline, resonates, metaRows, stateRows] = await Promise.all([
    listData('books', true), listData('groups', true), listData('insights', true),
    listData('questions', true), listData('timeline', true),
    listData('annotations', true), listData('meta', true),
    listData('state', true),
  ]);
  const reading = (stateRows || []).find(x => x.id === 'reading');
  if (reading && reading.bookId) S.lastBookId = reading.bookId;
  S.books = books; S.groups = groups; S.insights = insights;
  S.questions = questions; S.timeline = timeline;
  S.resonates = (resonates || []).filter(a => a.type === 'resonate');
  const changeMeta = (metaRows || []).find(m => m.id === 'change_last');
  S.metaChangeAt = (changeMeta && changeMeta.at) ? changeMeta.at : 0;
  await loadTags();
}
async function bookChapters(bookId) {
  const rows = await listCol('chapters', true);
  return rows.map(r => r.data).filter(c => c && c.bookId === bookId).sort((a, b) => a.idx - b.idx);
}
function chapterParaStart(book, chapterId) {
  let sum = 0;
  for (const m of (book.chapterMeta || [])) {
    if (m.cid === chapterId) return sum;
    sum += m.paraCount || 0;
  }
  return 0;
}
function totalParas(book) {
  return (book.chapterMeta || []).reduce((a, m) => a + (m.paraCount || 0), 0);
}
async function ensureBookChapters(book) {
  let chs = await bookChapters(book.id);
  if (chs && chs.length) return chs;
  if (typeof book.content === 'string' && book.content.trim()) {
    const chapters = splitBook(book.content);
    const chapterMeta = [];
    let paraStart = 0;
    for (let i = 0; i < chapters.length; i++) {
      const cid = 'ch_' + book.id + '_' + i;
      const pcount = parasOf(chapters[i].text).length;
      await upsert('chapters', { id: cid, bookId: book.id, idx: i, title: chapters[i].title, text: chapters[i].text, paraStart, paraCount: pcount });
      chapterMeta.push({ cid, title: chapters[i].title, paraCount: pcount });
      paraStart += pcount;
    }
    book.chapterMeta = chapterMeta;
    await upsert('books', book);
    return await bookChapters(book.id);
  }
  return [];
}
function bookCurrentChapterTitle(book) {
  if (!book || !book.chapterMeta || !book.chapterMeta.length) return '';
  const idx = book.chapterMeta.findIndex(c => c.cid === book.currentChapterId);
  return idx >= 0 ? (book.chapterMeta[idx].title || '') : '';
}

/* ───────── P1：AI 自动生成标签（保存记录时，不进共读主流程） ─────────
   用户手动保存理解/问题/概念时，同一次 AI 调用顺带生成标签：
   不给用户增加「手动打标签」的步骤；
   轻量、可点击、优先复用已有标签。 */
async function suggestTags(text, type) {
  if (!text) return { tags: [], keywords: [] };
  if (!S.companionId) return { tags: [], keywords: [] };
  const existing = await allTagNames();
  try {
    const result = await A.ai.generate({
      characterId: S.companionId,
      appTags: ['deepread', 'tags'],
      instruction: `给一条读者的「${type}」记录生成主题标签，用于把TA的思想按主题聚合。记录内容：
「${text.slice(0, 120)}」
要求：
1. 2～5 个短词（一到四个字）。
2. 注意：${existing.length ? '已有标签：「' + existing.slice(0, 30).join('、') + '」。优先复用这些已有的，' : ''}避免同义词泛滥（如"控制""控制欲""控制感"只选一个）。
3. 你只输出一行，格式：概念标签1、标签2、标签3（如 控制、安全感、计划）。`,
    });
    const line = (result.text || '').split('\n').filter(s => s.includes('、')).pop() || (result.text || '');
    const words = line.replace(/\s+/g, '').split(/[,，、]/).map(w => w.trim()).filter(Boolean);
    const tags = await normalizeTags(words.slice(0, 5));
    return { tags, keywords: tags.slice(0, 3) };
  } catch (e) {
    /* 轻量降级：不标也可，绝不阻塞保存 */
    return { tags: [], keywords: [] };
  }
}

/* ───────── P1：AI 历史上下文召回 ─────────
   结构过滤 → 标签/关键词命中 → 候选 → 小模型挑选 → 主模型读取 */
function localCandidateScan(currentText, chapterId) {
  const text = String(currentText || '');
  const candidates = [];
  const score = (rec, tags, kw) => {
    let s = 0;
    for (const t of (tags || [])) if (text.includes(t)) s += 3;
    for (const k of (kw || [])) if (text.includes(k)) s += 2;
    return s;
  };
  for (const i of S.insights) {
    const disp = displayType(i.type);
    /* 结构过滤：当前书优先，跨书也进初筛 */
    let s = score(i, i.tags, i.keywords);
    if (i.bookId === S.rBook.id) s += 1;          /* 当前书轻加权 */
    if (i.type === '实践' || disp === '改变') continue; /* 实践/改变只在明确相关时召回 */
    if (s > 0) candidates.push({ id: i.id, type: 'insight', disp, text: i.text, tags: i.tags, score: s, bookId: i.bookId });
  }
  for (const q of S.questions) {
    const s = score(q, q.tags, q.keywords);
    if (q.bookId === S.rBook.id) s += 1;
    if (s > 0) candidates.push({ id: q.id, type: 'question', disp: '问题', text: q.text, tags: q.tags, score: s, bookId: q.bookId });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 12);
}
async function aiRerankRecall(candidates, currentText, limit = 4) {
  if (!candidates.length) return [];
  if (candidates.length <= limit) return candidates.slice(0, limit);
  if (!S.companionId) return candidates.slice(0, limit);  /* 无 AI 时按本地分数取前几 */
  try {
    const candList = candidates.map((c, i) => `${i}. [${c.disp}] ${c.text.slice(0, 50)}`).join('\n');
    const result = await A.ai.generate({
      characterId: S.companionId,
      appTags: ['deepread', 'recall'],
      instruction: `当前讨论：
「${String(currentText).slice(0, 120)}」
以下是读者过去的思想记录候选，请只选择与当前讨论真正相关的，最多 ${limit} 条；没有相关的就输出「无」。只输出所选记录的行号（如 0,2,5），不要解释。\n${candList}`,
    });
    const nums = ((result.text || '').match(/\d+/g) || []).map(Number);
    const picked = nums.filter(n => Number.isInteger(n) && n >= 0 && n < candidates.length);
    const out = picked.map(n => candidates[n]);
    return (out.length ? out : []).slice(0, limit);
  } catch (e) { return candidates.slice(0, limit); }
}
function recallToText(recs) {
  return recs.map(c => `- [${c.disp}] ${c.text}`).join('\n');
}/* ───────── 渲染：桌面 / 书库 ───────── */
const PALETTE = ['#7a6a52', '#8a7a6a', '#5f7a6a', '#6a5f7a', '#7a6a5f', '#5f6a7a'];
function bookColor(book) { return book.coverColor || '#' + Math.abs(hashStr(book.id)).toString(16).slice(0, 6).padStart(6, '0'); }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
function mkCover(book) { return `background:${bookColor(book)}`; }
function renderDesk() {
  const body = $id('deskBody');
  if (!body) return;
  const books = S.books;
  const cur = books.find(b => b.id === S.lastBookId) || books[0];
  let html = `<div class="h-row"><div><div class="h-page">书桌</div><div class="h-sub">与书同行，与 AI 共读</div></div></div>`;
  if (cur) {
    const meta = cur.chapterMeta || [];
    const prog = Math.round((meta.findIndex(m => m.cid === cur.currentChapterId) + 1) / Math.max(1, meta.length) * 100);
    html += `<div class="now-card card" onclick="openReader('${esc(cur.id)}')">
      <div class="cover" style="${mkCover(cur)}">${esc((cur.title || '书').slice(0, 3))}</div>
      <div class="info"><div class="t">${esc(cur.title)}</div>
      <div class="m">${esc(cur.author || '未知作者')} · 读至 ${prog}% · ${esc(bookCurrentChapterTitle(cur))}</div></div>
      <span class="go">›</span></div>`;
  } else {
    html += `<div class="card empty" onclick="goTab('lib')">书架还是空的，先导入一本书吧。</div>`;
  }
  const reso = (S.resonates || []).slice(-2);
  if (reso.length) {
    html += `<div class="pulse-strip"><div class="tt">最近共鸣</div>`;
    for (const r of reso) html += `<div class="bd">「${esc((r.selectedText || r.text || '').slice(0, 80))}」</div>`;
    html += `<div class="mt">——${esc(fmtDay(r.createdAt))}</div></div>`;
  }
  html += `<div class="section-label">书库</div>`;
  const others = books.filter(b => b !== cur).slice(0, 4);
  for (const b of others) {
    html += `<div class="mini-line" onclick="openReader('${esc(b.id)}')"><span>${esc(b.title)}</span><span class="ts">${b.chapterMeta ? b.chapterMeta.length + ' 章' : ''}</span></div>`;
  }
  body.innerHTML = html;
}
function goTab(tab) {
  $qa('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $qa('.page').forEach(p => p.classList.remove('active'));
  const page = $id('p-' + tab);
  if (page) page.classList.add('active');
  if (tab === 'lib') renderLib();
  if (tab === 'mind') renderMindShell();
  if (tab === 'desk') { renderDesk(); renderChangePanel(); }
}
function renderLib() {
  const body = $id('libBody');
  if (!body) return;
  const books = S.books;
  let html = `<div class="h-row"><div><div class="h-page">书库</div><div class="h-sub">${books.length} 本书的完整阅读史</div></div></div>`;
  for (const b of books) {
    const meta = b.chapterMeta || [];
    const idx = meta.findIndex(m => m.cid === b.currentChapterId);
    const prog = meta.length ? Math.round((idx + 1) / meta.length * 100) : 0;
    html += `<div class="book-card card" onclick="openReader('${esc(b.id)}')">
      <div class="cover" style="${mkCover(b)}">${esc((b.title || '书').slice(0, 3))}</div>
      <div class="info"><div class="t">${esc(b.title)}</div>
      <div class="m">${esc(b.author || '未知作者')} · ${meta.length} 章</div>
      <div class="p"><i style="width:${prog}%"></i></div></div>
      <button class="more" onclick="event.stopPropagation();openBookSheet('${esc(b.id)}')">•••</button></div>`;
  }
  html += `<button class="add-book-btn" onclick="openImportSheet()">+ 导入新书（TXT / EPUB）</button>`;
  body.innerHTML = html;
}
function renderMindShell() { renderMind(); }

/* ───────── 打开阅读器（核心） ───────── */
async function openReader(bookId) {
  closeCoDrawer();
  try {
    const book = S.books.find(b => b.id === bookId);
    if (!book) { toast('书不存在'); return; }
    S.rBook = book;
    /* 兜底：旧书没有章节表 → 现场切章（唯一的旧数据兼容） */
    S.bookChCache = await ensureBookChapters(book);
    const chs = S.bookChCache;
    if (!chs.length) { toast('这本书没有可读文本'); return; }
    const bIdx = book.currentChapterId ? chs.findIndex(c => c.id === book.currentChapterId) : -1;
    S.rChIdx = bIdx >= 0 ? bIdx : 0;
    S.rCh = chs[S.rChIdx];
    if (!S.rCh) { toast('章节数据异常'); return; }
    renderReaderChapter();
    $id('reader').classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      /* 位置恢复：统一用全局段号 + 视线滚动比例，越界则回落到校验后的位置 */
      const chsNow = S.bookChCache && S.bookChCache.length ? S.bookChCache : [];
      const start = chapterParaStart(book, S.rCh.id);
      const gp = Number(book.currentParaNum) || 0;
      let local = Math.max(0, gp - start);
      if (local >= parasOf(S.rCh.text).length) local = 0;
      const target = parasOf(S.rCh.text).length ? local : 0;
      const els = $qa('#rInner .para');
      if (els[target]) {
        const ratio = Number(book.currentScrollRatio) || 0;
        const node = els[target];
        const topPos = node.offsetTop - Math.round(($id('rScroll').clientHeight) * Math.min(1, Math.max(0, ratio)));
        $id('rScroll').scrollTop = Math.max(0, topPos);
      }
      updateProgress();
    }, 30);
    S.lastBookId = book.id;
    await upsert('state', { id: 'reading', bookId: book.id, chapterId: S.rCh.id, paraNum: book.currentParaNum || 0, scrollRatio: book.currentScrollRatio || 0 });
  } catch (e) {
    console.error('openReader', e); toast('打开失败：' + (e && e.message ? e.message : '未知错误'));
  }
}
function renderReaderChapter() {
  const ch = S.rCh;
  const book = S.rBook;
  const paras = parasOf(ch.text);
  S.rParas = paras;
  const start = chapterParaStart(book, ch.id);
  const dots = S.insights.filter(i => i.chapterId === ch.id && i.bookId === book.id);
  const qdots = S.questions.filter(q => q.chapterId === ch.id && q.bookId === book.id);
  let html = `<div class="chap-num">${(book.chapterMeta || []).findIndex(m => m.cid === ch.id) + 1}</div>`;
  html += `<div class="chap-title">${esc(ch.title)}</div>`;
  for (let i = 0; i < paras.length; i++) {
    const gp = start + i;
    const insightDots = dots.filter(d => Number(d.paraNum) === gp);
    const questionDots = qdots.filter(q => Number(q.paraNum) === gp);
    let dotHtml = '';
    if (insightDots.length) dotHtml += insightDots.map(d => `<span class="trace-dot insight" data-gp="${gp}" title="${esc(typeEm(displayType(d.type)) + (d.text ? ' ' + d.text.slice(0, 16) : ''))}"></span>`).join('');
    if (questionDots.length) dotHtml += questionDots.map(() => `<span class="trace-dot question" data-gp="${gp}" title="这里有悬题"></span>`).join('');
    html += `<p class="para${paras[i].head ? ' head' : ''}" data-gp="${gp}">${dotHtml}${esc(paras[i].t)}</p>`;
  }
  $id('rInner').innerHTML = html;
  $id('rChapTitle').textContent = ch.title;
  updateProgress();
  applyTraceDots();
  refreshCompanionBadge();
  /* 到达章节末尾的责任区 → 显示下一章（书没读完时） */
  const isLast = S.rChIdx >= S.bookChCache.length - 1;
  $id('rNextHint').hidden = isLast;
}
function applyTraceDots() {
  $qa('#rInner .trace-dot').forEach(d => {
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      const gp = Number(d.dataset.gp);
      const ins = S.insights.find(x => x.bookId === S.rBook.id && x.chapterId === S.rCh.id && Number(x.paraNum) === gp);
      const q = S.questions.find(x => x.bookId === S.rBook.id && x.chapterId === S.rCh.id && Number(x.paraNum) === gp);
      if (ins) { openCoDrawer(ins.text, '我在这里想过'); }
      else if (q) { openCoDrawer(q.text, '这里的悬题'); }
    });
  });
}
function updateProgress() {
  const ch = S.rCh;
  if (!ch || !S.rBook) return;
  const meta = S.rBook.chapterMeta || [];
  const idx = meta.findIndex(m => m.cid === ch.id);
  const total = totalParas(S.rBook) || 1;
  const gp = Math.min(total, Math.max(0, S.rParaNum || S.rBook.currentParaNum || 0));
  const pct = Math.min(100, Math.round(gp / total * 100));
  $id('rProgress').textContent = `${idx >= 0 ? idx + 1 : ''}/${meta.length} · ${pct}%`;
}
/* 点击正文任意位置唤出/收起菜单 */
function toggleReaderUI(forceShow) {
  const r = $id('reader');
  const show = typeof forceShow === 'boolean' ? forceShow : !r.classList.contains('ui');
  r.classList.toggle('ui', show);
}
async function savePosition(scrollRatio) {
  if (!S.rBook || !S.rCh) return;
  const paras = S.rParas || [];
  const start = chapterParaStart(S.rBook, S.rCh.id);
  /* 视线所在段：滚动位置映射到正文段（全局段号） */
  const scrollEl = $id('rScroll');
  const viewTop = scrollEl.scrollTop;
  let local = 0, best = Infinity;
  const els = $qa('#rInner .para');
  for (let i = 0; i < els.length; i++) {
    const diff = Math.abs(els[i].offsetTop - viewTop);
    if (diff < best) { best = diff; local = i; }
  }
  const gp = start + local;
  S.rParaNum = gp;
  S.rBook.currentChapterId = S.rCh.id;
  S.rBook.currentParaNum = gp;
  S.rBook.currentScrollRatio = scrollRatio != null ? scrollRatio : (els.length > 1 ? local / (els.length - 1) : 0);
  await upsert('books', S.rBook);
}/* ───────── 共读抽屉 ───────── */
const CO_TYPES = { '概念': '概念', '我的理解': '我的理解', '理解': '我的理解', '问题': '问题', '悬题': '问题', '共鸣': '共鸣', '实践': '实践', '改变': '改变' };
function openCoDrawer(quoteText, topic) {
  const d = $id('coDrawer');
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
  const q = $id('coQuote');
  if (quoteText) { q.hidden = false; q.innerHTML = `<span class="qlabel">当前段落</span>${esc(String(quoteText))}`; }
  else q.hidden = true;
  $id('coTopic').textContent = topic || '正在共读';
  $id('coInput').focus();
}
function closeCoDrawer() {
  const d = $id('coDrawer');
  d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
}
function renderCoMsgs(appendOnly) {
  const box = $id('coMsgs');
  if (!appendOnly) box.innerHTML = '';
  const sess = S.rSess;
  if (!sess) return;
  const msgs = sess.msgs || [];
  const html2 = msgs.map(msgHtml).join('');
  box.innerHTML = html2;
  box.scrollTop = box.scrollHeight;
  const retries = $qa('.retry-btn');
  retries.forEach(b => b.addEventListener('click', () => {
    const sessId = b.dataset.sess; void sessId;
    retryCoMessage();
  }));
}
function msgHtml(m) {
  if (m.role === 'sess') return `<div class="sess-divider">— ${esc(m.text)} —</div>`;
  if (m.role === 'error') return `<div class="msg ai">${esc(m.text)}<button class="retry-btn" type="button">再问一次</button></div>`;
  const quote = m.quote ? `<div class="quote-ref">${esc(m.quote)}</div>` : '';
  if (m.role === 'user') return `<div class="msg user">${quote}${esc(m.text)}</div>`;
  return `<div class="msg ai">${quote}${esc(m.text)}</div>`;
}
/* 构建分层上下文：原文 → 章节摘要（懒生成）→ 最近N条 → 标签召回候选 → 浓缩卡 */
async function buildCoContext(msgText) {
  const book = S.rBook, ch = S.rCh;
  const ctx = {};
  const start = chapterParaStart(book, ch.id);
  /* 原文围绕视线所在段截取，而不是永远从章首开始 */
  const gp = Math.max(start, S.rParaNum || 0);
  const unit = extractUnit(ch.text, Math.max(0, gp - start), 2600);
  ctx.unit = unit;
  ctx.unitGlobal = start;
  /* 章节摘要（懒生成，有读到才信任） */
  const sum = await chapterSummary(ch);
  if (!sum && S.companionId && !ch.summaryAt) {
    generateChapterSummary(ch).then(s => { if (s) {} }).catch(() => {});
  }
  ctx.chapterSummary = sum;
  /* 最近 N 条共读消息（本次会话） */
  const msgs = (S.rSess && S.rSess.msgs) || [];
  const usermsgs = msgs.filter(m => (m.role === 'user' || m.role === 'ai') && m.text);
  ctx.recent = usermsgs.slice(-(S.coset.ctxMsgs || 10));
  /* 历史上下文检索：结构过滤 → 标签/关键词 → 小模型筛选 → 少量给主模型 */
  const cands = localCandidateScan(msgText, ch.id);
  let picked = cands.slice(0, 4);
  if (cands.length > 4) picked = await aiRerankRecall(cands, msgText, 4);
  ctx.recall = picked.map(c => ({ type: c.disp, text: String(c.text).slice(0, 200), bookId: c.bookId }));
  return ctx;
}
async function sendCoMessage() {
  const input = $id('coInput');
  const text = input.value.trim();
  if (!text || !S.rBook || !S.rCh) return;
  input.value = ''; input.disabled = true; $id('coSend').disabled = true;
  if (!S.rSess) newCoSession();
  const sess = S.rSess;
  sess.msgs.push({ role: 'user', text, quote: (S.rQuote || '').slice(0, 100) });
  renderCoMsgs();
  const typing = document.createElement('div');
  typing.className = 'typing'; typing.innerHTML = '<span class="spin"></span> 共读中…';
  $id('coMsgs').appendChild(typing); $id('coMsgs').scrollTop = $id('coMsgs').scrollHeight;
  try {
    const ctx = await buildCoContext(text);
    const sysLines = [];
    sysLines.push('你是「深读」APP 里的共读者，正与用户一起读一本书。');
    if (S.companionId) {
      const chInfo = S.companionName ? `你是 ${S.companionName}，保持这个角色的性格自然参与讨论。` : '';
      if (chInfo) sysLines.push(chInfo);
    }
    sysLines.push(`书目：《${esc(S.rBook.title)}》` + (S.rBook.author ? `（${esc(S.rBook.author)}）` : ''));
    sysLines.push(`当前章：《${esc(S.rCh.title)}》。`);
    sysLines.push(`当前原文（截取）：\n${ctx.unit}`);
    sysLines.push(`上一段说到的内容应视为上文的自然衔接，不要凭空开始。`);
    if (ctx.chapterSummary) sysLines.push(`【本章地图】${ctx.chapterSummary}`);
    if (ctx.recall.length) {
      sysLines.push('【相关旧思录（跨书检索命中的）】' + ctx.recall.map(r => `- [${r.type}] ${r.text}`).join('\n'));
      sysLines.push('这些是你过去想过的相关内容；如当前话题确实相关，可自然地呼应它，但不要强行引用、不要逐条评论。');
    }
    sysLines.push('要求：把当前段落想透，可以澄清、追问、举例、比较、联系前后文、指出不同读法；不要替用户下结论，不要写读书总结；不要无条件附和，原文与用户理解有出入时温和指出。一次 3～6 句，中文。');
    sysLines.push('只在真正值得长期保存时才在回复末尾输出一行「【值得沉淀】类型：内容」，类型仅为 概念 / 我的理解 / 问题 三者之一；不要为了凑而输出。');
    const result = await A.ai.generate({
      characterId: S.companionId || undefined,
      appTags: ['deepread', 'coread'],
      instruction: sysLines.join('\n'),
      history: ctx.recent.map(m => ({ role: m.role, content: m.text })),
    });
    typing.remove();
    const aiText = (result.text || '').trim();
    const aiPlain = aiText.replace(/【值得沉淀】[\s\S]*$/, '').trim();
    if (!aiPlain) throw new Error('没有收到回复');
    const st = aiText.match(/【值得沉淀】\s*([\s\S]+)$/);
    sess.msgs.push({ role: 'ai', text: aiPlain });
    if (st) {
      const parsed = parseSuggestion(st[1]);
      if (parsed) { sess.lastSuggest = parsed; }
    }
    renderCoMsgs();
    if (sess.lastSuggest) renderSuggestCard(sess.lastSuggest);
    await saveCoSession();
  } catch (e) {
    typing.remove();
    sess.msgs.push({ role: 'error', text: '共读失败：' + (e && e.message ? e.message : '网络或 API 问题') });
    renderCoMsgs();
  } finally {
    input.disabled = false; $id('coSend').disabled = false; input.focus();
  }
}
async function retryCoMessage() {
  if (!S.rSess) return;
  const sess = S.rSess;
  const lastErr = sess.msgs.map((m, i) => ({ m, i })).filter(x => x.m.role === 'error').pop();
  if (lastErr) {
    sess.msgs[lastErr.i] = sess.msgs[lastErr.i] && null;
    sess.msgs.splice(lastErr.i, 1);
  }
  const lastUser = sess.msgs.map((m, i) => ({ m, i })).filter(x => x.m.role === 'user').pop();
  if (lastUser) {
    sess.msgs.splice(lastUser.i, 1);
    const text = lastUser.m.text;
    $id('coInput').value = text;
  }
  renderCoMsgs();
  await saveCoSession();
  if ($id('coInput').value.trim()) await sendCoMessage();
}
function parseSuggestion(raw) {
  const s = String(raw).trim();
  const m = s.match(/^(概念|我的理解|理解|问题|悬题)\s*[:：]\s*([\s\S]+)$/);
  if (!m) return null;
  return { type: CO_TYPES[m[1]] || m[1], text: m[2].trim().slice(0, 500) };
}
function renderSuggestCard(sug) {
  if (!sug) return;
  const box = $id('coMsgs');
  const el = document.createElement('div');
  el.className = 'sugg-card';
  el.innerHTML = `<div class="s-title">AI 建议沉淀 · ${esc(sug.type || '')}</div><div>${esc(sug.text)}</div>
    <div class="s-actions">
      <button class="s-save" type="button">记下来</button>
      <button class="s-branch" type="button">展开</button>
      <button class="s-ignore" type="button">先不理</button>
    </div>`;
  el.querySelector('.s-save').addEventListener('click', async () => {
    el.remove(); S.rSess.lastSuggest = null; await saveCoSession();
    openCaptureSheet(sug.type, sug.text);
  });
  el.querySelector('.s-branch').addEventListener('click', () => {
    el.remove(); S.rSess.lastSuggest = null;
    $id('coInput').value = sug.text;
    sendCoMessage();
  });
  el.querySelector('.s-ignore').addEventListener('click', () => { el.remove(); S.rSess.lastSuggest = null; saveCoSession(); });
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function newCoSession() {
  S.rSess = {
    id: 'sess_' + uid(),
    bookId: S.rBook.id, chapterId: S.rCh.id, paraNum: S.rParaNum || 0,
    quote: S.rQuote || '', topic: (S.rCh && S.rCh.title) || '',
    msgs: [], createdAt: Date.now(),
  };
}
async function saveCoSession() {
  if (!S.rSess) return;
  await upsert('sessions', S.rSess);
}/* ───────── 创建记录：概念/理解/问题/实践/共鸣 ───────── */
let PICKED_TAGS = [];
async function openCaptureSheet(kind, prefillText) {
  if (kind === '共鸣') { toast('共鸣只能通过「划线收藏」创建'); return; }
  PICKED_TAGS = [];
  const sheet = openSheet(`
    <div class="grab"></div>
    <div class="s-title">新增${esc(kind)}</div>
    <div class="field"><label>${esc(kind)}内容</label><textarea id="capText">${esc(prefillText || '')}</textarea></div>
    ${kind === '实践' ? `
    <div class="field"><label>信念 / 行动</label>
      <div class="type-chips" id="capPracticeKind">
        <button class="type-chip sel" data-v="信念">信念</button>
        <button class="type-chip" data-v="行动">行动</button>
      </div>
    </div>` : ''}
    <div class="field"><label>主题标签（AI 生成，可点选）</label><div class="tag-suggest" id="capTagZone"><span class="ts-label">AI 生成中…</span></div></div>
    <div class="btn-row"><button class="btn-c" id="capCancel">取消</button><button class="btn-p" id="capSave">保存</button></div>`);
  sheet.classList.add('open');
  const pickKind = (v) => {
    $qa('#capPracticeKind .type-chip').forEach(c => c.classList.toggle('sel', c.dataset.v === v));
    sheet.querySelector('#capPracticeKind').dataset.val = v;
  };
  if (kind === '实践') {
    sheet.querySelector('#capPracticeKind').addEventListener('click', (e) => { const b = e.target.closest('.type-chip'); if (b) pickKind(b.dataset.v); });
    sheet.querySelector('#capPracticeKind').dataset.val = '信念';
  }
  const textEl = sheet.querySelector('#capText');
  const tagZone = sheet.querySelector('#capTagZone');
  const applyTags = () => {
    tagZone.innerHTML = PICKED_TAGS.length
      ? PICKED_TAGS.map(t => `<button class="sugg-tag picked" data-t="${esc(t)}">${esc(t)}</button>`).join('')
      : `<span class="ts-label">没有标签也可以保存</span>`;
    tagZone.querySelectorAll('.sugg-tag').forEach(b => {
      b.addEventListener('click', () => {
        const t = b.dataset.t;
        PICKED_TAGS = PICKED_TAGS.filter(x => x !== t);
        applyTags();
      });
    });
  };
  let suggestDone = false;
  const doSuggest = async () => {
    const t = textEl.value.trim();
    if (suggestDone || !t) return;
    suggestDone = true;
    const res = await suggestTags(t, kind);
    PICKED_TAGS = res.tags;
    applyTags();
  };
  textEl.addEventListener('blur', doSuggest);
  let blurTimer = null;
  textEl.addEventListener('input', () => { clearTimeout(blurTimer); blurTimer = setTimeout(doSuggest, 1200); });
  sheet.querySelector('#capCancel').addEventListener('click', closeSheet);
  sheet.querySelector('#capSave').addEventListener('click', async () => {
    const text = textEl.value.trim();
    if (!text) { toast('内容不能为空'); return; }
    await doSuggest();
    const tags = await normalizeTags(PICKED_TAGS);
    if (kind === '实践') {
      const pk = (sheet.querySelector('#capPracticeKind')?.dataset.val) || '信念';
      await savePractice(text, tags, pk, null);
    } else if (kind === '问题') {
      const q = {
        id: 'q_' + uid(), text, status: 'open', tags, keywords: tags.slice(0, 3),
        bookId: S.rBook.id, chapterId: S.rCh.id, paraNum: S.rParaNum || S.rParaNum0 || 0,
        quote: S.rQuote || '', answerText: '', answeredAt: 0, createdAt: Date.now(),
      };
      await upsert('questions', q);
      S.questions.push(q);
      await bumpTags(tags);
      await traceNow('留悬题');
      toast('已留悬题');
      closeSheet();
    } else {
      const rec = {
        id: 'ins_' + uid(), rootId: 'ins_' + uid(), type: kind,
        text, tags, keywords: tags.slice(0, 3),
        bookId: S.rBook.id, chapterId: S.rCh.id, paraNum: S.rParaNum || S.rParaNum0 || 0,
        quote: S.rQuote || '', createdAt: Date.now(), growthAt: Date.now(), pending: false,
      };
      if (kind === '我的理解' || kind === '概念') { rec.rootId = rec.id; delete rec.growthAt; }
      await upsert('insights', rec);
      S.insights.push(rec);
      await bumpTags(tags);
      await traceNow('新增' + kind);
      toast('已记录' + kind);
      closeSheet();
    }
    if (S.rCh) renderReaderChapter();
  });
}
async function savePractice(text, tags, practiceKind, quoteOverride) {
  const rec = {
    id: 'ins_' + uid(), rootId: 'ins_' + uid(), type: '实践',
    text, tags, keywords: tags.slice(0, 3),
    bookId: S.rBook.id, chapterId: S.rCh.id, paraNum: S.rParaNum || S.rParaNum0 || 0,
    quote: quoteOverride != null ? quoteOverride : (S.rQuote || ''),
    practiceKind: practiceKind || '信念',
    createdAt: Date.now(), pending: false,
  };
  await upsert('insights', rec);
  S.insights.push(rec);
  await bumpTags(tags);
  await traceNow('新增实践');
  renderReaderChapter();
  return rec;
}
/* ───────── 划线收藏（共鸣）：仅用户主动收藏瞬间，写入时间线 ───────── */
async function saveResonate(selectedText) {
  const rec = {
    id: 'ann_' + uid(), type: 'resonate', selectedText: selectedText.slice(0, 800),
    content: '', bookId: S.rBook.id, chapterId: S.rCh.id, paraNum: S.rParaNum || S.rParaNum0 || 0,
    createdAt: Date.now(),
  };
  await upsert('annotations', rec);
  S.resonates = (S.resonates || []).concat(rec);
  await traceNow('收藏共鸣');
  await addTimeline('resonate', selectedText);
  toast('已收藏这段共鸣');
}
async function addTimeline(kind, text) {
  await upsert('timeline', { id: 'tl_' + uid(), kind, text: String(text).slice(0, 200), bookId: S.rBook ? S.rBook.id : null, ts: Date.now() });
  const rows = await listData('timeline', true);
  S.timeline = rows;
}
async function traceNow(text) {
  const rec = { id: 'tr_' + uid(), bookId: S.rBook ? S.rBook.id : '', chapterId: S.rCh ? S.rCh.id : '', paraNum: S.rParaNum || S.rParaNum0 || 0, type: 'act', summary: text, ts: Date.now() };
  await upsert('traces', rec);
}

/* ───────── 共读抽屉事件 / 阅读器事件绑定（P0 修复） ───────── */
function bindUI() {
  tabBind();
  if (!$id('rCo')) return;
  /* P0-1：阅读器「实践」按钮 → 实践记录（信念/行动，仅用户自填） */
  $id('rPractice').addEventListener('click', () => {
    S.rParaNum = currentParaNum();
    S.rQuote = currentQuoteText();
    openCaptureSheet('实践', '');
  });
  /* P0-2：详情按钮 → 书籍详情 */
  $id('rDetail').addEventListener('click', () => openBookSheet(S.rBook.id));
  $id('rMind').addEventListener('click', () => goMind());
  $id('rBack').addEventListener('click', () => {
    closeReader();
    goTab(S.mindWanted ? 'mind' : 'desk');
    S.mindWanted = false;
  });
  $id('rToc').addEventListener('click', () => openTocSheet());
  $id('rCo').addEventListener('click', () => {
    const ch = S.rCh; if (!ch) return;
    S.rParaNum = currentParaNum();
    S.rQuote = currentQuoteText();
    const paras = parasOf(ch.text);
    const start = chapterParaStart(S.rBook, ch.id);
    const gp = S.rParaNum;
    const local = Math.max(0, gp - start);
    const unit = extractUnit(ch.text, local, 900);
    if (!S.rSess || S.rSess.chapterId !== ch.id) newCoSession();
    if (!S.rSess.msgs.length) S.rSess.msgs.push({ role: 'sess', text: '开始共读 · ' + (ch.title || '') });
    renderCoMsgs();
    if (S.rSess.lastSuggest) renderSuggestCard(S.rSess.lastSuggest);
    openCoDrawer(unit, '共读 · ' + (ch.title || ''));
    refreshCompanionBadge();
  });
  $id('coClose').addEventListener('click', closeCoDrawer);
  $id('coSend').addEventListener('click', sendCoMessage);
  $id('coInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCoMessage(); } });
  $id('coSaveI').addEventListener('click', () => {
    S.rParaNum = currentParaNum();
    S.rQuote = currentQuoteText();
    openCaptureSheet('我的理解', S.rQuote);
  });
  $id('coSaveQ').addEventListener('click', () => {
    S.rParaNum = currentParaNum();
    S.rQuote = currentQuoteText();
    openCaptureSheet('问题', '');
  });
  $id('coSess').addEventListener('click', () => openSessionsSheet());
  $id('rNextBtn').addEventListener('click', gotoNextChapter);
  bindReaderBody();
}
function tabBind() {
  $qa('.tabbar button').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));
}
function bindReaderBody() {
  const sc = $id('rScroll');
  const inner = $id('rInner');
  /* 点击正文任意位置唤出/收起菜单（P0 之前难唤菜单的修复保持） */
  sc.addEventListener('click', (e) => {
    if (e.target.closest('.trace-dot')) return;
    toggleReaderUI();
  });
  /* 文本选择 → 工具条（共鸣收藏 / 记入理解） */
  sc.addEventListener('mouseup', onTextSelect);
  sc.addEventListener('touchend', onTextSelect);
  let lastSaveY = 0;
  sc.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastSaveY > 900) {
      lastSaveY = now;
      const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const ratio = sc.scrollTop / max;
      savePosition(ratio);
    }
  }, { passive: true });
  void inner;
}
function onTextSelect() {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text || text.length < 2 || text.length > 800) { hideSelBar(); return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || !rect.top) { hideSelBar(); return; }
  const bar = $id('selBar');
  bar.innerHTML = `<button id="selReso" type="button">收藏共鸣</button><button id="selNote" type="button">记入理解</button>`;
  bar.classList.add('show');
  bar.style.left = '50%';
  bar.style.transform = 'translateX(-50%)';
  bar.style.top = (rect.top - 46 > 0 ? rect.top - 46 : rect.bottom + 8) + 'px';
  const save = (fn) => { fn(text); hideSelBar(); window.getSelection().removeAllRanges(); };
  $id('selReso').addEventListener('click', () => save(saveResonate));
  $id('selNote').addEventListener('click', () => save((t) => openCaptureSheet('我的理解', t)));
  setTimeout(() => {
    document.addEventListener('click', function h(e) { if (!e.target.closest('.sel-bar')) { hideSelBar(); document.removeEventListener('click', h); } });
  }, 0);
}
function hideSelBar() { $id('selBar').classList.remove('show'); }
function currentParaNum() {
  if (!S.rCh) return S.rParaNum0 || 0;
  const start = chapterParaStart(S.rBook, S.rCh.id);
  const scrollEl = $id('rScroll');
  const viewTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.5;
  const els = $qa('#rInner .para');
  let local = 0, best = Infinity;
  for (let i = 0; i < els.length; i++) {
    const mid = els[i].offsetTop + els[i].offsetHeight / 2;
    const diff = Math.abs(mid - viewTop);
    if (diff < best) { best = diff; local = i; }
  }
  return start + local;
}
function currentQuoteText() {
  const paras = S.rParas || [];
  if (!S.rCh) return '';
  const start = chapterParaStart(S.rBook, S.rCh.id);
  const gp = currentParaNum();
  const local = Math.max(0, gp - start);
  return (paras[local] && paras[local].t) ? paras[local].t : '';
}
async function gotoNextChapter() {
  const chs = S.bookChCache || [];
  if (S.rChIdx < chs.length - 1) {
    S.rChIdx++;
    S.rParaNum = 0;
    await savePosition(0);
    S.rCh = chs[S.rChIdx];
    S.rBook.currentChapterId = S.rCh.id;
    S.rBook.currentParaNum = 0; S.rBook.currentScrollRatio = 0;
    await upsert('books', S.rBook);
    renderReaderChapter();
    $id('rScroll').scrollTop = 0;
  }
}
function closeReader() {
  const r = $id('reader');
  r.classList.remove('open');
  document.body.style.overflow = '';
  savePosition(S.rBook ? (S.rBook.currentScrollRatio || 0) : 0).catch(() => {});
}/* ───────── 思想空间：三视图 ───────── */
S = S || null;
function initS() {
  S = {
    books: [], groups: [], insights: [], resonates: [], questions: [], timeline: [],
    tags: [], bookChCache: [], rBook: null, rCh: null, rChIdx: 0, rSess: null,
    rParaNum: 0, rParaNum0: 0, rQuote: '', lastBookId: null,
    companionId: null, companionName: '', coset: { ctxMsgs: 10, card: '' },
    mindView: 'timeline', mindFilter: '全部', mindTopic: null,
  };
}
let MIND_STATE = { view: 'timeline', filter: '全部', topic: null, loaded: false };

function goMind() {
  S.mindWanted = true;   /* 从阅读器进入思想空间：之后在阅读器按返回，回到这里 */
  $id('reader').classList.remove('open');
  document.body.style.overflow = '';
  goTab('mind');
}
function renderMind() {
  const body = $id('mindBody');
  if (!body) return;
  let html = `<div class="h-row"><div><div class="h-page">思想空间</div><div class="h-sub">读过的书，长出属于你的思想</div></div></div>`;
  html += `<div class="view-switch">
    <button data-v="timeline" class="${MIND_STATE.view === 'timeline' ? 'active' : ''}">时间线</button>
    <button data-v="topic" class="${MIND_STATE.view === 'topic' ? 'active' : ''}">主题</button>
    <button data-v="map" class="${MIND_STATE.view === 'map' ? 'active' : ''}">地图</button>
  </div>`;
  html += `<div class="mind-tabs" id="mindTypeFilter">
    ${['全部', '概念', '我的理解', '问题', '共鸣', '实践', '改变'].map(t =>
      `<button data-t="${t}" class="${MIND_STATE.filter === t ? 'active' : ''}">${t}</button>`).join('')}
  </div>`;
  html += `<div id="mindContent"></div>`;
  body.innerHTML = html;
  $qa('#mindBody .view-switch button').forEach(b => b.addEventListener('click', () => {
    MIND_STATE.view = b.dataset.v; MIND_STATE.topic = null; renderMind();
  }));
  $qa('#mindTypeFilter button').forEach(b => b.addEventListener('click', () => {
    MIND_STATE.filter = b.dataset.t; renderMind();
  }));
  const content = $id('mindContent');
  if (MIND_STATE.view === 'timeline') content.innerHTML = renderTimelineView();
  if (MIND_STATE.view === 'topic') content.innerHTML = renderTopicView();
  if (MIND_STATE.view === 'map') content.innerHTML = renderMapView();
  bindMindContent(content);
}
function thoughtRows() {
  const rows = [];
  for (const i of S.insights) {
    const disp = displayType(i.type);
    rows.push({
      kind: 'insight', id: i.id, type: disp, rawType: i.type, ts: i.createdAt,
      text: i.text, tags: i.tags || [], bookId: i.bookId, chapterId: i.chapterId,
      paraNum: i.paraNum, quote: i.quote, rootId: i.rootId, growthAt: i.growthAt,
      practiceKind: i.practiceKind, pending: i.pending,
    });
  }
  for (const q of S.questions) {
    rows.push({
      kind: 'question', id: q.id, type: '问题', rawType: '问题', ts: q.createdAt,
      text: q.text, tags: q.tags || [], bookId: q.bookId, chapterId: q.chapterId,
      paraNum: q.paraNum, quote: q.quote, status: q.status, answerText: q.answerText, answeredAt: q.answeredAt,
    });
  }
  for (const r of (S.resonates || [])) {
    rows.push({
      kind: 'resonate', id: r.id, type: '共鸣', rawType: '共鸣', ts: r.createdAt,
      text: r.selectedText, tags: [], bookId: r.bookId, chapterId: r.chapterId, paraNum: r.paraNum,
    });
  }
  return rows;
}
function filterRows(rows) {
  const f = MIND_STATE.filter;
  const out = rows.filter(r => f === '全部' || r.type === f);
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}
function bookInfoOf(bookId) {
  const b = S.books.find(x => x.id === bookId);
  return b ? `《${b.title}》` : '';
}
function mindCardHtml(r) {
  const book = esc(bookInfoOf(r.bookId));
  const tagsHtml = (r.tags || []).length ? `<div class="tag-row">${r.tags.slice(0, 4).map(t => `<button class="mini-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : '';
  if (r.kind === 'question') {
    const ans = r.answerText ? `<div class="ans">已回应：${esc(String(r.answerText).slice(0, 160))}</div>` : '';
    return `<div class="q-item card" data-id="${esc(r.id)}"><div class="bd">${esc(r.text)}</div>${ans}${tagsHtml}<div class="mt">${book} · ${fmtDay(r.ts)}${r.status === 'open' ? ' · 悬而未决' : ''}</div></div>`;
  }
  if (r.type === '共鸣') {
    return `<div class="resonate-item card" data-id="${esc(r.id)}"><div class="bd">「${esc(r.text)}」</div>${tagsHtml}<div class="origin">${book} · ${fmtDay(r.ts)}</div></div>`;
  }
  const typeLabel = r.type === '我的理解' ? '理解' : r.type;
  let extra = '';
  if (r.type === '实践' && r.practiceKind) extra = `<div class="origin">${esc(r.practiceKind)} · ${book} · ${fmtDay(r.ts)}</div>`;
  else extra = `<div class="origin">${book} · ${fmtDay(r.ts)}${r.quote ? ' · 「' + esc(String(r.quote).slice(0, 24)) + '…」' : ''}</div>`;
  let growth = '';
  if (r.rawType !== '共鸣' && r.rootId && r.rootId !== r.id) {
    const parents = S.insights.filter(x => x.id === r.rootId || x.rootId === r.rootId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (parents.length > 1) {
      growth = `<div class="growth">${parents.map(p => `<div class="g-row">${typeEm(displayType(p.type))} ${esc(String(p.text).slice(0, 60))}${p.id === r.id ? ' ← 现在' : ''}</div>`).join('')}</div>`;
    }
  }
  return `<div class="thought-item card ${TYPE_META[r.type] && TYPE_META[r.type].css ? TYPE_META[r.type].css : 't-understand'}" data-id="${esc(r.id)}">
    <div class="tt">${typeEm(r.type)} ${esc(typeLabel)}${r.pending ? '（思考中）' : ''}</div>
    <div class="bd">${esc(String(r.text).slice(0, 300))}</div>
    ${growth}${tagsHtml}${extra}</div>`;
}
/* 视图一：时间线 —— 只展示六类思想轨迹，不含普通操作 */
function renderTimelineView() {
  const rows = filterRows(thoughtRows()).slice(0, 80);
  if (!rows.length) return `<div class="empty">还没有思想记录。回到阅读器，把读到的东西想明白、写下来。</div>`;
  const byDay = {};
  for (const r of rows) {
    const d = new Date(r.ts || Date.now());
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    (byDay[key] = byDay[key] || []).push(r);
  }
  let html = '';
  for (const key of Object.keys(byDay).sort().reverse()) {
    const [y, m, dd] = key.split('-');
    html += `<div class="tl-day">${y} 年 ${m} 月 ${dd} 日</div>`;
    html += byDay[key].map(mindCardHtml).join('');
  }
  return html;
}
/* 视图二：主题 —— 标签聚合跨书内容 */
function topicStats() {
  const map = {};
  const add = (t) => { const k = String(t).trim(); if (k) map[k] = (map[k] || 0) + 1; };
  for (const r of thoughtRows()) for (const t of (r.tags || [])) add(t);
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}
function renderTopicView() {
  const stats = topicStats();
  if (!stats.length) return `<div class="empty">还没有主题标签。保存你的理解和问题时 AI 会先沿旧主题走。</div>`;
  let html = `<div class="topic-search"><input id="topicSearchInput" placeholder="找主题…" autocomplete="off"></div><div class="topic-list" id="topicList">`;
  html += stats.map(([name, n]) => `<button class="topic-node" data-t="${esc(name)}">${esc(name)}<span class="cnt">${n}</span></button>`).join('');
  html += `</div><div id="topicDetail"></div>`;
  return html;
}
function openTopicDetail(tag) {
  MIND_STATE.topic = tag;
  const detail = $id('topicDetail');
  if (!detail) return;
  const rows = thoughtRows().filter(r => (r.tags || []).includes(tag)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const books = Array.from(new Set(rows.map(r => r.bookId).filter(Boolean)));
  const byType = { '概念': 0, '我的理解': 0, '问题': 0, '共鸣': 0, '实践': 0, '改变': 0 };
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  let html = `<div class="h-row" style="margin-top:18px"><div class="h-page" style="font-size:17px">${esc(tag)}</div><button class="h-btn" onclick="closeTopicDetail()">返回主题</button></div>`;
  html += `<div class="h-sub">${Object.entries(byType).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(' · ')} · 涉及 ${books.length} 本书</div>`;
  html += rows.map(mindCardHtml).join('');
  detail.innerHTML = html;
  bindMindContent(detail);
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeTopicDetail() { MIND_STATE.topic = null; renderMind(); }
/* 视图三：地图 —— 主题连接相关主题+书籍+思想，克制不蜘蛛网 */
function renderMapView() {
  const stats = topicStats();
  if (!stats.length) return `<div class="empty">还没有可绘制地图的主题。</div>`;
  const rows = thoughtRows();
  const top = stats.slice(0, 12);
  let html = `<div class="map-hint">主题之间的连接来自共同出现在你思考里的主题对。点某条思想可回到它的源头。</div>`;
  for (const [name, n] of top) {
    /* 与哪些主题共现 */
    const co = {};
    for (const r of rows) if ((r.tags || []).includes(name)) for (const t of (r.tags || [])) if (t !== name) co[t] = (co[t] || 0) + 1;
    const peers = Object.entries(co).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const thoughts = rows.filter(r => (r.tags || []).includes(name)).slice(0, 4);
    html += `<div class="map-topic-block card" style="padding:14px 16px">
      <div class="map-topic-head">${esc(name)}<span class="cnt2">${n} 条 · ${bookCountOf(name)}</span></div>
      <div class="map-rel-lines">${peers.map(([t, c]) => `<span class="concept-rel">— ${esc(t)}（${c}）</span>`).join(' ')}</div>
      <div>${thoughts.map(r => `<div class="mini-line" data-id="${esc(r.id)}" data-bid="${esc(r.bookId || '')}"><span>${typeEm(r.type)}</span><span>${esc(String(r.text).slice(0, 56))}</span></div>`).join('')}</div>
    </div>`;
  }
  return html;
}
function bookCountOf(tag) {
  const books = new Set();
  for (const r of thoughtRows()) if ((r.tags || []).includes(tag) && r.bookId) books.add(r.bookId);
  return books.size + ' 本书';
}
function bindMindContent(root) {
  root.querySelectorAll('.mini-tag').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation(); MIND_STATE.view = 'topic'; renderMind(); openTopicDetail(b.dataset.tag);
  }));
  root.querySelectorAll('.topic-node').forEach(b => b.addEventListener('click', () => openTopicDetail(b.dataset.t)));
  const search = root.querySelector('#topicSearchInput');
  if (search) search.addEventListener('input', () => {
    const kw = search.value.trim();
    $qa('#topicList .topic-node').forEach(n => n.style.display = !kw || n.dataset.t.includes(kw) ? '' : 'none');
  });
  root.querySelectorAll('.map-topic-block .mini-line').forEach(l => l.addEventListener('click', () => {
    goToOrigin(l.dataset.id, l.dataset.bid);
  }));
  root.querySelectorAll('[data-id]').forEach(el => {
    if (el.classList.contains('mini-line')) return;
    el.addEventListener('click', () => openSheetNote(el.dataset.id));
  });
}
function goToOrigin(id, bookId) {
  const r = thoughtRows().find(x => x.id === id);
  if (!r) return toast('记录已不存在');
  if (r.bookId && S.books.some(b => b.id === r.bookId)) {
    goMindBackToBook(r.bookId, r);
  } else toast('这本书已不在书架');
}
async function goMindBackToBook(bookId, row) {
  $id('reader').classList.remove('open');
  await openReader(bookId);
  if (row && row.chapterId) {
    const chs = S.bookChCache;
    const ci = chs.findIndex(c => c.id === row.chapterId);
    if (ci >= 0) { S.rChIdx = ci; S.rCh = chs[ci]; renderReaderChapter(); }
  }
}/* ───────── 底部弹层 ───────── */
function openSheet(innerHtml) {
  const root = $id('sheetRoot');
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="sheet">${innerHtml}</div>`;
  root.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  mask.addEventListener('click', (e) => { if (e.target === mask) closeSheet(); });
  return mask.querySelector('.sheet');
}
function closeSheet() {
  const masks = $qa('#sheetRoot .mask');
  const last = masks[masks.length - 1];
  if (!last) return;
  last.classList.remove('open');
  setTimeout(() => last.remove(), 240);
}

/* ───────── 书籍详情 / 目录 / 会话 ───────── */
function openBookSheet(bookId) {
  const b = S.books.find(x => x.id === bookId);
  if (!b) return;
  const stats = bookStats(b);
  const nI = S.insights.filter(i => i.bookId === b.id).length;
  const nQ = S.questions.filter(q => q.bookId === b.id).length;
  const nR = (S.resonates || []).filter(r => r.bookId === b.id).length;
  const sheet = openSheet(`
    <div class="grab"></div>
    <div class="s-title">${esc(b.title)}</div>
    <div class="h-sub" style="text-align:center">${esc(b.author || '未知作者')}</div>
    <div class="stat-grid">
      <div class="st"><b>${stats.chapters}</b><span>章节</span></div>
      <div class="st"><b>${nI}</b><span>思想</span></div>
      <div class="st"><b>${nQ}</b><span>悬题</span></div>
      <div class="st"><b>${nR}</b><span>共鸣</span></div>
    </div>
    <div class="section-label">长出来的东西</div>
    <div class="grown-grid">
      <div class="grown-cell" data-k="概念"><b>${stats.concepts}</b><span>概念</span></div>
      <div class="grown-cell" data-k="我的理解"><b>${stats.understandings}</b><span>理解</span></div>
      <div class="grown-cell" data-k="实践"><b>${stats.practices}</b><span>实践</span></div>
      <div class="grown-cell" data-k="改变"><b>${stats.changes}</b><span>改变</span></div>
      <div class="grown-cell" data-k="问题"><b>${stats.questions}</b><span>问题</span></div>
      <div class="grown-cell" data-k="共鸣"><b>${stats.resonates}</b><span>共鸣</span></div>
    </div>
    <div class="section-label">阅读进度</div>
    <div class="mini-line"><span>当前位置</span><span>${esc(bookCurrentChapterTitle(b))}</span></div>
    <div class="section-label">操作</div>
    <button class="row-btn" id="bsContinue">继续阅读</button>
    <button class="row-btn" id="bsSet">共读设置</button>
    <button class="row-btn danger" id="bsDelete" style="display:${S.books.length > 1 ? '' : 'none'}">从书架移除</button>`);
  sheet.querySelector('#bsContinue').addEventListener('click', () => { closeSheet(); openReader(b.id); });
  sheet.querySelector('#bsSet').addEventListener('click', () => { openCoreadSettings(); });
  const del = sheet.querySelector('#bsDelete');
  if (del) del.addEventListener('click', async () => {
    await removeById('books', b.id);
    for (const c of await bookChapters(b.id)) await removeById('chapters', c.id);
    S.books = await listData('books', true);
    closeSheet(); goTab('desk');
  });
  Array.from(sheet.querySelectorAll('.grown-cell')).forEach(c => c.addEventListener('click', () => {
    MIND_STATE.filter = c.dataset.k; MIND_STATE.view = 'timeline';
    goMind();
  }));
}
function bookStats(b) {
  const chs = S.bookChCache || [];
  const concepts = S.insights.filter(i => i.bookId === b.id && displayType(i.type) === '概念').length;
  const understandings = S.insights.filter(i => i.bookId === b.id && displayType(i.type) === '我的理解').length;
  const practices = S.insights.filter(i => i.bookId === b.id && displayType(i.type) === '实践').length;
  const changes = S.insights.filter(i => i.bookId === b.id && displayType(i.type) === '改变').length;
  const questions = S.questions.filter(q => q.bookId === b.id).length;
  const resonates = (S.resonates || []).filter(r => r.bookId === b.id).length;
  return { chapters: (b.chapterMeta || []).length || chs.length, concepts, understandings, practices, changes, questions, resonates };
}
function openTocSheet() {
  if (!S.rBook) return;
  const chs = S.bookChCache || [];
  const sheet = openSheet(`<div class="grab"></div><div class="s-title">目录</div>` +
    chs.map((c, i) => `<button class="row-btn" data-i="${i}">${esc(c.title)}${c.summary ? '<span class="ts">已建图</span>' : ''}</button>`).join(''));
  sheet.querySelectorAll('.row-btn').forEach(btn => btn.addEventListener('click', async () => {
    const i = Number(btn.dataset.i);
    closeSheet();
    S.rChIdx = i; S.rCh = chs[i];
    S.rBook.currentChapterId = S.rCh.id;
    await upsert('books', S.rBook);
    renderReaderChapter();
    $id('rScroll').scrollTop = 0;
  }));
}
function openSessionsSheet() {
  const sessions = S.timeline.filter(t => t && t.ts);
  openSheet(`<div class="grab"></div><div class="s-title">共读话题</div>` +
    (sessions.length ? sessions.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60).map(s => {
      const book = S.books.find(b => b.id === s.bookId);
      return `<button class="row-btn">${esc(String(s.text || '').slice(0, 60))}${book ? ' · ' + esc(book.title) : ''}<span class="ts">${timeAgo(s.ts)}</span></button>`;
    }).join('') : `<div class="empty">还没有话题记录</div>`));
}
/* 共读设置：上下文条数 5/10/20/40/80（P1 已落地，这里校验可用） */
function openCoreadSettings() {
  const opts = [5, 10, 20, 40, 80];
  const sheet = openSheet(`
    <div class="grab"></div>
    <div class="s-title">共读设置</div>
    <div class="field"><label>每轮给 AI 的历史上下文条数</label>
      <div class="type-chips" id="ctxOptions">${opts.map(n => `<button class="type-chip${S.coset.ctxMsgs === n ? ' sel' : ''}" data-n="${n}">${n}</button>`).join('')}</div>
      <div style="font-size:11.5px;color:var(--ink-3);margin-top:6px">越大记得越多、越贵越慢；当前 ${S.coset.ctxMsgs} 条。</div>
    </div>
    <div class="btn-row"><button class="btn-c" id="csClose">完成</button></div>`);
  sheet.querySelector('#ctxOptions').addEventListener('click', (e) => {
    const b = e.target.closest('.type-chip'); if (!b) return;
    S.coset.ctxMsgs = Number(b.dataset.n);
    Array.from(sheet.querySelectorAll('.type-chip')).forEach(c => c.classList.toggle('sel', Number(c.dataset.n) === S.coset.ctxMsgs));
    saveCoreadSettings();
  });
  sheet.querySelector('#csClose').addEventListener('click', closeSheet);
}
let IMPORT_EPUB = null;
function openImportSheet() {
  const sheet = openSheet(`
    <div class="grab"></div>
    <div class="s-title">导入一本书</div>
    <div class="field"><label>TXT / EPUB 文件</label><input type="file" id="impFile" accept=".txt,.epub,text/plain,application/epub+zip"></div>
    <div class="import-status" id="impStatus"><span class="spin"></span> 正在导入…</div>
    <div class="field"><label>书名（可改）</label><input type="text" id="impTitle"></div>
    <div class="field"><label>作者</label><input type="text" id="impAuthor"></div>
    <div class="btn-row"><button class="btn-c" id="impCancel">取消</button><button class="btn-p" id="impDo" disabled>导入</button></div>`);
  sheet.querySelector('#impStatus').style.display = 'none';
  const fileInput = sheet.querySelector('#impFile');
  const titleInput = sheet.querySelector('#impTitle');
  const authorInput = sheet.querySelector('#impAuthor');
  const doBtn = sheet.querySelector('#impDo');
  const statusEl = sheet.querySelector('#impStatus');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    statusEl.style.display = 'flex';
    doBtn.disabled = true;
    try {
      if (file.name.toLowerCase().endsWith('.epub')) {
        if (typeof EpubParser === 'undefined' || !EpubParser.supported()) throw new Error('当前浏览器不支持解压 EPUB');
        statusEl.innerHTML = `<span class="spin"></span> 解析 EPUB…`;
        IMPORT_EPUB = await EpubParser.parse(file);
        titleInput.value = IMPORT_EPUB.title || '';
        authorInput.value = IMPORT_EPUB.author || '';
        statusEl.innerHTML = `OK：${IMPORT_EPUB.chapters.length} 节正文`;
        doBtn.disabled = false;
      } else {
        IMPORT_EPUB = null;
        const text = await file.text();
        IMPORT_EPUB = { title: '', author: '', chapters: [{ title: '', text }] };
        titleInput.value = titleInput.value || file.name.replace(/\.txt$/i, '');
        statusEl.innerHTML = `OK：文本已读取，导入时自动切章`;
        doBtn.disabled = false;
      }
    } catch (e) {
      statusEl.innerHTML = `失败：${esc(e.message || '读取失败')}`;
      doBtn.disabled = true;
    }
  });
  sheet.querySelector('#impCancel').addEventListener('click', closeSheet);
  doBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim() || '未命名书';
    const author = authorInput.value.trim() || '未知作者';
    doBtn.disabled = true;
    await doImport(title, author);
  });
}
async function doImport(title, author) {
  const id = 'bk_' + uid();
  const book = {
    id, version: 2, title, author, format: IMPORT_EPUB && IMPORT_EPUB.chapters.length > 1 ? 'epub' : 'txt',
    coverColor: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    chapterMeta: [], currentChapterId: '', currentParaNum: 0, currentScrollRatio: 0,
    createdAt: Date.now(),
  };
  /* EPUB 已按 spine 分节直接入库；TXT 统一现场切章 */
  if (IMPORT_EPUB && IMPORT_EPUB.chapters.length > 1) {
    let paraStart = 0;
    for (let i = 0; i < IMPORT_EPUB.chapters.length; i++) {
      const src = IMPORT_EPUB.chapters[i];
      const cid = 'ch_' + id + '_' + i;
      const pcount = parasOf(src.text).length;
      await upsert('chapters', { id: cid, bookId: id, idx: i, title: src.title || ('第 ' + (i + 1) + ' 节'), text: src.text, paraStart, paraCount: pcount });
      book.chapterMeta.push({ cid, title: src.title || ('第 ' + (i + 1) + ' 节'), paraCount: pcount });
      paraStart += pcount;
    }
  } else if (IMPORT_EPUB && IMPORT_EPUB.chapters.length === 1) {
    book.content = IMPORT_EPUB.chapters[0].text;
  }
  await upsert('books', book);
  S.books = await listData('books', true);
  S.bookChCache = [];
  closeSheet();
  await openReader(id);
  toast('已导入「' + title + '」');
}/* ───────── 周期性改变分析（排除共鸣/实践，看长期） ───────── */
function changeEligible() {
  const rows = S.insights.filter(i => i.bookId !== undefined && i.pending !== true);
  const last = S.metaChangeAt || 0;
  const fresh = rows.filter(r => r.createdAt > last).length;
  if (fresh < 5) return { ok: false, fresh };
  if (Date.now() - last < 7 * 86400000) return { ok: false, fresh };
  return { ok: true, fresh };
}
/* 阅读器思想抽屉去思想空间（P0-2）的入口 */
function goToMindSpace() { goMind(); }
/* 同伴徽章刷新 */
async function refreshCompanionBadge() {
  const av = $id('rCoAvatar');
  const nm = $id('rCoName');
  const avatar = $id('coAvatar');
  const name = $id('coName');
  if (S.companionName) {
    nm.textContent = S.companionName;
    name.textContent = S.companionName;
    av.classList.remove('gray');
    avatar.textContent = S.companionName.slice(0, 1);
  } else {
    nm.textContent = '共读';
    name.textContent = '共读';
    av.classList.add('gray');
    avatar.textContent = '共';
  }
}
async function loadCompanion() {
  const rows = await listData('settings', true);
  const s = rows.find(x => x.id === 'coread');
  if (s && s.companionId) {
    S.companionId = s.companionId;
    S.coset.ctxMsgs = s.ctxMsgs || S.coset.ctxMsgs;
    S.coset.card = s.card || S.coset.card;
    try {
      const charList = await A.characters.list();
      const c = (charList || []).find(x => x.id === S.companionId);
      if (c) S.companionName = c.name || '';
    } catch (_) {}
  }
  refreshCompanionBadge();
}
/* ───────── 改变分析（保守触发） ───────── */
function renderChangePanel() {
  if (!changeEligible().ok) return;
  if (S.changeShownAt && Date.now() - S.changeShownAt < 60 * 60 * 1000) return;
  S.changeShownAt = Date.now();
  const d = $id('deskBody');
  if (!d) return;
  d.insertAdjacentHTML('beforeend', `<div class="pulse-strip" id="changeStrip"><div class="tt">缓缓地，你变了</div>
    <div class="bd">想看看这段时间，阅读让你哪里变了吗？</div>
    <div class="s-actions" style="margin-top:8px"><button class="s-save" id="chgDo">让共读者看看</button><button class="s-ignore" id="chgSkip">先不管</button></div></div>`);
  $id('chgDo').addEventListener('click', async () => {
    $id('chgDo').textContent = '正在想…';
    await runChangeAnalysis();
    d.querySelector('#changeStrip')?.remove();
  });
  $id('chgSkip').addEventListener('click', () => d.querySelector('#changeStrip')?.remove());
}
async function runChangeAnalysis() {
  const rows = S.insights.filter(i => i.bookId !== undefined);
  const body = rows.slice().sort((a, b) => a.createdAt - b.createdAt).map(r => `[${fmtDay(r.createdAt)} ${displayType(r.type)}] ${r.text}`).join('\n');
  if (!S.companionId) { toast('请先在共读设置里选择一位共读者'); return; }
  try {
    toast('共读者正在回顾你的思想');
    const result = await A.ai.generate({
      characterId: S.companionId,
      appTags: ['deepread', 'change'],
      instruction: `用户在深读APP里积累了一些思想记录。请回顾它们，找出用户真正发生的一处「改变」——不是感受，而是持续的观念或行为变化。如果确实有，输出一行：「【改变】具体变化」。如果没有明显变化，只回答「还没看到变化」。不要泛泛而谈，不要夸用户。\n${body.slice(-6000)}`,
    });
    const text = result.text || '';
    const m = text.match(/【改变】\s*([\s\S]+)/);
    if (m && m[1].trim()) {
      const idea = {
        id: 'ins_' + uid(), type: '改变', text: m[1].trim(),
        bookId: S.books[0] ? S.books[0].id : '', tags: [], keywords: [],
        rootId: '', paraNum: 0, quote: '', createdAt: Date.now(), pending: false,
      };
      await upsert('insights', idea);
      S.insights.push(idea);
      await upsert('meta', { id: 'change_last', at: Date.now() });
      S.metaChangeAt = Date.now();
      toast('发现了一处改变');
      await traceNow('改变分析');
      renderDesk();
    }
  } catch (e) { toast('改变分析失败，晚点再试'); }
}
/* ───────── 记录详情（思想卡点击查看） ───────── */
async function openSheetNote(id) {
  const r = thoughtRows().find(x => x.id === id);
  if (!r) return;
  const book = esc(bookInfoOf(r.bookId));
  const tags = (r.tags || []).length ? `<div class="tag-row">${r.tags.map(t => `<button class="mini-tag">${esc(t)}</button>`).join('')}</div>` : '';
  let extra = '';
  if (r.quote) extra = `<div class="field"><label>原文</label><div style="font-family:var(--font-serif);font-size:14px;line-height:1.8;background:var(--gold-soft);padding:10px 13px;border-radius:10px">${esc(String(r.quote).slice(0, 300))}</div></div>`;
  if (r.kind === 'question') extra += `<div class="field"><label>状态</label><div>${esc(r.status === 'resolved' ? '已回应' : '悬而未决')}${r.answerText ? '：' + esc(String(r.answerText).slice(0, 200)) : ''}</div></div>`;
  if (r.practiceKind) extra += `<div class="field"><label>形式</label><div>${esc(r.practiceKind)}</div></div>`;
  const sheet = openSheet(`
    <div class="grab"></div>
    <div class="s-title">${typeEm(r.type)} ${esc(r.type === '我的理解' ? '理解' : r.type)}</div>
    <div class="h-sub" style="text-align:center">${book} · ${fmtDay(r.ts)}</div>
    <div style="font-family:var(--font-serif);font-size:16px;line-height:1.9;margin:12px 0">${esc(String(r.text).slice(0, 1000))}</div>
    ${tags}${extra}
    <div class="btn-row"><button class="btn-p" id="nbGo">回到原文</button><button class="btn-c" id="nbClose">关闭</button></div>`);
  sheet.querySelector('#nbGo').addEventListener('click', () => {
    if (r.bookId && S.books.some(b => b.id === r.bookId)) { closeSheet(); goMindBackToBook(r.bookId, r); }
    else toast('书已不在书架');
  });
  sheet.querySelector('#nbClose').addEventListener('click', closeSheet);
}
/* ───────── 初始化 ───────── */
async function init() {
  try {
    initS();
    await loadAll();
    await loadCoreadSettings();
    await loadCompanion();
    refreshCompanionBadge();
    bindUI();
    if (!S.books.length) {
      $id('deskBody').innerHTML = `<div class="h-page">书桌</div><div class="card empty" style="margin-top:16px">书桌还是空的。<br>点击下方「书库」导入你的第一本书。</div>`;
    } else {
      goTab('desk');
    }
  } catch (e) {
    console.error('init', e);
    $id('deskBody').innerHTML = `<div class="card empty" style="margin-top:16px">初始化失败：${esc(e && e.message)}</div>`;
  }
}
document.addEventListener('DOMContentLoaded', init);