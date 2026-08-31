/* ============================================================
   深读 3.1 · app.js —— 分层认知架构
   ------------------------------------------------------------
   三层数据 + 独立共读会话：
   【书本层】  原文 → 章节精炼(summary) → 概念(concepts)
   【阅读互动层】理解(insights) · 问题(questions) · 共鸣(annotations)
   【生活层】  实践(practices) · 改变(changes)

   核心原则：AI 负责阅读、讨论、压缩、连接、观察；
            用户负责确认自己的理解、保存问题、收藏共鸣、记录实践、确认改变。

   数据体系：
   - books     {id, version:2, title, author, format, coverColor, chapterMeta,
                currentChapterId, currentParaNum, currentScrollRatio, ...}
   - chapters  {id, bookId, idx, title, text, paraStart, paraCount,
                summary, summaryAt, conceptsAt}         ← 章节精炼（AI 生成，供共读上下文）
   - concepts  {id, bookId, chapterId, term, def, keywords[],
                createdAt}                              ← 书内概念，章节精炼时自动提取
   - insights  {id, text, tags[], keywords[], theme[], bookId, chapterId, paraNum,
                quote, createdAt, updatedAt}            ← 理解（用户思想库，可跨书）
   - questions {id, text, tags[], keywords[], bookId, chapterId, paraNum, quote,
                status, answerText, answers[] {text, at}, createdAt}   ← 问题（可跨书，持续回答）
   - annotations {id, type:'resonate', selectedText, content, bookId,
                chapterId, paraNum, createdAt}          ← 共鸣=用户主动收藏（书签式，不进 AI 上下文）
   - practices {id, belief, action, bookId, linkType, linkId, status, notes[],
                createdAt, updatedAt}                   ← 实践（生活层，信念+行动）
   - changes   {id, text, bookId, source, confirmed, createdAt}  ← 改变（周期分析提出，用户确认）
   - sessions  {id, bookId, chapterId, paraNum, quote, topic, msgs[], summary,
                createdAt, updatedAt}                   ← 共读会话（独立），结束生成 Session Summary
   - traces    {id, bookId, chapterId, paraNum, type, sessionId, summary, ts}
   - timeline  {id, kind, text, bookId, ts}
   - tags      {id, name, n}                            ← 主题标签库（跨书索引）
   - settings  {id:'coread', companionId, ctxMsgs, memShort, memLong, card,
                origLen, recall{bookU,bookQ,crossU,crossQ}, runChangeAuto}
   - state     {id:'reading', bookId, chapterId, paraNum, scrollRatio}
   - meta      {id:'change_last', at}                   ← 改变周期分析节流
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
/* 通用二次确认弹窗：resolve(true/false)，confirmText 为确认按钮文案 */
function uiConfirm(title, message, confirmText) {
  return new Promise((resolve) => {
    openSheet({
      title: title || '确认',
      html: `<div style="font-size:14px;line-height:1.8;color:var(--ink-2);margin-bottom:4px;">${esc(message || '确定要执行这个操作吗？')}</div>
        <div class="btn-row"><button class="btn-c" id="uiCancel">取消</button><button class="btn-p" id="uiOk" style="background:var(--danger);">${esc(confirmText || '确定')}</button></div>`,
      onOpen: (root, mask) => {
        root.querySelector('#uiCancel').addEventListener('click', () => { closeTopSheet(); resolve(false); });
        root.querySelector('#uiOk').addEventListener('click', () => { closeTopSheet(); resolve(true); });
        mask.addEventListener('click', (e) => { if (e.target === mask) { closeTopSheet(); resolve(false); } }, { once: true });
      },
    });
  });
}
function fmtDay(ts) { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; }
function fmtFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  return fmtDay(ts);
}

/* ───────── 类型体系 ───────── */
const TYPE_META = {
  '概念':     { label: '概念',   sub: '书本中的思想',  em: '◇' },
  '我的理解': { label: '理解',   sub: '你自己的理解',  em: '·' },
  '问题':     { label: '问题',   sub: '悬而未决',      em: '？' },
  '共鸣':     { label: '共鸣',   sub: '收藏的片段',    em: '♥' },
  '实践':     { label: '实践',   sub: '书进入生活',    em: '→' },
  '改变':     { label: '改变',   sub: '长期变化',      em: '◆' },
};
const TYPE_ORDER = ['概念', '我的理解', '问题', '共鸣', '实践', '改变'];
/* 3.1：AI 只被动建议「理解 / 问题」；共鸣/实践/改变必须用户主动 */
const AI_SUGGEST_TYPES = ['理解', '问题'];
/* 旧 2.0 类型的展示映射（不改库，只归组） */
function displayType(raw) {
  if (TYPE_META[raw]) return raw;
  if (raw === '悬题') return '问题';
  return '我的理解';  // 我的故事/闪回/延伸 → 理解
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
  const rows = await listCol(col);
  const found = rows.find(r => r.data && r.data.id === id);
  if (found) await A.db.delete(col, found.id);
}
/* 按关联字段删除某条记录在「阅读痕迹」里的对应痕迹，并刷新痕迹 */
async function removeTraceByRef(refKey, refVal) {
  const rows = await listCol('traces', true);
  for (const r of rows) {
    if (r.data && r.data[refKey] === refVal) await A.db.delete('traces', r.id);
  }
  updateAllTraces();
}
/* 删除时间线里某条记录（可选限定 bookId，供删除记录时联动清理） */
async function removeTimelineByText(text, opts) {
  const rows = await listCol('timeline');
  for (const r of rows) {
    if (!r.data) continue;
    const hit = opts && opts.bookId ? (r.data.bookId === opts.bookId && r.data.text === text) : (r.data.text === text);
    if (hit) await A.db.delete('timeline', r.id);
  }
}
async function listData(col) {
  const rows = await listCol(col);
  return rows.map(r => r.data).filter(Boolean);
}

/* ───────── 小模型（干杂活）AI helper ─────────
   共读回复走 ai.generate（大模型 + 角色链路，见 generateCoReply）。
   精炼 / 概念提取 / metadata / 召回筛选 / Session Summary / 改变分析这类轻活，
   统一走 ai.chat + apiConfigId 指向用户在小手机「设置 → API 设置」里配置的小模型。
   未配置 apiConfigId 时由宿主用默认配置，功能不中断。 */
async function lightAI({ messages, apiConfigId, timeoutMs }) {
  const cfgId = apiConfigId || (S.coset ? S.coset.smallApi : null);
  const params = { messages };
  if (cfgId) params.apiConfigId = cfgId;
  if (timeoutMs) params.timeoutMs = timeoutMs;
  return await A.ai.chat(params);
}
async function lightAIText(system, user, opts) {
  const r = await lightAI({ messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], ...opts });
  return String((r && (r.text || r.content)) || '').trim();
}

/* ───────── 主题标签库（用户浏览索引 + AI 检索索引共用） ───────── */
async function loadTags() { S.tags = await listData('tags'); return S.tags; }
async function allTagNames() {
  const t = await listData('tags');
  return t.sort((a, b) => (b.n || 0) - (a.n || 0)).map(x => x.name);
}
/* 归一化：trim/去重/复用已有名称，最多 5 个 */
async function normalizeTags(names) {
  const existing = await allTagNames();
  const out = [];
  for (const raw of (names || [])) {
    const n = String(raw).trim().replace(/\s+/g, ' ');
    if (!n || out.includes(n)) continue;
    if (existing.includes(n) && !out.includes(n)) out.push(n);
    else if (!existing.includes(n)) out.push(n);
  }
  return out.slice(0, 5);
}
async function bumpTags(names) {
  for (const n of (names || [])) {
    const rows = await listCol('tags');
    const f = rows.find(r => r.data && r.data.name === n);
    if (f) { f.data.n = (f.data.n || 0) + 1; await A.db.update('tags', f.id, f.data); }
    else await A.db.create('tags', { id: 'tag_' + uid(), name: n, n: 1 });
  }
}

/* ───────── 共读设置（浓缩卡 + 上下文档位 + 小模型 + 检索量） ───────── */
const DEFAULT_CARD = '性格：一位温和而有深度的共读者。\n说话方式：简短、真诚、口语化。\n共读方式：先复述你理解到的意思，再提一个真正值得想的问题。\n禁止：不要为了体现角色而故意反驳；不要为了显聪明而批判；不要为了人设扭曲书本内容；优先帮用户思考，而不是表演角色。';
function defaultCoset() {
  return {
    ctxMsgs: 10, memShort: 5, memLong: 3, card: '',
    smallApi: '',
    origLen: 2000,
    summaryLen: 800,
    recall: { bookU: 3, bookQ: 2, crossU: 2, crossQ: 1 },
    includeSummary: true, includeCard: true, includeMsgs: true,
    includeMemShort: true, includeMemLong: true, includeCore: true,
    includeCrossBook: true,
  };
}
async function loadCoreadSettings() {
  const rows = await listData('settings');
  const s = rows.find(x => x.id === 'coread');
  if (s) {
    S.companionId = s.companionId || null;
    const d = defaultCoset();
    S.coset = {
      ctxMsgs: s.ctxMsgs || d.ctxMsgs,
      memShort: s.memShort != null ? s.memShort : d.memShort,
      memLong: s.memLong != null ? s.memLong : d.memLong,
      card: s.card != null ? s.card : d.card,
      smallApi: s.smallApi != null ? s.smallApi : '',
      origLen: s.origLen || d.origLen,
      summaryLen: s.summaryLen || d.summaryLen,
      recall: Object.assign({}, d.recall, s.recall || {}),
      includeSummary: s.includeSummary != null ? s.includeSummary : true,
      includeCard: s.includeCard != null ? s.includeCard : true,
      includeMsgs: s.includeMsgs != null ? s.includeMsgs : true,
      includeMemShort: s.includeMemShort != null ? s.includeMemShort : true,
      includeMemLong: s.includeMemLong != null ? s.includeMemLong : true,
      includeCore: s.includeCore != null ? s.includeCore : true,
      includeCrossBook: s.includeCrossBook != null ? s.includeCrossBook : true,
    };
  } else {
    S.coset = defaultCoset();
  }
}
async function saveCoreadSettings() {
  await upsert('settings', {
    id: 'coread', companionId: S.companionId,
    ctxMsgs: S.coset.ctxMsgs, memShort: S.coset.memShort, memLong: S.coset.memLong,
    card: S.coset.card, smallApi: S.coset.smallApi, origLen: S.coset.origLen,
    summaryLen: S.coset.summaryLen,
    recall: S.coset.recall,
    includeSummary: S.coset.includeSummary, includeCard: S.coset.includeCard,
    includeMsgs: S.coset.includeMsgs, includeMemShort: S.coset.includeMemShort,
    includeMemLong: S.coset.includeMemLong, includeCore: S.coset.includeCore,
  });
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
      if (cur && cur.lines.some(l => l.trim())) chapters.push(cur);
      else if (cur) chapters.push(cur);
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
/* 以某段为中心向外取约 budget 字的上下文窗口（后台阅读单元） */
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

/* ───────── 全局状态 ───────── */
const S = {
  tab: 'desk',
  books: [], groups: [], insights: [], questions: [], timeline: [], tags: [],
  concepts: [], practices: [], changes: [], sessions: [], annotations: [],
  companionId: null,
  coset: defaultCoset(),
  rBook: null, rChapter: null, rChapters: [], rParas: [],
  rParaCur: 0, rParaLocal: 0, rUI: false, rMaxLoaded: 400, readerChapterIndex: 0,
  coSession: null, generating: false,
  mindFilter: 'all', mindBookId: null, mindView: 'timeline', mapTopic: null, mindQuery: '',
};/* ───────── 章节地图 / 精炼摘要（服务共读上下文，非用户总结） ───────── */
async function chapterSummary(ch) {
  if (!ch) return '';
  if (ch.summary && ch.summaryAt) return ch.summary;
  return null;  // 未生成
}
/* 分块：把整章文本切成若干块（每块约 maxLen 字），返回块数组 */
function chunkText(text, maxLen = 2600) {
  const paras = parasOf(text);
  const chunks = [];
  let cur = [], curLen = 0;
  for (const p of paras) {
    const add = p.t.length + 2;
    if (curLen + add > maxLen && cur.length) {
      chunks.push(cur.map(x => x.t).join('\n'));
      cur = []; curLen = 0;
    }
    cur.push(p); curLen += add;
  }
  if (cur.length) chunks.push(cur.map(x => x.t).join('\n'));
  return chunks.length ? chunks : [text];
}
/* 合并局部摘要为最终章节精炼（小模型），供共读上下文快速定位 */
async function mergeSummaryChunks(bookTitle, chTitle, chunks) {
  const len = S.coset.summaryLen || 800;
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = await lightAIText(
      '你是章节精炼助手。把一段章节原文压缩成一段局部摘要（要点式，保留核心内容/观点/论证结构/关键概念与关系），不要评价。',
      `《${bookTitle}》「${chTitle}」第 ${i + 1}/${chunks.length} 块原文：\n${chunks[i]}`,
      { apiConfigId: S.coset.smallApi, timeoutMs: 90000 }
    );
    if (part) parts.push(part);
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  /* 多块 → 合并成最终精炼 */
  const merged = await lightAIText(
    '你是章节精炼助手。把若干局部摘要合并成一章的最终「精炼」，覆盖整章：核心内容、作者主要观点、论证/思想推进结构、重要概念之间的关系、前后观点承接修正或转折、对理解本章非常重要的上下文。按【本章核心内容】【作者主要观点】【论证/结构】【重要关系/上下文】组织，最后单独【概念】列术语及本书定义（无则写【概念】无）。只写精炼本身，不要评价。',
    `《${bookTitle}》「${chTitle}」的局部摘要：\n${parts.join('\n---\n')}\n\n请合并为最终章节精炼，控制在约 ${len} 字。`,
    { apiConfigId: S.coset.smallApi, timeoutMs: 120000 }
  );
  return merged;
}
/* 章节精炼：进入章节时若无精炼先生成（章节地图），覆盖整章（分块总结），长度可配 */
async function generateChapterSummary(ch) {
  if (!ch || !ch.text || !S.companionId) return ch.summary || '';
  if (ch.summary && ch.summaryAt) return ch.summary;
  try {
    const chunks = chunkText(ch.text, 2600);
    const text = await mergeSummaryChunks(S.rBook ? S.rBook.title : '', ch.title, chunks);
    if (text) {
      ch.summary = text;
      ch.summaryAt = Date.now();
      const rows = await listCol('chapters');
      const found = rows.find(r => r.data && r.data.id === ch.id);
      if (found) await A.db.update('chapters', found.id, { ...found.data, summary: text, summaryAt: Date.now() });
      /* 顺带从精炼里提取概念入库 */
      await extractConceptsFromSummary(ch, text);
    }
    return ch.summary || '';
  } catch (e) { console.warn('chapter summary failed', e); return ch.summary || ''; }
}
/* 章末可选更新：以完整章节为依据对已有精炼做更新/修正（不是第一次生成） */
async function refreshChapterSummary(ch) {
  if (!ch || !ch.text || !S.companionId) return ch.summary || '';
  try {
    const chunks = chunkText(ch.text, 2600);
    const text = await mergeSummaryChunks(S.rBook ? S.rBook.title : '', ch.title, chunks);
    if (text) {
      ch.summary = text;
      ch.summaryAt = Date.now();
      const rows = await listCol('chapters');
      const found = rows.find(r => r.data && r.data.id === ch.id);
      if (found) await A.db.update('chapters', found.id, { ...found.data, summary: text, summaryAt: Date.now() });
      await extractConceptsFromSummary(ch, text);
    }
    return ch.summary || '';
  } catch (e) { console.warn('chapter summary refresh failed', e); return ch.summary || ''; }
}
/* 从章节精炼中解析【概念】区，提取书内概念入库（本书专属，不进跨书记忆） */
async function extractConceptsFromSummary(ch, summaryText) {
  if (!summaryText) return;
  const m = summaryText.match(/【概念】\s*([\s\S]*?)(?=\n【|$)/);
  const block = m ? m[1] : '';
  if (!block || /^\s*无\s*$/.test(block)) return;
  const rows = block.split(/\n/).map(s => s.trim()).filter(Boolean);
  const terms = [];
  for (const line of rows) {
    const mm = line.replace(/^[-·•]\s*/, '').match(/^(.+?)[:：]\s*(.+)$/);
    if (mm) terms.push({ term: mm[1].trim(), def: mm[2].trim() });
    else terms.push({ term: line.replace(/^[-·•]\s*/, '').split(/[:：]/)[0].trim(), def: line.replace(/^[-·•]\s*/, '').split(/[:：]/).slice(1).join('：').trim() });
  }
  const existing = (await listData('concepts')).filter(c => c.bookId === ch.bookId && c.chapterId === ch.id);
  for (const t of terms) {
    if (!t.term || !t.def) continue;
    if (existing.some(e => e.term === t.term)) continue;
    const rec = {
      id: 'con_' + uid(), bookId: ch.bookId, chapterId: ch.id,
      term: t.term, def: t.def,
      keywords: (S.books.find(b => b.id === ch.bookId) ? [S.books.find(b => b.id === ch.bookId).title] : []),
      createdAt: Date.now(),
    };
    await upsert('concepts', rec);
    existing.push(rec);
  }
}

/* ───────── 数据加载 ───────── */
async function loadAll() {
  const [books, groups, insights, questions, timeline, tags, concepts, practices, changes, sessions, annotations] = await Promise.all([
    listData('books'), listData('groups'), listData('insights'),
    listData('questions'), listData('timeline'), listData('tags'),
    listData('concepts'), listData('practices'), listData('changes'),
    listData('sessions'), listData('annotations'),
  ]);
  S.books = books; S.groups = groups; S.insights = insights;
  S.questions = questions; S.timeline = timeline;
  S.tags = tags.sort((a, b) => (b.n || 0) - (a.n || 0));
  S.concepts = concepts; S.practices = practices; S.changes = changes;
  S.sessions = sessions; S.annotations = annotations;
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
  // 兜底：章表缺失时从 content 现场切分
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

/* 查某本书的当前章节标题（用于书本卡片副标题） */
function bookCurrentChapterTitle(book) {
  if (!book || !book.chapterMeta || !book.chapterMeta.length) return '';
  const idx = book.chapterMeta.findIndex(c => c.cid === book.currentChapterId);
  return idx >= 0 ? (book.chapterMeta[idx].title || '') : '';
}
function bookBt(book) {
  return (book.format === 'epub' ? 'epub · ' : '');
}

/* ───────── 桌面 ───────── */
async function renderDesk() {
  S.tab = 'desk';
  setTabActive('desk');
  $id('p-desk').classList.add('active');
  $id('p-lib').classList.remove('active');
  $id('p-mind').classList.remove('active');
  const pl = $id('p-life');
  if (pl) pl.classList.remove('active');
  const reading = S.books.filter(b => b.lastReadAt).sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, 3);
  const latest = [...S.timeline].sort((a, b) => b.ts - a.ts)[0];
  let html = `<div class="h-row"><div><div class="h-page">书桌</div>
    <div class="h-sub">${new Date().toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
    <button class="h-btn" id="deskSettings">设置</button></div>`;
  html += '<div class="section-label">正 在 读</div>';
  if (reading.length) {
    html += reading.map(b => {
      const chTitle = bookCurrentChapterTitle(b);
      return `<div class="now-card card" data-bid="${esc(b.id)}">
        <div class="cover" style="background:${esc(b.coverColor || '#6f5d48')};">${esc((b.title || '书')[0])}</div>
        <div class="info"><div class="t">${esc(b.title)}</div>
        <div class="m">${chTitle ? esc(chTitle) : ''} · 上次 ${timeAgo(b.lastReadAt)}</div></div>
        <div class="go">›</div>
      </div>`;
    }).join('');
  } else {
    html += '<div class="empty">还没有在读的书<br>去书库导入一本吧</div>';
  }
  html += '<div class="section-label">最 近 留 下 的</div>';
  if (latest) {
    const book = S.books.find(b => b.id === latest.bookId);
    html += `<div class="pulse-strip"><div class="tt">${esc(latest.kind)}</div>
      <div class="bd">${esc(String(latest.text || '').slice(0, 60))}${String(latest.text || '').length > 60 ? '…' : ''}</div>
      <div class="mt">${book ? esc(book.title) + ' · ' : ''}${timeAgo(latest.ts)}</div></div>`;
  } else {
    html += '<div class="empty">还没有什么留下来<br>读着读着，会有的</div>';
  }
  $id('deskBody').innerHTML = html;
  const dst = $id('deskSettings');
  if (dst) dst.addEventListener('click', openCoreadSettings);
  $qa('#deskBody .now-card').forEach(c => c.addEventListener('click', () => openReader(c.dataset.bid)));
}

/* ───────── 书库 ───────── */
async function renderLib(groupId) {
  S.tab = 'lib';
  if (groupId !== undefined) S.currentGroup = groupId;
  setTabActive('lib');
  $id('p-lib').classList.add('active');
  $id('p-desk').classList.remove('active');
  $id('p-mind').classList.remove('active');
  const pl = $id('p-life');
  if (pl) pl.classList.remove('active');
  const cur = S.currentGroup || 'all';
  let filtered = S.books;
  if (cur !== 'all') {
    const g = S.groups.find(x => x.id === cur);
    filtered = g ? S.books.filter(b => (g.bookIds || []).includes(b.id)) : [];
  }
  let html = `<div class="h-page">书库</div>
    <div class="shelf-line">
      <button class="shelf-tab ${cur === 'all' ? 'active' : ''}" data-g="all">全部</button>
      ${S.groups.map(g => `<button class="shelf-tab ${cur === g.id ? 'active' : ''}" data-g="${esc(g.id)}">${esc(g.name)}</button>`).join('')}
      <button class="shelf-tab add" id="addGroupBtn">＋书单</button>
    </div>`;
  if (filtered.length) {
    html += filtered.map(b => {
      const pct = totalParas(b) ? Math.round((b.currentParaNum / totalParas(b)) * 100) : 0;
      return `<div class="book-card card" data-bid="${esc(b.id)}">
        <div class="cover" style="background:${esc(b.coverColor || '#6f5d48')};">${esc((b.title || '书')[0])}</div>
        <div class="info"><div class="t">${esc(b.title)}</div>
        <div class="m">${esc(b.author || '')} · ${bookBt(b)}${pct}%</div>
        <div class="p"><i style="width:${pct}%"></i></div></div>
        <button class="more" data-bid="${esc(b.id)}">⋯</button>
      </div>`;
    }).join('');
    html += `<button class="add-book-btn" id="addBookBtn">＋ 导入书籍</button>`;
  } else {
    html += `<div class="empty">${cur === 'all' ? '书库还空着' : '这个书单还没有书'}</div>
      <button class="add-book-btn" id="addBookBtn">＋ 导入书籍</button>`;
  }
  $id('libBody').innerHTML = html;
  /* 事件只绑定一次，避免多次渲染造成重复弹窗 */
  if (!$id('libBody')._libBound) {
    $id('libBody').addEventListener('click', (e) => {
      const moreBtn = e.target.closest('.more');
      if (moreBtn) { e.stopPropagation(); openBookMenu(moreBtn.dataset.bid); return; }
      const card = e.target.closest('.book-card');
      if (card) openReader(card.dataset.bid);
    });
    $id('libBody')._libBound = true;
  }
  const ab = $id('addBookBtn');
  if (ab) ab.addEventListener('click', openImportSheet);
  const agb = $id('addGroupBtn');
  if (agb) agb.addEventListener('click', openGroupEditor);
  $qa('#libBody .shelf-tab[data-g]').forEach(t => t.addEventListener('click', () => renderLib(t.dataset.g)));
}
function setTabActive(tab) {
  $qa('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}/* ───────── 打开阅读器 ───────── */
async function openReader(bookId, chapterIdTo, paraTo) {
  try {
    const book = S.books.find(b => b.id === bookId);
    if (!book) { toast('书不见了'); return; }
    S.rBook = book;
    S.rChapters = await ensureBookChapters(book);
    if (!S.rChapters.length) { toast('这本书还没有可读的正文'); return; }
    /* 定位章节：优先外部指定(id)，其次 book.currentChapterId，再回落第一章 */
    let ci = S.rChapters.findIndex(c => c.id === (chapterIdTo || book.currentChapterId));
    if (ci < 0) ci = 0;
    S.readerChapterIndex = ci;
    const ch = S.rChapters[ci];
    S.rChapter = ch;
    $id('rChapTitle').textContent = ch ? ch.title : '';
    /* 4.0 渲染携带问题胶囊 */
    renderCarryBar();
    /* 进入章节 → 章节预处理：若本章还没有精炼，后台预生成（章节地图），不重复生成 */
    if (ch && !ch.summary) {
      generateChapterSummary(ch).then(() => {
        /* 若已进入共读且正在用本章，刷新一次上下文展示 */
        if (S.coSession && S.coSession.chapterId === ch.id) renderCoHeader();
      });
    }
    /* 定位段落：paraTo / currentParaNum 一律按「全局段号」处理 */
    S.rParas = ch ? parasOf(ch.text) : [];
    const pBase = chapterParaStart(book, ch.id);
    const common = Math.max(1, totalParas(book));
    if (paraTo != null) {
      S.rParaCur = Math.max(0, Math.min(paraTo, common - 1));
    } else {
      S.rParaCur = Math.max(0, Math.min(book.currentParaNum || 0, common - 1));
    }
    S.rParaLocal = Math.max(0, Math.min(S.rParaCur - pBase, S.rParas.length - 1));
    const rScroll = $id('rScroll');
    rScroll.scrollTop = 0;
    $id('reader').classList.add('open');
    document.body.style.overflow = 'hidden';
    renderChapter();
    /* 恢复视野：优先章内精确滚动，其次段落锚定 */
    const savedRatio = parseFloat(book.currentScrollRatio || 0);
    requestAnimationFrame(() => {
      if (paraTo == null && savedRatio > 0 && savedRatio < 1 && isFinite(savedRatio)) {
        rScroll.scrollTop = savedRatio * (rScroll.scrollHeight - rScroll.clientHeight);
        setTimeout(() => recalcParaFromViewport(), 60);
      } else if (S.rParaLocal > 0) {
        scrollToLocalPara(S.rParaLocal);
      }
    });
    await saveProgress();
    await saveReadingState({ chapterId: ch ? ch.id : null, paraNum: S.rParaCur, scrollRatio: book.currentScrollRatio || 0 });
    loadCoSessionFor(ch ? ch.id : null).then(() => {});
    updateCompanionAvatar();
    S.rUI = false;
  } catch (e) {
    console.error('openReader:', e);
    toast('打开失败：' + (e && e.message ? e.message : e));
  }
}

/* ───────── 阅读页渲染 ───────── */
function renderChapter() {
  const inner = $id('rInner');
  if (!S.rChapter) { inner.innerHTML = '<div class="empty">这本书没有内容</div>'; return; }
  inner.innerHTML = chapterTitleHtml(S.rChapter, S.readerChapterIndex) + chapterSummaryCardHtml(S.rChapter) + renderParaBatch(S.rParas, 0, S.rMaxLoaded);
  bindChapterSummaryCard();
  applyTraceDots();
  const sc = $id('rScroll');
  if (sc._deepreadBatch) { sc.removeEventListener('scroll', sc._deepreadBatch); sc._deepreadBatch = null; }
  if (S.rParas.length > S.rMaxLoaded) {
    let loaded = S.rMaxLoaded;
    const addMore = () => {
      if (loaded >= S.rParas.length) return;
      const el = $id('rScroll');
      const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - 1400;
      if (nearBottom) {
        const div = document.createElement('div');
        div.innerHTML = renderParaBatch(S.rParas, loaded, loaded + 300);
        while (div.firstChild) inner.appendChild(div.firstChild);
        applyTraceDots();
        loaded += 300;
      }
    };
    sc._deepreadBatch = addMore;
    sc.addEventListener('scroll', addMore, { passive: true });
  }
}
function chapterTitleHtml(ch, idx) {
  const label = idx >= 0 ? `第 ${idx + 1} 节` : '';
  return `<div class="chap-num">${esc(label)}</div><div class="chap-title">${esc(ch.title)}</div>`;
}
/* 章节精炼卡片（书本层 UI）：精炼 = 这一章讲了什么；概念 = 本章内部的重要概念；正文 = 原始内容。
   自动生成 / 手动生成 / 手动更新都在这里。 */
function chapterSummaryCardHtml(ch) {
  if (!ch) return '';
  const hasSummary = !!(ch.summary && ch.summaryAt);
  const concepts = S.concepts ? S.concepts.filter(c => c.chapterId === ch.id) : [];
  return `<div class="ch-summary-card card" data-summary-card="${esc(ch.id)}">
    <div class="cs-head">
      <span class="cs-title">章节精炼</span>
      <span class="cs-state">${hasSummary ? '已生成' : '未生成'}</span>
    </div>
    ${hasSummary ? `<div class="cs-body"><div class="cs-text">${esc(ch.summary)}</div>
      ${concepts.length ? `<div class="cs-concepts"><b>本章概念：</b>${concepts.map(c => `<span class="cs-concept" data-cid="${esc(c.id)}">${esc(c.term)}</span>`).join('')}</div>` : ''}
      <div class="cs-actions"><button class="cs-btn" data-refresh="1">重新生成</button><button class="cs-btn cs-fold">收起</button></div></div>`
      : `<div class="cs-body"><div class="cs-empty">进入本章时自动生成精炼，供共读时快速定位本章内容。</div>
      <div class="cs-actions"><button class="cs-btn" data-gen="1">生成章节精炼</button></div></div>`}
  </div>`;
}
function bindChapterSummaryCard() {
  const card = $q('[data-summary-card]');
  if (!card) return;
  card.querySelector('[data-refresh]')?.addEventListener('click', async () => {
    toast('正在重新生成章节精炼…');
    await refreshChapterSummary(S.rChapter);
    renderChapter();
    toast('精炼已更新');
  });
  card.querySelector('[data-gen]')?.addEventListener('click', async () => {
    toast('正在生成章节精炼…');
    await generateChapterSummary(S.rChapter);
    renderChapter();
    toast('精炼已生成');
  });
  card.querySelector('.cs-fold')?.addEventListener('click', () => {
    const b = card.querySelector('.cs-body');
    if (b) b.style.display = b.style.display === 'none' ? '' : 'none';
  });
  card.querySelectorAll('.cs-concept[data-cid]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    openConceptDetail(el.dataset.cid);
  }));
}
function renderParaBatch(paras, from, to) {
  let html = '';
  for (let i = from; i < Math.min(to, paras.length); i++) {
    const p = paras[i];
    html += `<div class="para ${p.head ? 'head' : ''}" data-para-i="${i}">${esc(p.t)}</div>`;
  }
  return html;
}

/* ───────── 阅读器 UI：点击唤出/收起菜单 ─────────
   规则：点任意段落 → 唤出菜单；再次点击（不在菜单上）→ 收起菜单。
   文本选择（有选区）时，点击不触发 UI 切换。 */
function toggleReaderUI(force) {
  S.rUI = force != null ? force : !S.rUI;
  $id('reader').classList.toggle('ui', S.rUI);
  if (S.rUI) {
    $id('rProgress').textContent = progressLabel();
    $id('rChapTitle').textContent = S.rChapter ? S.rChapter.title : '';
  }
}
function closeReader() {
  saveProgress();
  if (S.rChapter) saveReadingState({ chapterId: S.rChapter.id, paraNum: S.rParaCur });
  $id('reader').classList.remove('open');
  document.body.style.overflow = '';
  S.rUI = false;
  $id('coDrawer').classList.remove('open');
}
function jumpReaderTo(chapterId, paraLocal) {
  const idx = S.rChapters.findIndex(c => c.id === chapterId);
  if (idx < 0) return;
  S.readerChapterIndex = idx;
  S.rChapter = S.rChapters[idx];
  S.rParas = parasOf(S.rChapter.text);
  S.rParaLocal = Math.max(0, paraLocal || 0);
  S.rParaCur = chapterParaStart(S.rBook, chapterId) + S.rParaLocal;
  S.rBook.currentChapterId = chapterId;
  S.rBook.currentParaNum = S.rParaCur;
  $id('rChapTitle').textContent = S.rChapter.title;
  renderChapter();
  saveProgress();
  saveReadingState({ chapterId, paraNum: S.rParaCur });
  $id('rNextHint').hidden = true;
  S.rUI = false;
}
function scrollToLocalPara(local) {
  const el = $q(`.para[data-para-i="${local}"]`);
  if (el) el.scrollIntoView({ block: 'center' });
  else $id('rScroll').scrollTop = 0;
}
function recalcParaFromViewport() {
  const sc = $id('rScroll');
  const paras = $qa('.para');
  if (!paras.length) return;
  let best = null, bestDist = Infinity;
  const targetY = sc.scrollTop + sc.clientHeight * 0.25;
  paras.forEach(p => {
    const r = p.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - targetY);
    if (d < bestDist) { bestDist = d; best = p; }
  });
  if (!best) return;
  const i = parseInt(best.dataset.paraI);
  const base = S.rChapter ? chapterParaStart(S.rBook, S.rChapter.id) : 0;
  S.rParaLocal = isNaN(i) ? 0 : i;
  S.rParaCur = base + S.rParaLocal;
  S.rBook.currentParaNum = S.rParaCur;
  $id('rProgress').textContent = progressLabel();
  /* 顺便存章内滚动比例，供下次精确恢复 */
  const max = sc.scrollHeight - sc.clientHeight;
  if (max > 0) S.rBook.currentScrollRatio = sc.scrollTop / max;
}
let _scrollTimer = null;
$id('rScroll').addEventListener('scroll', () => {
  clearTimeout(_scrollTimer);
  _scrollTimer = setTimeout(() => { recalcParaFromViewport(); checkChapterEnd(); saveProgress(); }, 260);
}, { passive: true });
function progressLabel() {
  const book = S.rBook;
  if (!book || !book.chapterMeta || !book.chapterMeta.length) return '';
  return `${S.readerChapterIndex + 1}/${book.chapterMeta.length} · 全书 ${Math.round((S.rParaCur / Math.max(1, totalParas(book))) * 100)}%`;
}
function checkChapterEnd() {
  const sc = $id('rScroll');
  const chip = $id('rNextHint');
  const next = S.rChapters[S.readerChapterIndex + 1];
  const atEnd = sc.scrollTop + sc.clientHeight > sc.scrollHeight - 80;
  if (next && atEnd) {
    chip.hidden = false;
    $id('rNextBtn').onclick = () => jumpReaderTo(next.id, 0);
    /* 读完整章 → 以完整章节为依据对已有精炼做更新/修正（节流：距上次生成>30s 才更新） */
    if (S.rChapter && !S.rChapter._refreshTriggered) {
      S.rChapter._refreshTriggered = true;
      if (S.rChapter.summary && S.rChapter.summaryAt && Date.now() - S.rChapter.summaryAt > 30000) {
        refreshChapterSummary(S.rChapter).then(() => {});
      } else if (!S.rChapter.summary) {
        generateChapterSummary(S.rChapter).then(() => {});
      }
    }
  } else chip.hidden = true;
}
async function saveProgress() {
  const b = S.rBook;
  if (!b) return;
  b.currentParaNum = S.rParaCur;
  b.lastReadAt = Date.now();
  const sc = $id('rScroll');
  const max = sc.scrollHeight - sc.clientHeight;
  b.currentScrollRatio = max > 0 ? sc.scrollTop / max : 0;
  await upsert('books', b);
}
async function saveReadingState(position) {
  if (!S.rBook) return;
  await upsert('state', { id: 'reading', bookId: S.rBook.id, chapterId: position.chapterId, paraNum: position.paraNum, scrollRatio: position.scrollRatio || 0, updatedAt: Date.now() });
}

/* 顶部/底部按钮 */
$id('rBack').addEventListener('click', closeReader);
$id('rToc').addEventListener('click', () => { openTocSheet(S.rBook.id, S.rChapter ? S.rChapter.id : null); });
$id('rDetail').addEventListener('click', () => { toggleReaderUI(false); openBookDetail(S.rBook.id); });
$id('rMind').addEventListener('click', () => {
  /* 阅读中看思想：抽屉式（不清空阅读状态，随时可回） */
  openMindDrawer();
});
$id('rCo').addEventListener('click', () => {
  if (!S.companionId) ensureCompanion().then(ok => ok && openCoRead('chapter', '', 0, 0));
  else openCoRead('chapter', '', 0, 0);
});

/* 点击正文唤出/收起菜单（有文本选区时不切换） */
$id('rScroll').addEventListener('click', (e) => {
  /* 排除：工具条、痕迹圆点、下一章浮层、共读抽屉覆盖 */
  if (e.target.closest('.sel-bar, .trace-dot, .chip-nav')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) {
    /* 有选区，稍等系统菜单，不立刻切换 UI；300ms 后仍无选区才弹 */
    const cur = sel.toString().trim();
    setTimeout(() => {
      const now = window.getSelection && window.getSelection();
      if (now && !now.isCollapsed) return;
      hideSelBar();
      toggleReaderUI();
    }, 60);
    return;
  }
  hideSelBar();
  toggleReaderUI(S.tapIntent);
});


/* ───────── 痕迹 ───────── */
async function loadTraces(bookId) {
  const rows = await listCol('traces', true);
  return rows.map(r => r.data).filter(t => t && t.bookId === bookId);
}
async function applyTraceDots() {
  if (!S.rBook || !S.rChapter) return;
  const inner = $id('rInner');
  if (!inner) return;
  inner.querySelectorAll('.trace-dot').forEach(d => d.remove());
  const traces = await loadTraces(S.rBook.id);
  const ch = S.rChapter;
  const base = chapterParaStart(S.rBook, ch.id);
  inner.querySelectorAll('.para').forEach(pEl => {
    const i = parseInt(pEl.dataset.paraI);
    if (isNaN(i)) return;
    const num = base + i;
    const hits = traces.filter(t => t.chapterId === ch.id && t.paraNum === num);
    if (!hits.length) return;
    const hasInsight = hits.some(t => t.type === 'insight');
    const hasQuestion = hits.some(t => t.type === 'question');
    const hasResonate = hits.some(t => t.type === 'resonate');
    /* 明显痕迹：整段下划线 + 段尾大圆点 */
    const mark = document.createElement('span');
    mark.className = 'trace-mark ' + (hasQuestion ? 'question' : hasInsight ? 'insight' : hasResonate ? 'resonate' : '');
    mark.innerHTML = '•';
    mark.title = (hasQuestion ? '悬题 ' : '') + (hasInsight ? '理解 ' : '') + (hasResonate ? '共鸣 ' : '');
    mark.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openTraceDetail(hits[0].id);
    });
    pEl.appendChild(mark);
    pEl.classList.add('has-trace', hasQuestion ? 't-question' : hasInsight ? 't-insight' : 't-resonate');
  });
}
function updateAllTraces() { applyTraceDots().then(() => {}); }
async function openTraceDetail(traceId) {
  const rows = await listCol('traces', true);
  const trace = rows.map(r => r.data).find(t => t && t.id === traceId);
  if (!trace) return;
  /* 直接跳转到对应内容的详情页，而非通用弹窗 */
  if (trace.insightId) {
    const ins = S.insights.find(i => i.id === trace.insightId);
    if (ins) { openInsightDetail(trace.insightId); return; }
  } else if (trace.questionId) {
    const q = S.questions.find(x => x.id === trace.questionId);
    if (q) { openQuestionDetail(trace.questionId); return; }
  } else if (trace.annotationId) {
    openResonateDetail(trace.annotationId); return;
  } else if (trace.type === 'coread' && trace.sessionId) {
    const sRows = await listCol('sessions');
    const sess = sRows.map(r => r.data).find(s => s && s.id === trace.sessionId);
    if (sess && sess.msgs) {
      S.coSession = sess;
      $id('coDrawer').classList.add('open');
      renderCoHeader();
      renderCoMsgs();
      return;
    }
  }
  /* 兜底：显示基本信息 */
  const lines = [];
  if (trace.summary) lines.push('「' + trace.summary + '」');
  openSheet({ title: '阅读痕迹', html: `<div style="font-size:13.5px;line-height:1.8;color:var(--ink-2);">${esc(lines.join('\n'))}</div>` });
}

/* ───────── 文本选择工具条（共读/共鸣/悬题/笔记） ───────── */
let selInfo = { text: '', para: 0, local: 0, chapId: null };
function buildSelBar() {
  const bar = $id('selBar');
  bar.innerHTML = `
    <button data-act="coread">共读</button>
    <button data-act="resonate">共鸣</button>
    <button data-act="question">悬题</button>
    <button data-act="understand">理解</button>
    <button data-act="practice">实践</button>`;
  bar.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    hideSelBar();
    handleSelAction(act);
  }));
}
function hideSelBar() { $id('selBar').classList.remove('show'); }
$id('rScroll').addEventListener('mouseup', onTextSelect);
$id('rScroll').addEventListener('touchend', onTextSelect);
function onTextSelect() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const text = sel.toString().trim();
  if (text.length < 2 || text.length > 600) { hideSelBar(); return; }
  let node = sel.anchorNode;
  let paraEl = null;
  while (node && node !== document.body) {
    if (node.nodeType === 1 && node.dataset && node.dataset.paraI !== undefined) { paraEl = node; break; }
    node = node.parentNode;
  }
  if (!paraEl) return;
  const i = parseInt(paraEl.dataset.paraI);
  const local = isNaN(i) ? 0 : i;
  const base = S.rChapter ? chapterParaStart(S.rBook, S.rChapter.id) : 0;
  selInfo = { text, para: base + local, local, chapId: S.rChapter ? S.rChapter.id : null };
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const bar = $id('selBar');
  bar.classList.add('show');
  bar.style.top = Math.max(24, rect.top - 64) + 'px';
  bar.style.left = Math.max(10, Math.min(rect.left + rect.width / 2 - 100, window.innerWidth - 220)) + 'px';
}
function handleSelAction(act) {
  const { text, para, local, chapId } = selInfo;
  if (!text) return;
  if (act === 'coread') openCoRead('quote', text, para, local);
  else if (act === 'resonate') saveResonate(text, para);
  else if (act === 'question') openQuestionSheet({ bookId: S.rBook ? S.rBook.id : null, chapterId: chapId, paraNum: para, quote: text, local });
  else if (act === 'understand') openUnderstandSheet(text, para);
  else if (act === 'practice') openPracticeSheet({ bookId: S.rBook ? S.rBook.id : null, chapterId: chapId, paraNum: para, quote: text });
}
/* 共鸣：用户主动收藏，不做 AI 判断 */
async function saveResonate(quote, para) {
  if (!S.rBook || !S.rChapter) return;
  const ann = {
    id: uid(), type: 'resonate', bookId: S.rBook.id, chapterId: S.rChapter.id,
    paraNum: para, selectedText: quote, content: '', fromWho: 'user', createdAt: Date.now(),
  };
  await upsert('annotations', ann);
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: S.rBook.id, chapterId: S.rChapter.id,
    paraNum: para, type: 'resonate', annotationId: ann.id,
    summary: quote.slice(0, 40), ts: Date.now(),
  });
  addTimelineEvent('收藏了一处共鸣', `「${quote.slice(0, 40)}${quote.length > 40 ? '…' : ''}」`, 'resonate');
  toast('已收藏为共鸣');
  updateAllTraces();
}
/* 选中文字 → 记录「理解」：直接写入思想库（我的理解），并在原文留下痕迹 */
function openUnderstandSheet(quote, para) {
  openSheet({
    title: '写下理解',
    html: `
      <div class="field"><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">「${esc(quote.slice(0, 100))}」</div></div>
      <div class="field"><label>我的理解</label><textarea id="uText" placeholder="我对这段话形成了什么看法…"></textarea></div>
      <div class="field"><label>主题标签（可选，逗号分隔）</label><input type="text" id="uTags" placeholder="如：臣服 / 行动"></div>
      <div class="btn-row"><button class="btn-c" id="uCancel">取消</button><button class="btn-p" id="uSave">保存为理解</button></div>`,
    onOpen: (root) => {
      root.querySelector('#uCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#uSave').addEventListener('click', async () => {
        const content = root.querySelector('#uText').value.trim();
        if (!content) { toast('写点内容'); return; }
        const tags = root.querySelector('#uTags').value.split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        closeTopSheet();
        await createInsight('我的理解', content, {
          tags,
          bookId: S.rBook ? S.rBook.id : null,
          chapterId: S.rChapter ? S.rChapter.id : null,
          paraNum: para, quote,
        });
        toast('已保存为理解');
      });
    },
  });
}/* ───────── 目录抽屉 ───────── */
function openTocSheet(bookId, currentChapterId) {
  const book = S.books.find(b => b.id === bookId);
  if (!book) return;
  const chapters = book.chapterMeta || [];
  const html = `<div class="s-title">目录</div>` +
    chapters.map((c, i) => {
      const isCur = c.cid === (currentChapterId || book.currentChapterId);
      return `<button class="row-btn${isCur ? ' current' : ''}" data-cid="${esc(c.cid)}" data-i="${i}"
        style="${isCur ? 'color:var(--accent);font-weight:600;' : 'display:flex;align-items:baseline;'}">
        <span style="font-size:12px;color:var(--ink-3);margin-right:10px;">${String(i + 1).padStart(2, '0')}</span>${esc(c.title)}
        ${c.summary ? '<span style="float:right;font-size:10px;color:var(--gold);">已建精炼</span>' : ''}
      </button>`;
    }).join('');
  openSheet({
    title: '目录', html,
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-cid]').forEach(btn => btn.addEventListener('click', () => {
        closeTopSheet();
        jumpReaderTo(btn.dataset.cid, 0);
      }));
    },
  });
}

/* ───────── 共读伙伴 & 浓缩卡 ───────── */
async function ensureCompanion() {
  if (S.companionId) return true;
  const chars = await A.characters.list();
  if (!chars.length) { toast('请先在聊天中创建角色'); return false; }
  if (chars.length === 1) {
    S.companionId = chars[0].id;
    await saveCoreadSettings();
    return true;
  }
  return await new Promise((resolve) => {
    openSheet({
      title: '选择共读伙伴',
      html: chars.map(c => `<div class="char-row" data-id="${esc(c.id)}"><div class="av">${esc((c.name || '?')[0])}</div><div style="font-size:14.5px;">${esc(c.name || '未命名')}</div></div>`).join(''),
      onOpen: (root, mask) => {
        root.querySelectorAll('.char-row').forEach(row => row.addEventListener('click', async () => {
          S.companionId = row.dataset.id;
          closeTopSheet();
          await saveCoreadSettings();
          await updateCompanionAvatar();
          resolve(true);
        }));
        mask.addEventListener('click', () => resolve(false), { once: true });
      },
    });
  });
}
async function updateCompanionAvatar() {
  const av = $id('rCoAvatar'), nm = $id('rCoName'), coAv = $id('coAvatar'), coNm = $id('coName');
  if (!S.companionId) {
    if (av) { av.textContent = '··'; av.classList.add('gray'); }
    if (nm) nm.textContent = '共读';
    if (coAv) coAv.textContent = '··';
    if (coNm) coNm.textContent = '共读';
    return;
  }
  try {
    const c = await A.characters.get(S.companionId);
    const name = c && c.name ? c.name : '共读';
    if (av) { av.textContent = name[0] || '·'; av.classList.remove('gray'); }
    if (nm) nm.textContent = name.length > 4 ? name.slice(0, 4) : name;
    if (coAv) coAv.textContent = name[0] || '·';
    if (coNm) coNm.textContent = name;
  } catch (e) {}
}

/* ───────── 共读会话 ───────── */
async function loadCoSessionFor(chapterId) {
  if (!S.rBook) return;
  const sessRows = await listCol('sessions');
  const found = sessRows.map(r => r.data)
    .filter(s => s && s.bookId === S.rBook.id && s.chapterId === chapterId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  S.coSession = found[0] || null;
}
async function openCoRead(mode, quote, paraNum, local) {
  const ok = await ensureCompanion();
  if (!ok) return;
  if (!S.rChapter) { toast('请先打开一本书'); return; }
  newCoSession(mode, quote, paraNum, local);
  /* 4.0：划线共读时抽屉降矮，正文留在视野上方——「在读中谈」，而不是挡住书 */
  const drawer = $id('coDrawer');
  drawer.classList.toggle('quote-mode', mode === 'quote');
  drawer.classList.add('open');
  if (mode === 'quote' && local >= 0) scrollToLocalPara(local);
  updateCompanionAvatar();
  renderCoHeader();
  renderCoMsgs();
}
function newCoSession(mode, quote, paraNum, local) {
  const chapter = S.rChapter;
  const topic = mode === 'quote' ? `划线共读 · ${chapter.title}` : `整章共读 · ${chapter.title}`;
  /* 只在内存里建会话；用户真正发出第一条消息时才落库生成话题，避免每次打开都产生空话题 */
  S.coSession = {
    id: 'sess_' + uid(),
    bookId: S.rBook.id, chapterId: chapter.id, chapterIdx: S.readerChapterIndex,
    paraNum: paraNum || 0, quote: quote || '', topic,
    msgs: [], createdAt: Date.now(), updatedAt: Date.now(),
    persisted: false,
  };
}
/* 用户首次发送消息时，才把会话正式写入数据库并留下痕迹 */
async function persistCoSession(s) {
  if (s.persisted) return;
  s.persisted = true;
  await upsert('sessions', s);
  const chapter = S.rChapters.find(c => c.id === s.chapterId) || null;
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: s.bookId, chapterId: s.chapterId,
    paraNum: s.paraNum || 0, type: 'coread', sessionId: s.id,
    summary: s.quote ? s.quote.slice(0, 40) : (chapter ? chapter.title : ''), ts: Date.now(),
  });
  addTimelineEvent('开始共读', `${S.rBook ? S.rBook.title : ''} · ${s.topic}`, 'coread', { bookId: s.bookId, chapterId: s.chapterId });
  updateAllTraces();
}
function renderCoHeader() {
  const s = S.coSession;
  if (!s) { $id('coTopic').textContent = '——'; $id('coQuote').hidden = true; return; }
  $id('coTopic').textContent = s.topic;
  const q = $id('coQuote');
  if (s.quote) {
    q.hidden = false;
    q.innerHTML = '<span class="qlabel">当前共读 · 原文</span>' + esc(s.quote);
  } else {
    /* 整章共读：只显示当前章节名，不显示整段文章内容 */
    q.hidden = false;
    const chTitle = S.rChapter ? S.rChapter.title : '';
    q.innerHTML = '<span class="qlabel">当前共读 · 章节</span>' + esc(chTitle);
  }
}
function renderCoMsgs() {
  const el = $id('coMsgs');
  const s = S.coSession;
  if (!s) { el.innerHTML = '<div class="typing">从书中划一段文字，或直接开始整章共读。</div>'; return; }
  let html = '';
  s.msgs.forEach(m => {
    if (m.kind === 'divider') { html += `<div class="sess-divider">${esc(m.label)}</div>`; return; }
    const isUser = m.role === 'user';
    /* 原文已在「当前共读 · 原文」处统一引用，消息内不再重复引用 */
    html += `<div class="msg ${isUser ? 'user' : 'ai'}">${esc(m.text)}</div>`;
    if (m.failed) html += `<button class="retry-btn" data-retry="1">↻ 重试这次共读</button>`;
  });
  el.innerHTML = html || '<div class="typing">说点什么，开始共读。</div>';
  el.scrollTop = el.scrollHeight;
  el.querySelectorAll('.retry-btn').forEach(btn => btn.addEventListener('click', () => retryCoMessage()));
}
async function sendCoMessage(msgText) {
  let s = S.coSession;
  if (!s || !msgText || S.generating) return;
  /* 首次发送时才正式生成话题并落库 */
  if (!s.persisted) await persistCoSession(s);
  s = S.coSession;
  S.generating = true;
  $id('coSend').disabled = true;
  s.msgs.push({ role: 'user', text: msgText, quote: s.quote || '', at: Date.now() });
  renderCoMsgs();
  const typingEl = document.createElement('div');
  typingEl.className = 'typing';
  typingEl.innerHTML = '<span class="spin"></span> 思考中…';
  $id('coMsgs').appendChild(typingEl);
  $id('coMsgs').scrollTop = $id('coMsgs').scrollHeight;
  try {
    const reply = await generateCoReply(msgText, s);
    s.msgs.push({ role: 'ai', text: reply, quote: s.quote || '', at: Date.now() });
    s.updatedAt = Date.now();
    await upsert('sessions', s);
  } catch (e) {
    console.error('coread:', e);
    s.msgs.push({ role: 'ai', text: '（这次共读没能接通）', failed: true, quote: '', at: Date.now() });
    await upsert('sessions', s);
  }
  typingEl.remove();
  renderCoMsgs();
  S.generating = false;
  $id('coSend').disabled = false;
}

/* 重试：找到最近一条失败的 AI 消息，重新生成 */
async function retryCoMessage() {
  const s = S.coSession;
  if (!s || !s.msgs.length || S.generating) return;
  const failIdx = s.msgs.map(m => m.role === 'ai' && m.failed).lastIndexOf(true);
  const lastUserIdx = s.msgs.map(m => m.role === 'user').lastIndexOf(true);
  if (failIdx < 0 || lastUserIdx < 0 || failIdx < lastUserIdx) return;
  const userMsg = s.msgs[lastUserIdx];
  s.msgs.splice(failIdx, 1);  // 移除失败气泡
  S.generating = true;
  $id('coSend').disabled = true;
  renderCoMsgs();
  const typingEl = document.createElement('div');
  typingEl.className = 'typing';
  typingEl.innerHTML = '<span class="spin"></span> 重新思考中…';
  $id('coMsgs').appendChild(typingEl);
  $id('coMsgs').scrollTop = $id('coMsgs').scrollHeight;
  try {
    const reply = await generateCoReply(userMsg.text, s);
    s.msgs.push({ role: 'ai', text: reply, quote: s.quote || '', at: Date.now() });
  } catch (e) {
    s.msgs.push({ role: 'ai', text: '（还是没能接通，请检查 API 设置）', failed: true, quote: '', at: Date.now() });
  }
  s.updatedAt = Date.now();
  await upsert('sessions', s);
  typingEl.remove();
  renderCoMsgs();
  S.generating = false;
  $id('coSend').disabled = false;
}

/* ───────── 三级检索架构（无向量模型） ─────────
   第一级：本地 metadata / 关键词 / 主题 结构初筛（几百条 → 20~50 条候选）
   第二级：小模型一次性相关性筛选（Session 开始时只跑一次）
   第三级：主模型只读最终筛选后的少量内容
   ─────────────────────────────────────── */
function recordTags(rec) { return Array.isArray(rec.tags) ? rec.tags : []; }
function recordKeywords(rec) { return Array.isArray(rec.keywords) ? rec.keywords : []; }
function recordTheme(rec) { return Array.isArray(rec.theme) ? rec.theme : []; }
/* 4.0：中文 3~4 字连续片段，用于正文重叠匹配（轻量、无需向量模型） */
function extractSegs(text, n) {
  const out = new Set();
  const s = String(text || '').replace(/[\s，。！？、；：""''（）\n]/g, '');
  if (s.length <= n) { if (s) out.add(s); return [...out]; }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return [...out];
}
function matchScore(rec, currentText) {
  let score = 0;
  const text = String(currentText || '');
  for (const t of recordTags(rec)) if (text.includes(t)) score += 3;
  for (const k of recordKeywords(rec)) if (text.includes(k)) score += 2;
  for (const th of recordTheme(rec)) if (text.includes(th)) score += 2;
  /* 4.0：记录正文（理解/问题/摘要）与当前讨论的文本重叠——
     这样 Session Summary 这类没有关键词的记录也能被召回（原来只比对 tags，永远命中不了） */
  const body = String(rec.text || '');
  if (body.length > 8) {
    for (const seg of extractSegs(text, 3)) {
      if (body.includes(seg)) score += 1;
      if (score > 12) break;
    }
  }
  return score;
}
/* 第一级：metadata 初筛，返回「编号目录」（不让主模型直接读全文） */
function stage1Candidates(currentText) {
  const cands = [];
  let seq = 0;
  const add = (rec, kind, bookKey) => {
    if (!rec) return;
    const score = matchScore(rec, currentText);
    if (score > 0) {
      seq++;
      cands.push({ no: seq, rec, kind, bookKey, score });
    }
  };
  const curBookId = S.rBook ? S.rBook.id : null;
  const curChId = S.rChapter ? S.rChapter.id : null;
  /* 本书理解 / 跨书理解 */
  for (const i of S.insights) {
    if (displayType(i.type) !== '我的理解') continue;
    add(i, '理解', i.bookId === curBookId ? '本书' : '跨书');
  }
  /* 本书问题 / 跨书问题 */
  for (const q of S.questions) add(q, '问题', q.bookId === curBookId ? '本书' : '跨书');
  /* 本书概念（可选，仅在匹配到时进入候选） */
  if (S.concepts) for (const c of S.concepts) add({ id: c.id, text: c.term + '：' + c.def, tags: c.keywords || [], keywords: c.keywords || [] }, '概念', c.bookId === curBookId ? '本书' : '跨书');
  /* 其他章节 / 其他 Session 摘要（命中才进候选） */
  if (S.sessions) for (const ss of S.sessions) {
    if (ss.summary) add({ id: ss.id, text: ss.summary, tags: [ss.topic], keywords: [] }, '会话摘要', ss.bookId === curBookId ? '本书' : '跨书');
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, 50);
}
/* 只给 AI 看的「编号目录」（不泄露全文） */
function stage1Catalog(cands) {
  return cands.map(c => `${String(c.no).padStart(3, '0')}：${c.kind}(${c.bookKey}) · ${String(c.rec.text || '').slice(0, 40)}`).join('\n');
}
function findCandByNo(cands, no) {
  return cands.find(c => c.no === no);
}
/* 第二级：小模型相关性筛选 —— Session 开始时调用一次，选出最终少量相关记录 */
async function stage2Filter(cands, currentText, chapterSummaryText) {
  if (!cands.length) return { kept: [], why: '' };
  const limits = S.coset ? S.coset.recall : { bookU: 3, bookQ: 2, crossU: 2, crossQ: 1 };
  try {
    const system = '你是共读检索助手。给你一批候选记录的「目录」，请只依据目录判断哪些与当前共读话题最相关。输出格式：一行选择，形如「相关：001,004,012」（用编号，逗号分隔），可空。不要输出解释。';
    const user = `当前共读：《${S.rBook ? S.rBook.title : ''}》${S.rChapter ? '第「' + S.rChapter.title + '」节' : ''}
当前讨论：${String(currentText).slice(0, 120)}
${chapterSummaryText ? '章节精炼：' + String(chapterSummaryText).slice(0, 200) + '\n' : ''}
候选目录：
${stage1Catalog(cands)}`;
    const out = await lightAIText(system, user, { apiConfigId: S.coset.smallApi, timeoutMs: 30000 });
    const nums = (String(out).match(/\d{3}/g) || []).map(n => parseInt(n, 10));
    const kept = [];
    for (const no of nums) { const c = findCandByNo(cands, no); if (c && !kept.includes(c)) kept.push(c); }
    return { kept, why: String(out).slice(0, 120) };
  } catch (e) {
    /* 小模型失败：回退到 top-N 候选 */
    return { kept: cands.slice(0, 8), why: 'fallback' };
  }
}
/* 组装最终可见的召回文本（分本书/跨书/概念/摘要） */
function recallToText(kept) {
  const lines = [];
  for (const c of kept) {
    const label = c.kind === '问题' ? '问题' : c.kind === '概念' ? '概念' : c.kind === '会话摘要' ? '会话摘要' : '理解';
    lines.push(`- [${label}·${c.bookKey}] ${String(c.rec.text || '').slice(0, 90)}`);
  }
  return lines.join('\n');
}

/* ───────── 共读 AI 生成（透明可配置上下文 + 三级检索 + 严格沉淀规则） ───────── */
/* 记录本次共读 AI 实际看到的上下文（供「本次共读上下文」查看） */
function emptyCtxLog() { return { origLen: 0, summary: false, bookU: 0, bookQ: 0, crossU: 0, crossQ: 0, concepts: 0, sessions: 0, card: false, msgs: 0, memShort: false, memLong: false, core: false, carried: 0, tokenEst: 0 }; }
let ctxLog = emptyCtxLog();
function resetCtxLog() { ctxLog = emptyCtxLog(); }
async function generateCoReply(userText, s) {
  const chapter = S.rChapters[S.readerChapterIndex] || S.rChapter;
  if (!chapter || !chapter.text) return '（这本书的章节暂时读不到原文，换个位置再共读吧）';
  const coset = S.coset || defaultCoset();
  const base = chapterParaStart(S.rBook, chapter.id);
  const local = Math.max(0, (s.paraNum || 0) - base);
  const origLen = parseInt(coset.origLen) || 2000;
  const unit = extractUnit(chapter.text, local, origLen);

  resetCtxLog();
  ctxLog.origLen = unit.length;

  /* ① 角色 / 聊天相关 */
  let cardText = '', memBlocks = [];
  if (coset.includeCard) {
    cardText = (coset.card && coset.card.trim()) ? coset.card.trim() : DEFAULT_CARD;
    ctxLog.card = true;
  }
  if (coset.includeCore && S.companionId) {
    try { const c = await A.memory.readCore({ characterId: S.companionId }); if (c && (c.items && c.items.length)) { memBlocks.push('【TA的核心记忆】\n' + (Array.isArray(c.items) ? c.items.map(x => x.content || x.text || String(x)).slice(0, coset.memLong).join('\n') : String(c).slice(0, 500))); ctxLog.core = true; } } catch (e) {}
  }
  if (coset.includeMemLong && S.companionId) {
    try { const l = await A.memory.readLongTerm({ characterId: S.companionId, query: userText.slice(0, 60) }); if (l && (l.items && l.items.length)) { memBlocks.push('【TA的长期记忆】\n' + (Array.isArray(l.items) ? l.items.slice(0, coset.memLong).map(x => x.content || x.text || String(x)).join('\n') : String(l).slice(0, 500))); ctxLog.memLong = true; } } catch (e) {}
  }

  /* ② 当前章节：精炼 + 原文窗口（精炼可开关；关闭则不生成也不注入） */
  let summary = '';
  if (coset.includeSummary !== false) {
    summary = await chapterSummary(chapter);
    if (!summary) summary = await generateChapterSummary(chapter);
    if (summary) ctxLog.summary = true;
  }

  /* ③ 本书其他章节 + ④ 跨书：三级检索 —— 每个 Session 只检索一次，结果缓存复用。
     若关闭全部跨书/召回开关则不注入任何召回。 */
  let recText = '';
  const recallOff = coset.includeCrossBook === false || (coset.recall && coset.recall.bookU === 0 && coset.recall.bookQ === 0 && coset.recall.crossU === 0 && coset.recall.crossQ === 0);
  if (!recallOff) {
    if (s && s.recall && s.recall.text) {
      recText = s.recall.text;
      ctxLog.bookU = s.recall.bookU || 0; ctxLog.bookQ = s.recall.bookQ || 0;
      ctxLog.crossU = s.recall.crossU || 0; ctxLog.crossQ = s.recall.crossQ || 0;
      ctxLog.concepts = s.recall.concepts || 0; ctxLog.sessions = s.recall.sessions || 0;
    } else {
      const rec = await buildRecall(userText + ' ' + (s.quote || ''), chapter, summary);
      recText = rec.text;
      if (s) {
        s.recall = { text: rec.text, bookU: ctxLog.bookU, bookQ: ctxLog.bookQ, crossU: ctxLog.crossU, crossQ: ctxLog.crossQ, concepts: ctxLog.concepts, sessions: ctxLog.sessions };
        if (s.persisted) await upsert('sessions', s);
      }
    }
  }

  /* 最近对话（可开关） */
  let recentMsgs = '';
  if (coset.includeMsgs !== false) {
    const nMsg = Math.max(2, Math.min(80, parseInt(coset.ctxMsgs) || 10));
    recentMsgs = s.msgs.slice(-nMsg).map(m => `${m.role === 'user' ? '你' : 'AI'}：${m.text}`).join('\n');
    ctxLog.msgs = Math.min(nMsg, s.msgs.length);
  }

  /* 4.0：用户「带着的问题」——新读到的内容优先去回应它们（跨书核心通道） */
  const carried = carriedQuestions();
  let carriedText = '';
  if (carried.length) {
    carriedText = carried.map((q, i) => `${i + 1}. ${q.text}${q.bookId && q.bookId !== S.rBook.id ? '（来自另一本书，仍在悬着）' : ''}`).join('\n');
    ctxLog.carried = carried.length;
  }

  const instruction = `你现在和「你」一起深读《${S.rBook.title}》，这一节是「${chapter.title}」。

【共读者人设卡】（这是你本场对话的身份与方式，代替完整角色背景）
${cardText || '（未使用角色卡）'}

${memBlocks.join('\n\n') ? memBlocks.join('\n\n') + '\n' : ''}【正在讨论的原文】${s.quote ? '用户划线的这句：「' + s.quote + '」' : '（整节共读，围绕刚才滚动到的段落）'}

【本节原文窗口（${origLen}字级）】
${unit}

${summary ? '【本节精炼（供快速定位上下文）】\n' + summary + '\n' : ''}

${recText ? '【TA的相关记录（智能召回的少量内容，仅作参考，若有关系再提）】\n' + recText + '\n' : ''}

${carriedText ? '【TA正带着的问题（在读中想继续想下去的；若当前内容与之有关请主动呼应，无关不必硬提）】\n' + carriedText + '\n' : ''}

【最近对话】
${recentMsgs}

【你刚说】
${userText}

【共读守则】
1. 你是共读者：先复述你对用户意思的理解，再追问/澄清/举例/比较/指出矛盾或给出不同读法；不写读书总结，不替用户下结论。
2. 围绕当前原文；引用原文时标注。不要无条件附和，有出入温和指出，有歧义承认歧义，不懂就说不知道。3～6 句为宜。
3. 概念与理解要分开：作者在书中提出的观点是「概念」（由章节精炼自动提取），你自己基于原文的判断与联想是「理解」。
4. 不要替用户总结人生，不要替用户制定实践方案，不要擅自宣布用户发生了变化。

【沉淀规则（严格）】
只有当你观察到用户形成了「值得长期保存」的理解或问题时，才在回复末尾单独输出一段：
【可能值得保存】
类型：理解 或 问题
内容：一句话
- 理解：用户形成了新的解释、判断、赞同/质疑，或由书引发的、可能长期成立的联想；
- 问题：无法一句话解决、值得继续思考/阅读/在生活中验证的开放问题。
禁止：
- 不要因为一句普通感想就输出；不要为了凑数而总结；
- 绝不建议「共鸣」（那是用户主动收藏的瞬间感受）；
- 绝不建议「实践」，更不要替用户设计行动方案；
- 绝不判断用户「改变了」；
- 不输出【概念】（概念由章节精炼自动提取）。
没有达到长期保存标准就不输出这段。`;

  const result = await A.ai.generate({
    characterId: S.companionId,
    appTags: ['deepread', 'coread'],
    instruction,
  });
  let reply = (result.text || '').trim();
  /* 解析「可能值得保存」（理解 / 问题，需用户确认才写入） */
  const sugMatch = reply.match(/【可能值得保存】[ \t]*\n?([\s\S]*)$/);
  if (sugMatch) {
    const body = sugMatch[1];
    const typeMatch = body.match(/类型[:：]\s*(理解|问题)\s*\n/);
    let type = null, content = null;
    if (typeMatch) {
      type = typeMatch[1] === '问题' ? '问题' : '理解';
      const rest = body.slice(typeMatch.index + typeMatch[0].length);
      const contentMatch = rest.match(/内容[:：]\s*([^\n]+)/);
      content = contentMatch ? contentMatch[1].trim() : rest.trim();
    } else content = body.trim();
    reply = reply.slice(0, sugMatch.index).trim();
    if (content) showSaveProposal(type || '理解', content, s);
  }
  /* 估算 token（粗略：1 汉字 ≈ 1.5 token） */
  ctxLog.tokenEst = Math.round((instruction.length + unit.length + summary.length + recentMsgs.length) * 1.4);
  return reply || '我在想。';
}
/* 构建三级检索的最终召回文本，并记录 ctxLog */
async function buildRecall(currentText, chapter, summary) {
  const coset = S.coset || defaultCoset();
  const cands = stage1Candidates(currentText);
  let kept = [];
  try {
    const { kept: k } = await stage2Filter(cands, currentText, summary);
    kept = k;
  } catch (e) { kept = cands.slice(0, 6); }
  /* 按类别统计数量（供透明查看） */
  for (const c of kept) {
    if (c.kind === '理解') { if (c.bookKey === '本书') ctxLog.bookU++; else ctxLog.crossU++; }
    else if (c.kind === '问题') { if (c.bookKey === '本书') ctxLog.bookQ++; else ctxLog.crossQ++; }
    else if (c.kind === '概念') ctxLog.concepts++;
    else if (c.kind === '会话摘要') ctxLog.sessions++;
  }
  /* 按用户设置的数量上限裁剪 */
  const lim = coset.recall || { bookU: 3, bookQ: 2, crossU: 2, crossQ: 1 };
  const filtered = [];
  const counts = { 本书理解: 0, 本书问题: 0, 跨书理解: 0, 跨书问题: 0 };
  const bookU = kept.filter(c => c.kind === '理解' && c.bookKey === '本书').slice(0, lim.bookU || 3);
  const bookQ = kept.filter(c => c.kind === '问题' && c.bookKey === '本书').slice(0, lim.bookQ || 2);
  const crossU = kept.filter(c => c.kind === '理解' && c.bookKey === '跨书').slice(0, lim.crossU || 2);
  const crossQ = kept.filter(c => c.kind === '问题' && c.bookKey === '跨书').slice(0, lim.crossQ || 1);
  const concepts = kept.filter(c => c.kind === '概念').slice(0, 2);
  const sessions = kept.filter(c => c.kind === '会话摘要').slice(0, 2);
  kept = [...bookU, ...bookQ, ...crossU, ...crossQ, ...concepts, ...sessions];
  return {
    text: recallToText(kept),
    bookU: bookU.length, bookQ: bookQ.length,
    crossU: crossU.length, crossQ: crossQ.length,
    concepts: concepts.length, sessions: sessions.length,
  };
}
/* 被动写入：AI 提出「可能值得保存」，用户确认后才写入 */
function showSaveProposal(type, content, s) {
  const msgs = $id('coMsgs');
  const div = document.createElement('div');
  div.className = 'sugg-card';
  div.innerHTML = `<div class="s-title">可能值得保存 · ${type === '问题' ? '问题' : '理解'}</div>
    <div>${esc(content)}</div>
    <div class="s-actions">
      <button class="s-save">保存</button>
      <button class="s-ignore">忽略</button>
    </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  div.querySelector('.s-save').addEventListener('click', async () => {
    div.remove();
    if (type === '问题') {
      await createQuestion({ text: content, tags: [], bookId: s.bookId, chapterId: s.chapterId, paraNum: s.paraNum, quote: s.quote });
      toast('问题已留下');
    } else {
      const ins = await createInsight('我的理解', content, { tags: [], bookId: s.bookId, chapterId: s.chapterId, paraNum: s.paraNum, quote: s.quote });
      genInsightMeta(ins);
      toast('理解已保存');
    }
  });
  div.querySelector('.s-ignore').addEventListener('click', () => div.remove());
}
/* 标签合并去重（限制 5 个） */
function mergeTags(arr) { return Array.from(new Set(arr.map(t => String(t).trim()).filter(Boolean))).slice(0, 5); }/* ───────── 创建记录：概念 / 我的理解 / 问题 / 实践 ───────── */
function normalize(s) { return String(s).trim().replace(/\s+/g, '-').slice(0, 16); }
async function createInsight(type, text, anchor) {
  const tags = mergeTags(anchor.tags || []);
  const root = {
    id: uid(), slug: normalize(text.slice(0, 12)), rootId: null,
    type, text, tags,
    keywords: tags.slice(0, 3),
    theme: anchor.theme || [],
    bookId: anchor.bookId, chapterId: anchor.chapterId,
    paraNum: anchor.paraNum || 0, quote: anchor.quote || '',
    practiceKind: anchor.practiceKind || '',
    createdAt: Date.now(), updatedAt: Date.now(), growthAt: Date.now(),
  };
  await upsert('insights', root);
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: anchor.bookId, chapterId: anchor.chapterId,
    paraNum: anchor.paraNum || 0, type: 'insight', insightId: root.id,
    summary: text.slice(0, 40), ts: Date.now(),
  });
  if (tags.length) await bumpTags(tags);
  addTimelineEvent(type === '实践' ? '记录了实践' : type === '概念' ? '记下概念' : '留下理解',
    `「${type}」${text}`, 'insight', anchor);
  S.insights.push(root);
  updateAllTraces();
  return root;
}
/* 更新已有理解（支持同一理解随新认识继续更新） */
async function updateInsight(id, patch) {
  const rows = await listCol('insights');
  const found = rows.find(r => r.data && r.data.id === id);
  if (!found) return;
  const merged = { ...found.data, ...patch, updatedAt: Date.now() };
  await A.db.update('insights', found.id, merged);
  const idx = S.insights.findIndex(i => i.id === id);
  if (idx >= 0) S.insights[idx] = merged;
  return merged;
}
/* 保存理解后由小模型生成少量 metadata（关键词/主题/相关概念），失败静默 */
async function genInsightMeta(insight) {
  if (!insight || insight.metaDone) return;
  try {
    const text = await lightAIText(
      '你是阅读助手。为一条读者的「理解」生成少量元数据，只输出三行：关键词（3-5个，顿号分隔）、主题（1-3个，顿号分隔）、相关概念（可空，顿号分隔）。不要输出其他内容。',
      `理解：${insight.text}${insight.quote ? '\n原文：「' + insight.quote.slice(0, 120) + '」' : ''}`,
      { apiConfigId: S.coset.smallApi, timeoutMs: 30000 }
    );
    const k = text.match(/关键词[：:]\s*(.+)/);
    const th = text.match(/主题[：:]\s*(.+)/);
    const c = text.match(/相关概念[：:]\s*(.+)/);
    const patch = {
      keywords: k ? k[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5) : insight.keywords,
      theme: th ? th[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 3) : insight.theme,
      relatedConcepts: c && c[1].trim() !== '无' && c[1].trim() ? c[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5) : [],
      metaDone: true,
    };
    await updateInsight(insight.id, patch);
  } catch (e) {}
}
/* 保存问题后由小模型生成少量 metadata（关键词/主题/相关概念），失败静默 */
async function genQuestionMeta(question) {
  if (!question || question.metaDone) return;
  try {
    const text = await lightAIText(
      '你是阅读助手。为读者的一条「问题」生成少量元数据，只输出三行：关键词（3-5个，顿号分隔）、主题（1-3个，顿号分隔）、相关概念（可空，顿号分隔）。不要输出其他内容。',
      `问题：${question.text}${question.quote ? '\n原文：「' + question.quote.slice(0, 120) + '」' : ''}`,
      { apiConfigId: S.coset.smallApi, timeoutMs: 30000 }
    );
    const k = text.match(/关键词[：:]\s*(.+)/);
    const th = text.match(/主题[：:]\s*(.+)/);
    const c = text.match(/相关概念[：:]\s*(.+)/);
    const patch = {
      keywords: k ? k[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5) : question.keywords,
      theme: th ? th[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 3) : question.theme,
      relatedConcepts: c && c[1].trim() !== '无' && c[1].trim() ? c[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5) : [],
      metaDone: true,
    };
    await updateQuestion(question.id, patch);
  } catch (e) {}
}
async function updateQuestion(id, patch) {
  const rows = await listCol('questions');
  const found = rows.find(r => r.data && r.data.id === id);
  if (!found) return;
  const merged = { ...found.data, ...patch, updatedAt: Date.now() };
  await A.db.update('questions', found.id, merged);
  const idx = S.questions.findIndex(q => q.id === id);
  if (idx >= 0) S.questions[idx] = merged;
  return merged;
}
/* growth：把后续理解归入同一思想 */
async function growInsight(parentId, type, text, anchor) {
  const parent = S.insights.find(i => i.id === parentId);
  if (!parent) return createInsight(type, text, anchor);
  const merged = mergeTags([...(parent.tags || []), ...(anchor.tags || [])]);
  const g = {
    id: uid(), slug: parent.slug, rootId: parentId,
    type: type || parent.type, text, tags: merged,
    bookId: anchor.bookId, chapterId: anchor.chapterId,
    paraNum: anchor.paraNum || 0, quote: anchor.quote || '',
    createdAt: Date.now(), growthAt: Date.now(),
  };
  await upsert('insights', g);
  if (merged.length) {
    parent.tags = merged;
    await upsert('insights', parent);
    await bumpTags(merged);
  }
  S.insights.push(g);
  updateAllTraces();
  return g;
}
async function createQuestion(q) {
  const tags = mergeTags(q.tags || []);
  const rec = {
    id: uid(), text: q.text, tags,
    keywords: tags.slice(0, 3),
    bookId: q.bookId, chapterId: q.chapterId,
    paraNum: q.paraNum || 0, quote: q.quote || '',
    /* 4.0：问题是一条生命线，不是一次性 FAQ。
       status 不再有终局；answers 累积每次回应；carrying 表示「带着它继续读」。 */
    status: 'open', answers: [], answerText: '', answeredAt: null,
    carrying: false, createdAt: Date.now(),
  };
  await upsert('questions', rec);
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: q.bookId, chapterId: q.chapterId,
    paraNum: q.paraNum || 0, type: 'question', questionId: rec.id,
    summary: q.text.slice(0, 40), ts: Date.now(),
  });
  if (tags.length) await bumpTags(tags);
  addTimelineEvent('留下悬题', q.text, 'question', { bookId: q.bookId, chapterId: q.chapterId });
  S.questions.push(rec);
  updateAllTraces();
  genQuestionMeta(rec).then(() => {});
}
/* ───────── 实践（生活层：信念 + 行动，用户主动填写） ───────── */
async function createPractice(p) {
  const rec = {
    id: 'pr_' + uid(),
    belief: (p.belief || '').trim(),
    action: (p.action || '').trim(),
    bookId: p.bookId || null,
    linkType: p.linkType || null,   // 'insight' | 'question' | null
    linkId: p.linkId || null,
    status: p.status || '进行中',   // 进行中 / 尝试过 / 已内化 / 放下了
    notes: p.notes || [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await upsert('practices', rec);
  S.practices.push(rec);
  addTimelineEvent('记录了实践', `${rec.belief}${rec.action ? ' → ' + rec.action : ''}`, 'practice', { bookId: rec.bookId });
  toast('实践已记录');
  return rec;
}
async function updatePractice(id, patch) {
  const rows = await listCol('practices');
  const found = rows.find(r => r.data && r.data.id === id);
  if (!found) return;
  const merged = { ...found.data, ...patch, updatedAt: Date.now() };
  await A.db.update('practices', found.id, merged);
  const idx = S.practices.findIndex(p => p.id === id);
  if (idx >= 0) S.practices[idx] = merged;
  return merged;
}
/* 实践表单：信念 + 行动（AI 不替用户制定方案，完全由用户主动填写） */
function openPracticeSheet(init) {
  init = init || {};
  openSheet({
    title: '记录实践',
    html: `
      <div class="field"><label>信念（我认同什么）</label><textarea id="pBelief" placeholder="如：休息不是浪费时间。">${init.belief ? esc(init.belief) : ''}</textarea></div>
      <div class="field"><label>行动（我打算怎么做 / 做了什么）</label><textarea id="pAction" placeholder="如：工作很累时允许自己真正停下来。">${init.action ? esc(init.action) : ''}</textarea></div>
      <div class="field"><label>状态</label>
        <div class="type-chips" id="pStatusWrap">
          ${['进行中', '尝试过', '已内化', '放下了'].map(st => `<button class="type-chip${(init.status || '进行中') === st ? ' sel' : ''}" data-st="${st}">${st}</button>`).join('')}
        </div></div>
      ${init.quote ? `<div class="field"><label>来自原文</label><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">「${esc(init.quote.slice(0, 80))}」</div></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="pCancel">取消</button><button class="btn-p" id="pSave">保存</button></div>`,
    onOpen: (root) => {
      let status = init.status || '进行中';
      root.querySelectorAll('.type-chip[data-st]').forEach(ch => ch.addEventListener('click', () => {
        root.querySelectorAll('.type-chip[data-st]').forEach(c => c.classList.remove('sel'));
        ch.classList.add('sel');
        status = ch.dataset.st;
      }));
      root.querySelector('#pCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#pSave').addEventListener('click', async () => {
        const belief = root.querySelector('#pBelief').value.trim();
        const action = root.querySelector('#pAction').value.trim();
        if (!belief && !action) { toast('写点内容'); return; }
        closeTopSheet();
        if (init.id) await updatePractice(init.id, { belief, action, status });
        else await createPractice({
          belief, action, status,
          bookId: init.bookId || (S.rBook ? S.rBook.id : null),
          linkType: init.linkType, linkId: init.linkId,
        });
      });
    },
  });
}
/* 通用沉淀表单：3.1 只用于「我的理解」（概念/实践/改变走各自独立表单与表） */
function openInsightSheet(init) {
  init = init || {};
  openSheet({
    title: '写下理解',
    html: `
      <div class="field"><label>内容</label><textarea id="itText" placeholder="写下此刻的理解…">${init.text ? esc(init.text) : ''}</textarea></div>
      <div class="field"><label>主题标签（2-5 个，逗号分隔，尽量复用旧标签）</label>
        <input type="text" id="itTags" placeholder="如：控制 / 安全感 / 臣服">${init.tags && init.tags.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--gold);">建议：${init.tags.map(t => esc(t)).join(' · ')}</div>` : ''}</div>
      ${init.quote ? `<div class="field"><label>来自原文</label><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">「${esc(init.quote.slice(0, 80))}」</div></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="itCancel">取消</button><button class="btn-p" id="itSave">保存</button></div>`,
    onOpen: (root) => {
      root.querySelector('#itCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#itSave').addEventListener('click', async () => {
        const text = root.querySelector('#itText').value.trim();
        if (!text) { toast('写点内容'); return; }
        const tags = root.querySelector('#itTags').value.split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        closeTopSheet();
        const ins = await createInsight('我的理解', text, {
          tags,
          bookId: S.rBook ? S.rBook.id : (init.bookId || null),
          chapterId: S.rChapter ? S.rChapter.id : (init.chapterId || null),
          paraNum: S.rChapter ? S.rParaCur : (init.paraNum || 0),
          quote: init.quote || '',
        });
        genInsightMeta(ins);
        toast('已保存为理解');
      });
    },
  });
}
function openQuestionSheet(init) {
  init = init || {};
  openSheet({
    title: '留下悬题',
    html: `
      <div class="field"><label>问题</label><textarea id="qText" placeholder="什么让你悬而未决？">${init.text ? esc(init.text) : ''}</textarea></div>
      <div class="field"><label>主题标签（可选，逗号分隔）</label><input type="text" id="qTags" placeholder="如：控制 / 自由"></div>
      ${init.quote ? `<div class="field"><label>来自原文</label><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">「${esc(init.quote.slice(0, 80))}」</div></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="qCancel">取消</button><button class="btn-p" id="qSave">留下</button></div>`,
    onOpen: (root) => {
      root.querySelector('#qCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#qSave').addEventListener('click', async () => {
        const text = root.querySelector('#qText').value.trim();
        if (!text) { toast('写点内容'); return; }
        const tags = root.querySelector('#qTags').value.split(/[,，、]/).map(t => t.trim()).filter(Boolean);
        closeTopSheet();
        await createQuestion({
          text, tags,
          bookId: init.bookId || (S.rBook ? S.rBook.id : null),
          chapterId: init.chapterId || (S.rChapter ? S.rChapter.id : null),
          paraNum: init.paraNum || S.rParaCur || 0,
          quote: init.quote || '',
        });
        toast('悬题已留下');
      });
    },
  });
}
/* 4.0 悬题回应：追加到问题的生命线上，同时沉淀为一条「我的理解」。
   问题不设终局——每次阅读/生活都可能带来新的回应，全部累积。 */
async function addQuestionAnswer(q, text) {
  const content = (text || q.answerText || '').trim();
  if (!content) return false;
  if (!Array.isArray(q.answers)) q.answers = [];
  q.answers.push({ text: content, at: Date.now() });
  q.answerText = content;
  q.answeredAt = Date.now();
  q.status = 'open';  // 一直悬着，等下一次回应
  await upsert('questions', q);
  await createInsight('我的理解', content, {
    tags: q.tags || [],
    bookId: q.bookId, chapterId: q.chapterId, paraNum: q.paraNum, quote: q.quote,
  });
  addTimelineEvent('旧问题收到新回应', `${q.text} → ${content}`, 'question', { bookId: q.bookId, chapterId: q.chapterId });
  return true;
}
/* 4.0 携带问题：把问题「带着」继续读，阅读器顶部会出现胶囊，共读时作为上下文注入。 */
async function toggleCarryQuestion(id, carrying) {
  const rows = await listCol('questions');
  const found = rows.find(r => r.data && r.data.id === id);
  if (!found) return false;
  found.data.carrying = !!carrying;
  await A.db.update('questions', found.id, found.data);
  const idx = S.questions.findIndex(x => x.id === id);
  if (idx >= 0) S.questions[idx] = found.data;
  toast(carrying ? '已带着它继续读' : '不再带着它读了');
  return true;
}
function carriedQuestions() {
  return (S.questions || []).filter(q => q.carrying).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
/* 4.0 阅读器顶部携带问题胶囊：显示正带着的问题，点击可查看该问题 */
async function renderCarryBar() {
  const bar = $id('rCarryBar');
  if (!bar) return;
  const carried = carriedQuestions();
  if (!carried.length) {
    bar.hidden = true; bar.innerHTML = '';
    $id('reader').classList.remove('has-carry');
    return;
  }
  bar.hidden = false;
  $id('reader').classList.add('has-carry');
  bar.innerHTML = '<span class="carry-label">带着</span>' + carried.slice(0, 3).map(q =>
    `<button class="carry-item" data-qid="${esc(q.id)}">✈ ${esc(String(q.text).slice(0, 16))}${q.text.length > 16 ? '…' : ''}</button>`
  ).join('') + (carried.length > 3 ? '<button class="carry-item" id="carryMore">+更多</button>' : '');
  bar.querySelectorAll('.carry-item[data-qid]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleReaderUI(false);
    openQuestionDetail(b.dataset.qid);
  }));
  const more = bar.querySelector('#carryMore');
  if (more) more.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleReaderUI(false);
    openCarryList();
  });
}
function openCarryList() {
  const carried = carriedQuestions();
  openSheet({
    title: '正带着的问题',
    html: carried.length ? carried.map(q => {
      const book = S.books.find(b => b.id === q.bookId);
      return `<div class="row-btn" data-qid="${esc(q.id)}"><span style="color:var(--gold);font-size:10px;">✈ 带着</span> ${esc(q.text)}<div style="font-size:11px;color:var(--ink-3);margin-top:3px;">${book ? esc(book.title) : '无出处'} · 悬着</div></div>`;
    }).join('') : '<div class="empty">现在没有带着的问题<br>去「思想 → 问题」把想继续想下去的设为带着读</div>',
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-qid]').forEach(b => b.addEventListener('click', () => { closeTopSheet(); openQuestionDetail(b.dataset.qid); }));
    },
  });
}
function openAnswerSheet(q) {
  openSheet({
    title: '这个悬题，你怎么想？',
    html: `
      <div class="field"><div style="font-size:13.5px;line-height:1.7;color:var(--ink);">${esc(q.text)}</div></div>
      <div class="field"><label>我的回应（新的一次想法）</label><textarea id="qAns" placeholder="此刻你是怎么想的…"></textarea></div>
      <div class="btn-row"><button class="btn-c" id="qCancel">取消</button><button class="btn-p" id="qSave">留下回应，沉淀为「我的理解」</button></div>`,
    onOpen: (root) => {
      root.querySelector('#qCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#qSave').addEventListener('click', async () => {
        const text = root.querySelector('#qAns').value.trim();
        if (!text) { toast('写点内容'); return; }
        closeTopSheet();
        await addQuestionAnswer(q, text);
        toast('回应已留下，这条问题继续悬着');
      });
    },
  });
}

/* ───────── Session Summary（小模型生成） ─────────
   Session 结束时生成一份简短「本次共读摘要」：讨论了什么、形成了哪些观点、
   出现了哪些问题、讨论发生了什么变化。不是 Insight，只压缩记录对话。 */
/* 把完整对话转成文本（供摘要分块），每轮不截断关键内容 */
function sessionMsgsText(s) {
  return (s.msgs || []).map(m => `${m.role === 'user' ? '你' : 'AI'}：${m.text}`).join('\n');
}
async function generateSessionSummary(s) {
  if (!s || !s.msgs || !s.msgs.length) return;
  if (s.summary) return s.summary;
  try {
    const full = sessionMsgsText(s);
    /* 对话较长时分块生成局部摘要，再合并最终摘要（保留全程转折与未解问题） */
    const maxChars = 9000;
    let parts;
    if (full.length <= maxChars) {
      parts = [full];
    } else {
      const chunks = [];
      let cur = '';
      for (const line of full.split('\n')) {
        if (cur.length + line.length > maxChars && cur) { chunks.push(cur); cur = ''; }
        cur += line + '\n';
      }
      if (cur) chunks.push(cur);
      parts = [];
      for (let i = 0; i < chunks.length; i++) {
        const p = await lightAIText(
          '你是共读摘要助手。给一段共读对话生成局部摘要（要点式）：讨论了什么、用户形成了哪些观点、提出了什么问题、有什么转折。只压缩记录，不要评价。',
          `共读话题：${s.topic}${s.quote ? '\n原文：「' + s.quote.slice(0, 80) + '」' : ''}\n\n第 ${i + 1}/${chunks.length} 段对话：\n${chunks[i]}`,
          { apiConfigId: S.coset.smallApi, timeoutMs: 60000 }
        );
        if (p) parts.push(p);
      }
    }
    if (!parts.length) return '';
    const finalText = parts.length === 1 ? parts[0] : await lightAIText(
      '你是共读摘要助手。把若干局部摘要合并成一份完整的「本次共读摘要」（4-8 句）：这次主要讨论了什么、用户形成了哪些理解、提出了什么问题、讨论发生了什么变化、最后留下什么未解决内容。只压缩记录，不要评价用户。',
      `共读话题：${s.topic}\n局部摘要：\n${parts.join('\n---\n')}`,
      { apiConfigId: S.coset.smallApi, timeoutMs: 90000 }
    );
    if (finalText) {
      s.summary = finalText;
      s.summaryAt = Date.now();
      await upsert('sessions', s);
    }
    return finalText;
  } catch (e) { return ''; }
}
/* 结束时生成摘要（收起共读抽屉时触发一次） */
async function finalizeCoSession() {
  if (S.coSession && S.coSession.persisted && S.coSession.msgs && S.coSession.msgs.length >= 2 && !S.coSession.summary) {
    const s = S.coSession;
    generateSessionSummary(s).then(() => {});
  }
}

/* 4.0 刷新共读位置：让会话原文窗口跟随当前阅读段落，携带的问题同步刷新。 */
async function refreshCoPosition() {
  const s = S.coSession;
  if (!s || !S.rChapter) { toast('没有活跃的共读会话'); return; }
  const base = chapterParaStart(S.rBook, S.rChapter.id);
  const local = Math.max(0, S.rParaLocal);
  s.paraNum = base + local;
  s.quote = '';
  /* 清除旧召回缓存，下次消息会重建 */
  if (s.recall) delete s.recall;
  if (s.persisted) await upsert('sessions', s);
  renderCoHeader();
  toast(`位置已刷新到当前段落`);
}

/* ───────── 共读抽屉事件 ───────── */
$id('coClose').addEventListener('click', () => { finalizeCoSession(); $id('coDrawer').classList.remove('open'); });
$id('coSend').addEventListener('click', () => {
  const input = $id('coInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendCoMessage(text);
});
$id('coInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $id('coSend').click(); } });
$id('coSaveI').addEventListener('click', () => openInsightSheet({ quote: S.coSession ? S.coSession.quote : '' }));
$id('coSaveQ').addEventListener('click', () => {
  if (!S.rBook || !S.rChapter) return;
  openQuestionSheet({ bookId: S.rBook.id, chapterId: S.rChapter.id, paraNum: S.rParaCur, quote: S.coSession ? S.coSession.quote : '' });
});
$id('coSess').addEventListener('click', openSessionList);
$id('coRefresh').addEventListener('click', refreshCoPosition);
/* 本次共读上下文查看入口：透明展示这一轮 AI 实际看到了什么 */
$id('coCtx').addEventListener('click', openCtxView);
function openCtxView() {
  const l = ctxLog;
  const row = (label, v) => `<div style="display:flex;justify-content:space-between;padding:7px 2px;border-bottom:1px solid var(--line-soft);font-size:13.5px;"><span>${label}</span><span style="color:${v ? 'var(--accent)' : 'var(--ink-3)'};">${v ? '✓' : '✗'}</span></div>`;
  const detail = l.origLen > 0
    ? row('当前原文', `✓ ${l.origLen}字`) + row('章节精炼', l.summary) + row('本章相关理解', `✓ ${l.bookU}条`) + row('本章相关问题', `✓ ${l.bookQ}条`) + row('其他章节', l.crossU > 0 || l.crossQ > 0 ? '✓' : false) + row('跨书', (l.crossU + l.crossQ) > 0 ? `✓ ${l.crossU + l.crossQ}条` : false) + row('概念引用', l.concepts > 0 ? `✓ ${l.concepts}条` : false) + row('角色浓缩人设', l.card) + row('最近对话', `✓ ${l.msgs}条`) + row('核心记忆', l.core) + row('长期记忆', l.memLong) + row('带着的问题', l.carried > 0 ? `✓ ${l.carried}条` : false) + row('预估 token', `~${l.tokenEst}`)
    : '<div class="empty">开始一次共读后，这里会展示<br>AI 每一轮实际看到的上下文</div>';
  openSheet({
    title: '本次共读上下文',
    html: `<div style="font-size:12px;color:var(--ink-3);margin-bottom:8px;">这是最近一次共读 AI 真正收到的内容。你可以据此调整「设置 → 共读设置」里的数量与开关。</div>
      <div class="ctx-card">${detail}</div>
      <div class="btn-row"><button class="btn-c" id="ctxClose">关闭</button></div>`,
    onOpen: (root) => {
      root.querySelector('#ctxClose').addEventListener('click', closeTopSheet);
    },
  });
}
async function openSessionList() {
  const rows = await listData('sessions');
  const mine = rows.filter(s => S.rBook && s.bookId === S.rBook.id).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  const firstMsg = (s) => {
    const m = (s.msgs || []).find(x => x.role === 'user');
    return m ? String(m.text).slice(0, 26) : '';
  };
  openSheet({
    title: '共读话题',
    html: mine.length ? mine.map(s => `
      <div class="sess-row" data-sid="${esc(s.id)}">
        <div class="sess-main" data-open="${esc(s.id)}">
          <div class="sess-t">${esc(s.topic)}</div>
          <div class="sess-prev">${firstMsg(s) ? '「' + esc(firstMsg(s)) + (String((s.msgs||[]).find(x=>x.role==='user')?.text||'').length > 26 ? '…' : '') + '」' : '<span style="color:var(--ink-3);">（空会话）</span>'}</div>
          ${s.summary ? `<div class="sess-sum">↳ ${esc(String(s.summary).slice(0, 56))}${String(s.summary).length > 56 ? '…' : ''}</div>` : ''}
          <div class="sess-meta">${s.msgs.length} 轮 · ${timeAgo(s.updatedAt)}</div>
        </div>
        <button class="sess-del" data-del="${esc(s.id)}" aria-label="删除话题">✕</button>
      </div>`).join('') : '<div class="empty">还没有共读记录</div>',
    onOpen: (root) => {
      root.querySelectorAll('.sess-main[data-open]').forEach(b => b.addEventListener('click', async () => {
        const all = await listData('sessions');
        const found = all.find(x => x.id === b.dataset.open);
        closeTopSheet();
        if (!found) return;
        S.coSession = found;
        $id('coDrawer').classList.add('open');
        renderCoHeader();
        renderCoMsgs();
        /* 打开历史会话时，若还没摘要就补一次（有对话才生成） */
        if (found.msgs && found.msgs.length >= 2 && !found.summary) generateSessionSummary(found);
      }));
      root.querySelectorAll('.sess-del[data-del]').forEach(b => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = b.dataset.del;
        const ok = await uiConfirm('删除话题', '删除后这次共读记录将不再保留。', '删除');
        if (!ok) return;
        await removeById('sessions', sid);
        /* 一并删除该会话在阅读器里的痕迹 */
        await removeTraceByRef('sessionId', sid);
        toast('话题已删除');
        closeTopSheet();
        if (S.coSession && S.coSession.id === sid) S.coSession = null;
        openSessionList();
      }));
    },
  });
}/* ───────── 思想空间（类型筛选 + 时间线 / 地图双视图） ───────── */
async function renderMind(filter) {
  S.tab = 'mind';
  S.mindFilter = filter || S.mindFilter || 'all';
  setTabActive('mind');
  $id('p-mind').classList.add('active');
  $id('p-desk').classList.remove('active');
  $id('p-lib').classList.remove('active');
  const pl = $id('p-life');
  if (pl) pl.classList.remove('active');
  await loadAll();

  /* 思想页只保留「我与书的互动」三类：理解 / 问题 / 共鸣；
     概念属于书本层（在书籍详情/章节精炼处看），实践与改变属于生活层（生活 tab）。 */
  const typeTabs = [['all', '全部'], ['我的理解', '理解'], ['问题', '问题'], ['共鸣', '共鸣']];
  let html = `<div class="h-row"><div><div class="h-page">思想</div>
    <div class="h-sub">我与书的互动 · 理解 / 问题 / 共鸣</div></div></div>
    <div class="mind-tabs">${typeTabs.map(t => `<button data-f="${t[0]}" class="${S.mindFilter === t[0] ? 'active' : ''}">${t[1]}</button>`).join('')}</div>
    <div class="view-switch">
      <button id="vw-timeline" class="${S.mindView === 'timeline' ? 'active' : ''}">时间线</button>
      <button id="vw-map" class="${S.mindView === 'map' ? 'active' : ''}">地图</button>
    </div>`;

  if (S.mindView === 'map') {
    html += renderMindMap();
  } else if (S.mindFilter === 'all') {
    /* 4.0 思想页信息优先级：悬而未决的问题（含正携带的）置顶——这是空间的主角；
       理解按生命线陈列（一条理解 + 它的再想/修正）；时间线降级为次级视图；共鸣单列。 */
    const roots = S.insights.filter(i => i.rootId == null && displayType(i.type) === '我的理解').sort((a, b) => b.growthAt - a.growthAt);
    const questions = S.questions.slice().sort((a, b) => b.createdAt - a.createdAt);
    const resonates = S.annotations.filter(a => a.type === 'resonate').sort((a, b) => b.createdAt - a.createdAt);
    const carrying = questions.filter(q => q.carrying);
    const open = questions.filter(q => !q.carrying);
    /* 主角：问题（携带的在前） */
    if (questions.length) {
      html += '<div class="section-label">悬 而 未 决 <span style="font-weight:400;color:var(--ink-3);">· 带着它们读，让书回答它们</span></div>';
      if (carrying.length) html += renderQuestionList(carrying);
      html += renderQuestionList(open.slice(0, 4));
      if (open.length > 4) html += `<button class="more-link" data-f="问题">看全部 ${questions.length} 条 →</button>`;
    }
    /* 次主角：理解（生命线） */
    if (roots.length) {
      html += '<div class="section-label">理 解 <span style="font-weight:400;color:var(--ink-3);">· 我的思想节点</span></div>';
      html += renderInsightList(roots.slice(0, 5));
      if (roots.length > 5) html += `<button class="more-link" data-f="我的理解">看全部 ${roots.length} 条 →</button>`;
    }
    /* 时间线降级为次级视图 */
    html += '<div class="section-label">最 近 足 迹 <span style="font-weight:400;color:var(--ink-3);">· 时间线</span></div>';
    html += renderTimelineList();
    /* 共鸣单列（安静的收藏夹） */
    if (resonates.length) {
      html += '<div class="section-label">共 鸣 <span style="font-weight:400;color:var(--ink-3);">· 被击中瞬间的收藏</span></div>';
      html += renderResonateList(resonates.slice(0, 3));
      if (resonates.length > 3) html += `<button class="more-link" data-f="共鸣">看全部 ${resonates.length} 条 →</button>`;
    }
    if (!questions.length && !roots.length && !resonates.length) html += '<div class="empty">读着读着，会有的</div>';
  } else if (S.mindFilter === '共鸣') {
    const resonates = S.annotations.filter(a => a.type === 'resonate').sort((a, b) => b.createdAt - a.createdAt);
    html += resonates.length ? renderResonateList(resonates) : '<div class="empty">读到时收藏的共鸣会在这里</div>';
  } else if (S.mindFilter === '问题') {
    html += S.questions.length ? renderQuestionList(S.questions) : '<div class="empty">还没有悬题</div>';
  } else {
    const roots = S.insights.filter(i => i.rootId == null).sort((a, b) => b.growthAt - a.growthAt);
    const filtered = roots.filter(i => displayType(i.type) === S.mindFilter);
    html += filtered.length ? renderInsightList(filtered) : `<div class="empty">还没有「${esc(S.mindFilter)}」类型的沉淀</div>`;
  }
  $id('mindBody').innerHTML = html;
  bindMindEvents();
}

/* ───────── 生活页（实践 + 改变，独立于思想） ─────────
   实践 = 信念 + 行动，完全由用户主动填写；
   改变 = 长期观察结果，由周期分析提出、用户确认后保存。
   两者不属于「思想」，AI 不替用户制定实践方案。 */
async function renderLife() {
  S.tab = 'life';
  setTabActive('life');
  const pl = $id('p-life');
  if (!pl) return;
  pl.classList.add('active');
  $id('p-desk').classList.remove('active');
  $id('p-lib').classList.remove('active');
  $id('p-mind').classList.remove('active');
  await loadAll();
  const practices = (S.practices || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  const changes = (S.changes || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  let html = `<div class="h-row"><div><div class="h-page">生活</div>
    <div class="h-sub">书进入生活 · 实践 / 长期改变</div></div>
    <button class="h-btn" id="lifeAddPractice">＋实践</button></div>`;

  html += '<div class="section-label">实 践 <span style="font-weight:400;">· 信念 + 行动（你自己来定）</span></div>';
  html += practices.length ? renderPracticeList(practices) : '<div class="empty">实践是你主动把阅读带进生活的记录<br>AI 不替你制定方案，从「＋实践」开始吧</div>';

  html += '<div class="section-label">改 变 <span style="font-weight:400;">· 长期观察结果（周期分析提出，你确认后保存）</span></div>';
  html += '<div style="margin:8px 0 6px;"><button class="change-btn" id="lifeRunChange">✧ 手动运行「改变」周期分析</button></div>';
  html += changes.length ? renderChangeList(changes) : '<div class="empty">长期积累后，由周期分析提出可能发生的改变</div>';

  pl.querySelector('#lifeBody').innerHTML = html;
  const ap = pl.querySelector('#lifeAddPractice');
  if (ap) ap.addEventListener('click', () => openPracticeSheet({ bookId: null }));
  const rc = pl.querySelector('#lifeRunChange');
  if (rc) rc.addEventListener('click', async () => { toast('开始分析…'); await runChangeAnalysis(true); toast('分析完成，如发现改变会出现在下方'); renderLife(); });
  /* 实践 / 改变详情与确认 */
  pl.querySelectorAll('.thought-item[data-pid]').forEach(el => el.addEventListener('click', () => openPracticeDetail(el.dataset.pid)));
  pl.querySelectorAll('.thought-item[data-cid2]').forEach(el => el.addEventListener('click', () => openChangeDetail(el.dataset.cid2)));
  pl.querySelectorAll('[data-confirm-c]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); confirmChange(b.dataset.confirmC); }));
}

/* 思想地图：主题标签作为索引的聚合视图 */
function renderMindMap() {
  const roots = S.insights.filter(i => i.rootId == null);
  /* 按主题收集 */
  const byTag = {};
  const addToTag = (tag, rec, kind) => {
    if (!tag) return;
    const key = tag;
    if (!byTag[key]) byTag[key] = { name: key, items: [] };
    byTag[key].items.push({ rec, kind });
  };
  for (const i of roots) {
    const disp = displayType(i.type);
    if (disp === '改变') continue;  // 改变单独列
    for (const t of (i.tags || [])) addToTag(t, i, disp);
  }
  for (const q of S.questions) {
    for (const t of (q.tags || [])) addToTag(t, q, '问题');
  }
  const tags = Object.values(byTag).sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, 'zh'));
  let html = `<div class="map-search"><input id="mapSearch" placeholder="搜索主题标签…" value="${esc(S.mindQuery || '')}"></div>`;
  if (!tags.length) {
    html += '<div class="empty">还没有主题标签。<br>沉淀记录时加上标签，它们会聚成地图。</div>';
  } else {
    html += `<div class="tag-cloud">`;
    for (const t of tags) {
      html += `<button class="tag-node" data-t="${esc(t.name)}" style="font-size:${12 + Math.min(6, t.items.length)}px;">${esc(t.name)}<span class="cnt">${t.items.length}</span></button>`;
    }
    html += `</div>`;
  }
  return html;
}

/* 弹窗：单个主题的聚合 */
function openTopicSheet(tagName) {
  const roots = S.insights.filter(i => i.rootId == null);
  const items = [];
  for (const i of roots) {
    if ((i.tags || []).includes(tagName)) items.push({ rec: i, kind: displayType(i.type) });
  }
  for (const q of S.questions) {
    if ((q.tags || []).includes(tagName)) items.push({ rec: q, kind: '问题' });
  }
  const byBook = {};
  items.forEach(({ rec, kind }) => {
    const book = S.books.find(b => b.id === rec.bookId);
    const key = book ? book.title : '无出处';
    if (!byBook[key]) byBook[key] = [];
    byBook[key].push({ rec, kind, book });
  });
  let html = `<div style="font-size:13px;color:var(--ink-2);line-height:1.6;margin-bottom:12px;">主题「${esc(tagName)}」共 ${items.length} 条记录，来自 ${Object.keys(byBook).length} 本书/出处</div>`;
  for (const [bookName, arr] of Object.entries(byBook)) {
    html += `<div class="section-label" style="margin:14px 0 6px;">${esc(bookName)}</div>`;
    html += arr.map(({ rec, kind, book }) => `
      <button class="row-btn" data-recid="${esc(rec.id)}" data-kind="${esc(kind)}">
        <span style="font-size:10.5px;color:var(--gold);">${esc(kind)}</span> ${esc(String(rec.text || rec.selectedText || '').slice(0, 50))}
        <div style="font-size:10.5px;color:var(--ink-3);">${book && rec.chapterId ? '→ 原文 · ' + escapedChapterTitle(S.books.find(b => b.id === book.id), rec.chapterId) : ''}</div>
      </button>`).join('');
  }
  openSheet({
    title: `主题 · ${tagName}`, html,
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-recid]').forEach(b => b.addEventListener('click', () => {
        closeTopSheet();
        const kind = b.dataset.kind;
        const id = b.dataset.recid;
        if (kind === '问题') openQuestionDetail(id);
        else openInsightDetail(id);
      }));
    },
  });
}
function escapedChapterTitle(book, chapterId) {
  if (!book || !book.chapterMeta) return '';
  const m = book.chapterMeta.find(c => c.cid === chapterId);
  return m ? m.title : '';
}

/* 概念（书内概念，书本层） */
function renderConceptList(list) {
  return list.map(c => {
    const book = S.books.find(b => b.id === c.bookId);
    return `<div class="thought-item card" data-cid="${esc(c.id)}">
      <div class="trow"><span class="tt">◇ 概念</span><span class="ts">${timeAgo(c.createdAt)}</span></div>
      <div class="bd"><b>${esc(c.term)}</b>${c.def ? ' — ' + esc(c.def) : ''}</div>
      <div class="origin">${book ? '📖 ' + esc(book.title) : ''}${c.chapterId ? ' · ' + esc(escapedChapterTitle(book, c.chapterId)) : ''}</div>
    </div>`;
  }).join('');
}
/* 实践（生活层：信念 + 行动） */
function renderPracticeList(list) {
  return list.map(p => {
    const book = S.books.find(b => b.id === p.bookId);
    return `<div class="thought-item card" data-pid="${esc(p.id)}">
      <div class="trow"><span class="tt">→ 实践 · ${esc(p.status || '进行中')}</span><span class="ts">${timeAgo(p.createdAt)}</span></div>
      ${p.belief ? `<div class="bd" style="font-size:13px;color:var(--ink-2);">信念：${esc(p.belief)}</div>` : ''}
      ${p.action ? `<div class="bd">行动：${esc(p.action)}</div>` : ''}
      <div class="origin">${book ? '📖 ' + esc(book.title) : ''}</div>
    </div>`;
  }).join('');
}
/* 改变（长期结果，需用户确认） */
function renderChangeList(list) {
  return list.map(c => {
    return `<div class="thought-item card" data-cid2="${esc(c.id)}">
      <div class="trow"><span class="tt">◆ 改变${c.confirmed ? '' : ' · 待确认'}</span><span class="ts">${timeAgo(c.createdAt)}</span></div>
      <div class="bd">${esc(c.text)}</div>
      <div class="origin">${esc(c.source || '')}${c.confirmed ? ' · 已确认' : ''}</div>
      ${!c.confirmed ? `<div class="btn-row" style="margin-top:8px;"><button class="btn-p" data-confirm-c="${esc(c.id)}">确认这条改变</button></div>` : ''}
    </div>`;
  }).join('');
}
function renderInsightList(list) {
  return list.map(i => {
    const book = S.books.find(b => b.id === i.bookId);
    const growth = S.insights.filter(g => g.rootId === i.id);
    const disp = displayType(i.type);
    const tagChips = (i.tags || []).slice(0, 5).map(t => `<span class="mini-tag" data-t="${esc(t)}">${esc(t)}</span>`).join('');
    return `<div class="thought-item card" data-iid="${esc(i.id)}">
      <div class="trow"><span class="tt">${typeEm(disp)} ${esc(disp)}${i.type === '实践' && i.practiceKind ? ' · ' + esc(i.practiceKind) : ''}</span><span class="ts">${timeAgo(i.createdAt)}</span></div>
      <div class="bd">${esc(i.text)}</div>
      ${growth.length ? '<div class="growth">' + growth.slice(-2).map(g => `<div class="g-row">· ${esc(String(g.text).slice(0, 50))}</div>`).join('') + `<div style="font-size:10.5px;color:var(--ink-3);margin-top:3px;">共 ${growth.length} 次再想</div></div>` : ''}
      ${tagChips ? `<div class="tag-row">${tagChips}</div>` : ''}
      <div class="origin">${book ? '📖 ' + esc(book.title) : ''}${i.quote ? ' · 「' + esc(i.quote.slice(0, 14)) + '…」' : ''}</div>
    </div>`;
  }).join('');
}
function renderQuestionList(list) {
  return list.map(q => {
    const book = S.books.find(b => b.id === q.bookId);
    const tagChips = (q.tags || []).slice(0, 5).map(t => `<span class="mini-tag" data-t="${esc(t)}">${esc(t)}</span>`).join('');
    const answers = Array.isArray(q.answers) && q.answers.length ? q.answers : (q.answerText ? [{ text: q.answerText, at: q.answeredAt || q.createdAt }] : []);
    return `<div class="q-item card${q.carrying ? ' carrying' : ''}" data-qid="${esc(q.id)}">
      <div class="bd">${esc(q.text)}</div>
      ${q.carrying ? '<div class="carry-tag">✈ 带着它读</div>' : ''}
      ${tagChips ? `<div class="tag-row">${tagChips}</div>` : ''}
      ${answers.length ? `<div class="ans">已回应 ${answers.length} 次 · ${esc(String(answers[answers.length - 1].text).slice(0, 60))}</div>` : '<div class="mt" style="margin-top:7px;">还悬着</div>'}
      <div class="mt">${book ? esc(book.title) : '无出处'} · ${timeAgo(q.createdAt)}</div>
    </div>`;
  }).join('');
}
function renderResonateList(list) {
  return list.map(a => {
    const book = S.books.find(b => b.id === a.bookId);
    return `<div class="resonate-item card" data-annid="${esc(a.id)}">
      <div class="trow"><span class="tt">♥ 共鸣</span><span class="ts">${timeAgo(a.createdAt)}</span></div>
      <div class="bd">「${esc(String(a.selectedText || '').slice(0, 90))}${String(a.selectedText || '').length > 90 ? '…' : ''}」</div>
      <div class="origin">${book ? '📖 ' + esc(book.title) : ''}</div>
    </div>`;
  }).join('');
}
function renderTimelineList() {
  const grouped = {};
  S.timeline.slice().sort((a, b) => b.ts - a.ts).forEach(t => {
    const day = new Date(t.ts).toDateString();
    (grouped[day] = grouped[day] || []).push(t);
  });
  let html = '<div class="section-label">时 间 线</div>';
  for (const day of Object.keys(grouped)) {
    const date = new Date(day);
    html += `<div class="tl-day">${date.getMonth() + 1}月${date.getDate()}日</div>`;
    for (const t of grouped[day]) {
      const book = S.books.find(b => b.id === t.bookId);
      html += `<div class="tl-item card"><div class="t">${esc(t.kind)} · ${esc(String(t.text || '').slice(0, 60))}</div><div class="src">${book ? esc(book.title) : ''}</div></div>`;
    }
  }
  return html || '<div class="empty">阅读轨迹会随时间线慢慢变长</div>';
}
function bindMindEvents() {
  $qa('#mindBody .mind-tabs button').forEach(b => b.addEventListener('click', () => renderMind(b.dataset.f)));
  const vT = $id('vw-timeline'), vM = $id('vw-map');
  if (vT) vT.addEventListener('click', () => { S.mindView = 'timeline'; renderMind(); });
  if (vM) vM.addEventListener('click', () => { S.mindView = 'map'; renderMind(); });
  $qa('#mindBody .thought-item').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.mini-tag')) return;
    openInsightDetail(el.dataset.iid);
  }));
  $qa('#mindBody .q-item').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.mini-tag')) return;
    openQuestionDetail(el.dataset.qid);
  }));
  $qa('#mindBody .resonate-item').forEach(el => el.addEventListener('click', () => openResonateDetail(el.dataset.annid)));
  /* 概念 / 实践 / 改变 */
  $qa('#mindBody .thought-item[data-cid]').forEach(el => el.addEventListener('click', () => openConceptDetail(el.dataset.cid)));
  $qa('#mindBody .thought-item[data-pid]').forEach(el => el.addEventListener('click', () => openPracticeDetail(el.dataset.pid)));
  $qa('#mindBody .thought-item[data-cid2]').forEach(el => el.addEventListener('click', () => openChangeDetail(el.dataset.cid2)));
  $qa('#mindBody [data-confirm-c]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); confirmChange(b.dataset.confirmC); }));
  $qa('#mindBody .mini-tag').forEach(t => t.addEventListener('click', (e) => {
    e.stopPropagation();
    openTopicSheet(t.dataset.t);
  }));
  $qa('#mindBody .more-link').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    S.mindFilter = b.dataset.f;
    renderMind();
  }));
  /* 时间线视图点击标签跳地图主题 */
  $qa('#mindBody .tl-item').forEach(el => { el.style.cursor = 'default'; });
  $qa('#mindBody .tag-node').forEach(b => b.addEventListener('click', () => openTopicSheet(b.dataset.t)));
  const ms = $id('mapSearch');
  if (ms) ms.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      S.mindQuery = ms.value.trim();
      renderMind();
    }
  });
}
async function openInsightDetail(id) {
  const root = S.insights.find(i => i.id === id);
  if (!root) return;
  const growth = S.insights.filter(g => g.rootId === id).sort((a, b) => a.createdAt - a.createdAt);
  const book = S.books.find(b => b.id === root.bookId);
  const chTitle = book && book.chapterMeta ? ((book.chapterMeta.find(c => c.cid === root.chapterId) || {}).title || '') : '';
  const disp = displayType(root.type);
  const tagChips = (root.tags || []).map(t => `<span class="mini-tag" data-t="${esc(t)}">${esc(t)}</span>`).join(' ');
  openSheet({
    title: disp + (root.type === '实践' && root.practiceKind ? ' · ' + root.practiceKind : ''),
    html: `
      <div style="font-size:14px;line-height:1.8;margin-bottom:10px;">${esc(root.text)}</div>
      ${tagChips ? `<div class="tag-row" style="margin-bottom:10px;">${tagChips}</div>` : ''}
      ${growth.length ? '<div class="section-label">这段思想如何长</div>' + growth.map(g => `
        <div style="padding:9px 0;border-top:1px dashed var(--line);">
          <div style="font-size:13px;line-height:1.7;">${esc(g.text)}</div>
          <div style="font-size:10.5px;color:var(--ink-3);margin-top:3px;">${timeAgo(g.createdAt)}${g.bookId !== root.bookId ? ' · 另一次阅读' : ''}</div>
        </div>`).join('') : ''}
      <div class="section-label">来自</div>
      <div style="font-size:13px;color:var(--ink-2);line-height:1.7;">${book ? '📖 ' + esc(book.title) + (chTitle ? ' · ' + esc(chTitle) : '') : '（无出处）'}
      ${root.quote ? '<br>「' + esc(String(root.quote).slice(0, 80)) + '…」' : ''}</div>
      ${book && root.chapterId ? `<div class="btn-row"><button class="btn-p" id="jumpOrigin">回到那里继续读</button></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="practiceI">由此记录实践</button></div>
      <div class="btn-row"><button class="btn-c" id="delInsight" style="color:var(--danger);">删除</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#jumpOrigin')?.addEventListener('click', () => {
        closeTopSheet();
        openReader(book.id, root.chapterId, Math.max(0, root.paraNum || 0));
      });
      rootEl.querySelector('#practiceI')?.addEventListener('click', () => {
        closeTopSheet();
        openPracticeSheet({ bookId: root.bookId, linkType: 'insight', linkId: root.id, quote: root.quote });
      });
      rootEl.querySelector('#delInsight')?.addEventListener('click', async () => {
        const ok = await uiConfirm('删除理解', '删除后这条理解及其在书中的阅读痕迹、时间线记录将一并移除。', '删除');
        if (!ok) return;
        closeTopSheet();
        for (const g of growth) { await removeById('insights', g.id); await removeTraceByRef('insightId', g.id); }
        await removeById('insights', id);
        await removeTraceByRef('insightId', id);
        await removeTimelineByText(root.text, root.bookId ? { bookId: root.bookId } : null);
        S.insights = await listData('insights');
        toast('已删除');
        renderMind();
      });
      rootEl.querySelectorAll('.mini-tag').forEach(t => t.addEventListener('click', () => { closeTopSheet(); openTopicSheet(t.dataset.t); }));
    },
  });
}
async function openQuestionDetail(id) {
  const q = S.questions.find(x => x.id === id);
  if (!q) return;
  const book = S.books.find(b => b.id === q.bookId);
  const chTitle = book && book.chapterMeta ? ((book.chapterMeta.find(c => c.cid === q.chapterId) || {}).title || '') : '';
  const tagChips = (q.tags || []).map(t => `<span class="mini-tag" data-t="${esc(t)}">${esc(t)}</span>`).join(' ');
  const answers = Array.isArray(q.answers) && q.answers.length ? q.answers : (q.answerText ? [{ text: q.answerText, at: q.answeredAt || q.createdAt }] : []);
  const carryBtn = q.carrying
    ? `<button class="row-btn" id="uncarryQ">✈ 不再带着它读</button>`
    : `<button class="row-btn" id="carryQ">✈ 带着它继续读</button>`;
  openSheet({
    title: '问题',
    html: `
      <div style="font-size:14.5px;line-height:1.8;margin-bottom:10px;">${esc(q.text)}</div>
      ${tagChips ? `<div class="tag-row" style="margin-bottom:10px;">${tagChips}</div>` : ''}
      ${q.carrying ? '<div class="carry-tag" style="margin-bottom:10px;">✈ 正带着它读</div>' : ''}
      <div class="section-label">这条问题的回应（${answers.length}）</div>
      ${answers.length ? answers.slice().reverse().map(a => `
        <div style="padding:10px 0;border-bottom:1px dashed var(--line);">
          <div style="font-size:13.5px;line-height:1.7;">${esc(a.text)}</div>
          <div style="font-size:10.5px;color:var(--ink-3);margin-top:4px;">${a.at ? timeAgo(a.at) : ''} 的回应</div>
        </div>`).join('') : '<div class="empty" style="padding:14px;">还没有回应，悬着</div>'}
      <div class="section-label">来自</div>
      <div style="font-size:13px;color:var(--ink-2);line-height:1.7;margin-bottom:8px;">${book ? '📖 ' + esc(book.title) + (chTitle ? ' · ' + esc(chTitle) : '') : '（无出处）'}
      ${q.quote ? '<br>「' + esc(String(q.quote).slice(0, 80)) + '…」' : ''}</div>
      ${book && q.chapterId ? `<div class="btn-row"><button class="btn-c" id="jumpOrigin">回到那里再读</button></div>` : ''}
      <div class="btn-row"><button class="btn-p" id="answerQ">留下新回应</button></div>
      <div class="btn-row">${carryBtn}</div>
      <div class="btn-row"><button class="btn-c" id="practiceQ">由此记录实践</button></div>
      <div class="btn-row"><button class="btn-c" id="delQ" style="color:var(--danger);">删除</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#jumpOrigin')?.addEventListener('click', () => {
        closeTopSheet();
        openReader(book.id, q.chapterId, Math.max(0, q.paraNum || 0));
      });
      rootEl.querySelector('#answerQ')?.addEventListener('click', () => { closeTopSheet(); openAnswerSheet(q); });
      rootEl.querySelector('#carryQ')?.addEventListener('click', async () => {
        await toggleCarryQuestion(id, true); closeTopSheet(); renderMind();
      });
      rootEl.querySelector('#uncarryQ')?.addEventListener('click', async () => {
        await toggleCarryQuestion(id, false); closeTopSheet(); renderMind();
      });
      rootEl.querySelector('#practiceQ')?.addEventListener('click', () => {
        closeTopSheet();
        openPracticeSheet({ bookId: q.bookId, linkType: 'question', linkId: q.id, quote: q.quote });
      });
      rootEl.querySelector('#delQ')?.addEventListener('click', async () => {
        const ok = await uiConfirm('删除问题', '删除后这个问题及其在书中的阅读痕迹、时间线记录将一并移除。', '删除');
        if (!ok) return;
        closeTopSheet();
        await removeById('questions', id);
        await removeTraceByRef('questionId', id);
        await removeTimelineByText(q.text, q.bookId ? { bookId: q.bookId } : null);
        S.questions = await listData('questions');
        toast('已删除');
        renderMind();
      });
      rootEl.querySelectorAll('.mini-tag').forEach(t => t.addEventListener('click', () => { closeTopSheet(); openTopicSheet(t.dataset.t); }));
    },
  });
}
async function openResonateDetail(id) {
  const a = (await listData('annotations')).find(x => x.id === id);
  if (!a) return;
  const book = S.books.find(b => b.id === a.bookId);
  const chTitle = book && book.chapterMeta ? ((book.chapterMeta.find(c => c.cid === a.chapterId) || {}).title || '') : '';
  openSheet({
    title: '共鸣',
    html: `
      <div style="font-size:15px;font-family:var(--font-serif);line-height:2;margin-bottom:12px;">「${esc(a.selectedText)}」</div>
      <div class="section-label">来自</div>
      <div style="font-size:13px;color:var(--ink-2);line-height:1.7;">${book ? '📖 ' + esc(book.title) + (chTitle ? ' · ' + esc(chTitle) : '') : ''}</div>
      ${book && a.chapterId ? `<div class="btn-row"><button class="btn-p" id="jumpOrigin">回到原文</button></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="delAnn" style="color:var(--danger);">取消收藏</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#jumpOrigin')?.addEventListener('click', () => {
        closeTopSheet();
        openReader(book.id, a.chapterId, Math.max(0, a.paraNum || 0));
      });
      rootEl.querySelector('#delAnn')?.addEventListener('click', async () => {
        const ok = await uiConfirm('取消共鸣收藏', '取消后这条共鸣及其在书中的阅读痕迹将一并移除。', '取消收藏');
        if (!ok) return;
        closeTopSheet();
        await removeById('annotations', id);
        await removeTraceByRef('annotationId', id);
        toast('已取消收藏');
        renderMind();
      });
    },
  });
}

/* 概念详情：可查看、修改定义、删除（概念以本书定义为核心，用户可编辑） */
async function openConceptDetail(id) {
  const c = S.concepts.find(x => x.id === id);
  if (!c) return;
  const book = S.books.find(b => b.id === c.bookId);
  openSheet({
    title: '概念',
    html: `
      <div style="font-size:15px;line-height:1.7;margin-bottom:8px;"><b>${esc(c.term)}</b></div>
      <div style="font-size:14px;color:var(--ink-2);line-height:1.7;">${esc(c.def)}</div>
      <div class="section-label">来自</div>
      <div style="font-size:13px;color:var(--ink-2);line-height:1.7;">${book ? '📖 ' + esc(book.title) : ''}${c.chapterId ? ' · ' + esc(escapedChapterTitle(book, c.chapterId)) : ''}</div>
      <div class="btn-row"><button class="btn-p" id="editConcept">修改</button></div>
      <div class="btn-row"><button class="btn-c" id="delConcept" style="color:var(--danger);">删除</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#editConcept').addEventListener('click', () => { closeTopSheet(); openConceptEditSheet(c); });
      rootEl.querySelector('#delConcept').addEventListener('click', async () => {
        const ok = await uiConfirm('删除概念', '删除后这个概念将从这本书中移除。', '删除');
        if (!ok) return;
        closeTopSheet();
        await removeById('concepts', id);
        S.concepts = await listData('concepts');
        toast('概念已删除');
        renderMind();
      });
    },
  });
}
function openConceptEditSheet(c) {
  openSheet({
    title: '修改概念',
    html: `
      <div class="field"><label>术语</label><input type="text" id="cTerm" value="${esc(c.term)}"></div>
      <div class="field"><label>定义（本书中的定义）</label><textarea id="cDef">${esc(c.def || '')}</textarea></div>
      <div class="btn-row"><button class="btn-c" id="cCancel">取消</button><button class="btn-p" id="cSave">保存</button></div>`,
    onOpen: (root) => {
      root.querySelector('#cCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#cSave').addEventListener('click', async () => {
        const term = root.querySelector('#cTerm').value.trim();
        const def = root.querySelector('#cDef').value.trim();
        if (!term) { toast('术语不能为空'); return; }
        closeTopSheet();
        const rows = await listCol('concepts');
        const found = rows.find(r => r.data && r.data.id === c.id);
        if (found) await A.db.update('concepts', found.id, { ...c, term, def });
        S.concepts = await listData('concepts');
        toast('概念已更新');
        renderMind();
      });
    },
  });
}
/* 实践详情：查看/编辑/更新状态，可绑定理解或问题 */
async function openPracticeDetail(id) {
  const p = S.practices.find(x => x.id === id);
  if (!p) return;
  const book = S.books.find(b => b.id === p.bookId);
  openSheet({
    title: '实践',
    html: `
      ${p.belief ? `<div style="font-size:13px;color:var(--ink-2);margin-bottom:4px;">信念</div><div style="font-size:14px;line-height:1.7;margin-bottom:10px;">${esc(p.belief)}</div>` : ''}
      ${p.action ? `<div style="font-size:13px;color:var(--ink-2);margin-bottom:4px;">行动</div><div style="font-size:14px;line-height:1.7;margin-bottom:10px;">${esc(p.action)}</div>` : ''}
      <div class="section-label">状态</div>
      <div style="font-size:13px;color:var(--ink-2);margin-bottom:8px;">${esc(p.status || '进行中')}</div>
      ${book ? `<div class="section-label">来自</div><div style="font-size:13px;color:var(--ink-2);line-height:1.7;">📖 ${esc(book.title)}</div>` : ''}
      <div class="btn-row"><button class="btn-p" id="editP">更新</button></div>
      <div class="btn-row"><button class="btn-c" id="delP" style="color:var(--danger);">删除</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#editP').addEventListener('click', () => { closeTopSheet(); openPracticeSheet({ ...p, id: p.id, bookId: p.bookId }); });
      rootEl.querySelector('#delP').addEventListener('click', async () => {
        const ok = await uiConfirm('删除实践', '删除后这条实践及其时间线记录将一并移除。', '删除');
        if (!ok) return;
        closeTopSheet();
        await removeById('practices', id);
        await removeTimelineByText(p.belief + (p.action ? ' → ' + p.action : ''), p.bookId ? { bookId: p.bookId } : null);
        S.practices = await listData('practices');
        toast('实践已删除');
        renderMind();
      });
    },
  });
}
/* 改变详情：AI 提出→用户确认 / 用户主动记录 */
async function openChangeDetail(id) {
  const c = S.changes.find(x => x.id === id);
  if (!c) return;
  openSheet({
    title: '改变',
    html: `
      <div style="font-size:14.5px;line-height:1.8;margin-bottom:10px;">${esc(c.text)}</div>
      <div class="section-label">来源</div>
      <div style="font-size:13px;color:var(--ink-2);margin-bottom:8px;">${esc(c.source || '')} · ${c.confirmed ? '已确认' : '待确认'}</div>
      ${c.evidence && c.evidence.length ? `
        <div class="section-label">证据链（凭什么说变了）</div>
        ${c.evidence.map((ev, i) => `
          <div class="mini-line" data-ev="${i}" style="display:block;"><span style="color:var(--gold);font-size:10px;">${esc(ev.kind)}</span> ${esc(String(ev.text).slice(0, 46))}</div>
        `).join('')}` : ''}
      ${!c.confirmed ? `<div class="btn-row"><button class="btn-p" id="cfmC">确认这条改变</button></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="delC" style="color:var(--danger);">删除</button></div>`,
    onOpen: (rootEl) => {
      const cfm = rootEl.querySelector('#cfmC');
      if (cfm) cfm.addEventListener('click', async () => { closeTopSheet(); await confirmChange(id); });
      rootEl.querySelectorAll('.mini-line[data-ev]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const ev = (c.evidence || [])[parseInt(el.dataset.ev)];
        if (!ev) return;
        closeTopSheet();
        if (ev.kind === '理解') openInsightDetail(ev.id);
        else if (ev.kind === '问题回应') openQuestionDetail(ev.id);
        else openPracticeDetail(ev.id);
      }));
      rootEl.querySelector('#delC').addEventListener('click', async () => {
        const ok = await uiConfirm('删除改变', '删除后这条改变记录将不再保留。', '删除');
        if (!ok) return;
        closeTopSheet();
        await removeById('changes', id);
        S.changes = await listData('changes');
        toast('改变记录已删除');
        renderMind();
      });
    },
  });
    onOpen: (rootEl) => {
      const cfm = rootEl.querySelector('#cfmC');
      if (cfm) cfm.addEventListener('click', async () => { closeTopSheet(); await confirmChange(id); });
      rootEl.querySelector('#delC').addEventListener('click', async () => {
        const ok = await uiConfirm('删除改变', '删除后这条改变记录将不再保留。', '删除');
        if (!ok) return;
        closeTopSheet();
        await removeById('changes', id);
        S.changes = await listData('changes');
        toast('改变记录已删除');
        renderMind();
      });
    },
  });
}

/* 阅读中思想抽屉（不离开阅读页）——只显示「理解」，问题/共鸣引导到思想页 */
async function openMindDrawer() {
  await loadAll();
  const roots = S.insights.filter(i => i.rootId == null && displayType(i.type) === '我的理解').sort((a, b) => b.growthAt - a.growthAt).slice(0, 12);
  const bookRelevant = roots.filter(i => i.bookId === S.rBook.id);
  const list = bookRelevant.length ? bookRelevant : roots;
  openSheet({
    title: '这本书里我想到的',
    html: list.length ? list.map(i => `
      <button class="row-btn" data-iid="${esc(i.id)}">
        <span style="font-size:10.5px;color:var(--gold);">· 理解</span> ${esc(String(i.text).slice(0, 44))}
      </button>`).join('') + `<div class="btn-row"><button class="btn-c" id="vmGoMind">去思想空间看理解 / 问题 / 共鸣</button></div>`
      : '<div class="empty">这一本还没有留下什么<br>读到想明白的，划一段「理解」吧</div>',
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-iid]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.iid;
        closeTopSheet();
        openInsightDetail(id);
      }));
      const go = root.querySelector('#vmGoMind');
      if (go) go.addEventListener('click', () => { closeTopSheet(); switchTab('mind'); });
    },
  });
}/* ───────── 书籍详情：从这本书长出来的东西 ───────── */
async function openBookDetail(bookId) {
  const book = S.books.find(b => b.id === bookId);
  if (!book) return;
  await loadAll();
  const roots = S.insights.filter(i => i.rootId == null);
  const concepts = S.concepts.filter(c => c.bookId === bookId);
  const understandings = roots.filter(i => i.bookId === bookId && displayType(i.type) === '我的理解');
  const practices = S.practices.filter(p => p.bookId === bookId);
  const changes = S.changes.filter(c => c.bookId === bookId);
  const questions = S.questions.filter(q => q.bookId === bookId);
  const resonates = S.annotations.filter(a => a.bookId === bookId && a.type === 'resonate');
  const coCount = S.sessions.filter(s => s.bookId === bookId).length;
  const pct = totalParas(book) ? Math.round((book.currentParaNum / totalParas(book)) * 100) : 0;
  const chTitle = bookCurrentChapterTitle(book);

  const grown = [['概念', concepts], ['理解', understandings], ['问题', questions], ['共鸣', resonates], ['实践', practices], ['改变', changes]];
  openSheet({
    title: book.title,
    html: `
      <div style="text-align:center;font-size:12.5px;color:var(--ink-3);margin-bottom:10px;">${esc(chTitle || '未开始')} · 上次阅读 ${book.lastReadAt ? timeAgo(book.lastReadAt) : '—'}</div>
      <div class="stat-grid">
        <div class="st"><b>${pct}%</b><span>已读</span></div>
        <div class="st"><b>${coCount}</b><span>共读</span></div>
        <div class="st"><b>${concepts.length + understandings.length}</b><span>思想</span></div>
        <div class="st"><b>${questions.length}</b><span>问题</span></div>
      </div>
      <div class="btn-row"><button class="btn-p" id="bdContinue">继续阅读</button></div>
      <div class="section-label" style="margin-top:20px;">从这本书长出来的</div>
      <div class="grown-grid">
        ${grown.map(([label, list]) => `<button class="grown-cell" data-type="${label}"><b>${list.length}</b><span>${esc(label)}</span></button>`).join('')}
      </div>
      ${concepts.length ? '<div class="section-label" style="margin-top:14px;">最近的概念</div>' + concepts.slice(0, 3).map(i => `<div class="mini-line" data-ciid="${esc(i.id)}"><span style="color:var(--gold);font-size:10px;">◇</span>${esc(i.term + (i.def ? '：' + i.def.slice(0, 30) : ''))}</div>`).join('') : ''}
      ${understandings.length ? '<div class="section-label">最近的理解</div>' + understandings.slice(0, 3).map(i => `<div class="mini-line" data-iid="${esc(i.id)}"><span style="color:var(--gold);font-size:10px;">·</span>${esc(String(i.text).slice(0, 42))}</div>`).join('') : ''}
      ${questions.length ? '<div class="section-label">悬着的问题</div>' + questions.slice(0, 3).map(q => `<div class="mini-line" data-qid="${esc(q.id)}"><span style="color:var(--gold);font-size:10px;">？</span>${esc(String(q.text).slice(0, 42))}</div>`).join('') : ''}
      <div class="btn-row"><button class="btn-c" id="bdClose">关闭</button></div>`,
    onOpen: (root) => {
      root.querySelector('#bdContinue').addEventListener('click', () => { closeTopSheet(); openReader(bookId); });
      root.querySelector('#bdClose').addEventListener('click', closeTopSheet);
      root.querySelectorAll('.grown-cell').forEach(c => c.addEventListener('click', () => {
        const t = c.dataset.type;
        closeTopSheet();
        if (t === '实践' || t === '改变') {
          switchTab('life');
        } else {
          switchTab('mind');
          renderMind(t);
        }
      }));
      root.querySelectorAll('.mini-line[data-iid]').forEach(el => el.addEventListener('click', () => { closeTopSheet(); openInsightDetail(el.dataset.iid); }));
      root.querySelectorAll('.mini-line[data-ciid]').forEach(el => el.addEventListener('click', () => { closeTopSheet(); openConceptDetail(el.dataset.ciid); }));
      root.querySelectorAll('.mini-line[data-qid]').forEach(el => el.addEventListener('click', () => { closeTopSheet(); openQuestionDetail(el.dataset.qid); }));
    },
  });
}

/* ───────── 书架操作菜单 ───────── */
function openBookMenu(bookId) {
  const b = S.books.find(x => x.id === bookId);
  if (!b) return;
  openSheet({
    title: b.title,
    html: `<button class="row-btn" id="bmRead">继续阅读</button>
      <button class="row-btn" id="bmDetail">书籍详情</button>
      <button class="row-btn" id="bmAddGroup">加入书单</button>
      <button class="row-btn danger" id="bmDelete">删除这本书</button>`,
    onOpen: (root) => {
      root.querySelector('#bmRead').addEventListener('click', () => { closeTopSheet(); openReader(bookId); });
      root.querySelector('#bmDetail').addEventListener('click', () => { closeTopSheet(); openBookDetail(bookId); });
      root.querySelector('#bmAddGroup').addEventListener('click', () => { closeTopSheet(); openAddToGroup(bookId); });
      root.querySelector('#bmDelete').addEventListener('click', async () => {
        closeTopSheet();
        const ok = await uiConfirm('删除这本书', '删除后，这本书的原文、章节、概念会从书库移除，只删「书的世界」。你在这本书里留下的理解、问题、共鸣、实践、改变都会保留，只是失去出处。确定删除吗？', '删除');
        if (!ok) return;
        await deleteBook(bookId);
        S.books = S.books.filter(x => x.id !== bookId);
        toast('已删除');
        renderLib();
      });
    },
  });
}
async function deleteBook(bookId) {
  await removeById('books', bookId);
  const chaps = await listCol('chapters', true);
  for (const c of chaps) { if (c.data && c.data.bookId === bookId) await A.db.delete('chapters', c.id); }
  /* 4.0 两个世界：删除书，只删「书的世界」——原文/章节/概念/书上痕迹。
     用户的世界——理解/问题/共鸣/实践/改变/共读对话——全部保留，仅失去出处。 */
  for (const col of ['traces', 'concepts']) {
    for (const r of await listCol(col, true)) { if (r.data && r.data.bookId === bookId) await A.db.delete(col, r.id); }
  }
  /* 从所有书单中移除这本书 */
  for (const g of S.groups) {
    if ((g.bookIds || []).includes(bookId)) {
      g.bookIds = g.bookIds.filter(x => x !== bookId);
      await upsert('groups', g);
    }
  }
  S.books = S.books.filter(x => x.id !== bookId);
  /* 若正在读这本书，关闭阅读器 */
  if (S.rBook && S.rBook.id === bookId) {
    $id('reader').classList.remove('open');
    $id('coDrawer').classList.remove('open');
    document.body.style.overflow = '';
    S.rBook = null; S.rChapter = null; S.coSession = null;
  }
}
function openAddToGroup(bookId) {
  openSheet({
    title: '加入书单',
    html: S.groups.length ? S.groups.map(g => `<button class="row-btn" data-gid="${esc(g.id)}">${esc(g.name)} ${(g.bookIds || []).includes(bookId) ? '· 已在内' : ''}</button>`).join('') : '<div class="empty">还没有书单，去书库顶部「＋书单」建一个</div>',
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-gid]').forEach(btn => btn.addEventListener('click', async () => {
        const g = S.groups.find(x => x.id === btn.dataset.gid);
        if (!g) return;
        if (!g.bookIds) g.bookIds = [];
        if (!g.bookIds.includes(bookId)) { g.bookIds.push(bookId); await upsert('groups', g); }
        closeTopSheet(); toast('已加入「' + g.name + '」');
      }));
    },
  });
}
function openGroupEditor() {
  openSheet({
    title: '书单管理',
    html: S.groups.length ? S.groups.map(g => `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line-soft);">
        <span style="flex:1;font-size:14px;">${esc(g.name)}（${(g.bookIds || []).length} 本）</span>
        <button class="btn-c" data-editg="${esc(g.id)}" style="padding:6px 12px;border:none;border-radius:9px;font-size:12px;">管理</button>
      </div>`).join('') : '<div class="empty">还没有书单</div>' + `
      <div style="display:flex;gap:8px;margin-top:12px;"><input id="newGName" placeholder="新书单名称" style="flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#f9f6f1;font-size:14px;outline:none;"><button class="btn-p" id="addG" style="border:none;border-radius:10px;padding:0 16px;">添加</button></div>`,
    onOpen: (root) => {
      root.querySelectorAll('[data-editg]').forEach(b => b.addEventListener('click', async () => { closeTopSheet(); openGroupDetail(b.dataset.editg); }));
      root.querySelector('#addG').addEventListener('click', async () => {
        const name = root.querySelector('#newGName').value.trim();
        if (!name) return;
        await upsert('groups', { id: 'g_' + uid(), name, bookIds: [] });
        S.groups = await listData('groups'); closeTopSheet(); renderLib();
      });
    },
  });
}
/* 单个书单详情：重命名 / 移除书 / 删除书单 */
function openGroupDetail(groupId) {
  const g = S.groups.find(x => x.id === groupId);
  if (!g) return;
  const books = S.books.filter(b => (g.bookIds || []).includes(b.id));
  openSheet({
    title: `书单 · ${g.name}`,
    html: `
      <div class="field"><label>重命名书单</label>
        <div style="display:flex;gap:8px;"><input id="gName" value="${esc(g.name)}" style="flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#f9f6f1;font-size:14px;outline:none;"><button class="btn-p" id="gRename" style="border:none;border-radius:10px;padding:0 16px;flex-shrink:0;">重命名</button></div></div>
      <div class="section-label">书单里的书（${books.length}）</div>
      ${books.length ? books.map(b => `
        <div style="display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid var(--line-soft);">
          <span style="flex:1;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(b.title)}</span>
          <button class="btn-c" data-rmg="${esc(b.id)}" style="padding:5px 11px;border:none;border-radius:8px;font-size:11.5px;">移出</button>
        </div>`).join('') : '<div class="empty">这个书单还没有书</div>'}
      <div class="btn-row"><button class="btn-c" id="gDel" style="color:var(--danger);">删除书单</button></div>
      <div class="btn-row"><button class="btn-c" id="gClose">关闭</button></div>`,
    onOpen: (root) => {
      root.querySelector('#gRename').addEventListener('click', async () => {
        const name = root.querySelector('#gName').value.trim();
        if (!name) { toast('名称不能为空'); return; }
        g.name = name;
        await upsert('groups', g);
        S.groups = await listData('groups');
        toast('已重命名');
        closeTopSheet();
        renderLib();
      });
      root.querySelectorAll('[data-rmg]').forEach(b => b.addEventListener('click', async () => {
        const bid = b.dataset.rmg;
        g.bookIds = (g.bookIds || []).filter(x => x !== bid);
        await upsert('groups', g);
        S.groups = await listData('groups');
        const book = S.books.find(x => x.id === bid);
        toast(book ? '已从书单移除「' + book.title + '」' : '已移除');
        closeTopSheet();
        renderLib();
        openGroupDetail(groupId);
      }));
      root.querySelector('#gDel').addEventListener('click', async () => {
        const ok = await uiConfirm('删除书单', '删除后这本书单将从书库移除（书本身不会被删除）。', '删除');
        if (!ok) return;
        await removeById('groups', groupId);
        S.groups = await listData('groups');
        if (S.currentGroup === groupId) S.currentGroup = 'all';
        closeTopSheet();
        toast('书单已删除');
        renderLib();
      });
      root.querySelector('#gClose').addEventListener('click', closeTopSheet);
    },
  });
}

/* ───────── 导入 ───────── */
function openImportSheet() {
  openSheet({
    title: '导入一本书',
    html: `<div class="field"><label>导入状态</label><div class="import-status" id="impStatus"><span class="spin" style="display:none;"></span><span>选择 TXT / MD / EPUB 文件，或粘贴文本</span></div></div>
      <div class="field"><label>选择文件</label><input type="file" id="impFile" accept=".txt,.md,.markdown,.epub"></div>
      <div class="field"><label>或粘贴文本</label><textarea id="impPaste" placeholder="把文字粘贴到这里…"></textarea></div>
      <div class="field"><label>书名（可选）</label><input type="text" id="impTitle" placeholder="留空自动识别"></div>
      <div class="field"><label>作者（可选）</label><input type="text" id="impAuthor" placeholder="作者名"></div>
      <div class="btn-row"><button class="btn-c" id="impCancel">取消</button><button class="btn-p" id="impGo">导入</button></div>`,
    onOpen: (root) => {
      root.querySelector('#impCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#impGo').addEventListener('click', () => doImport(root));
    },
  });
}
async function doImport(root) {
  const status = root.querySelector('#impStatus');
  const setStatus = (msg, working) => { status.innerHTML = `<span class="spin" style="${working ? '' : 'display:none;'}"></span><span>${esc(msg)}</span>`; };
  const title = root.querySelector('#impTitle').value.trim();
  const author = root.querySelector('#impAuthor').value.trim();
  const file = root.querySelector('#impFile').files[0];
  const paste = root.querySelector('#impPaste').value.trim();
  if (!file && !paste) { toast('请选择文件或粘贴文本'); return; }
  try {
    let format = 'txt', content = '';
    if (file) {
      const name = file.name.toLowerCase();
      if (name.endsWith('.epub')) {
        setStatus('正在解析 EPUB…', true);
        const parsed = await EpubParser.parse(file);
        setStatus(`解析成功：${parsed.chapters.length} 章`, false);
        await importBook(title || parsed.title || file.name.replace(/\.epub$/i, ''), author || parsed.author || '', 'epub', parsed.chapters.map((c, i) => ({ title: c.title || ('第 ' + (i + 1) + ' 节'), text: c.text })), parsed.coverDataUrl || '');
        closeTopSheet(); toast('导入成功'); renderLib();
        return;
      }
      setStatus('正在读取…', true);
      content = await readFileText(file);
      format = 'txt';
    } else content = paste;
    if (!content || !content.trim()) { toast('没有内容'); return; }
    const chapters = splitBook(content).map(c => ({ title: c.title, text: c.text }));
    if (!chapters.length) { toast('没解析出章节'); return; }
    await importBook(title || (file ? file.name.replace(/\.(txt|md|markdown)$/i, '') : '未命名'), author, format, chapters, '');
    closeTopSheet(); toast('导入成功'); renderLib();
  } catch (e) {
    setStatus('失败：' + (e.message || e), false);
    toast('导入失败：' + (e.message || e));
  }
}
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('读取失败'));
    r.readAsText(file, 'utf-8');
  });
}
async function importBook(title, author, format, chapters, coverImg) {
  const bookId = 'book_' + uid();
  const covers = ['#6f5d48', '#5b6e5a', '#5f6e7a', '#7a6557', '#6d5b74', '#5a7468'];
  const coverColor = covers[Math.floor(Math.random() * covers.length)];
  const chapterMeta = [];
  let paraStart = 0;
  for (let i = 0; i < chapters.length; i++) {
    const cid = 'ch_' + bookId + '_' + i;
    const pcount = parasOf(chapters[i].text).length;
    await upsert('chapters', { id: cid, bookId, idx: i, title: chapters[i].title, text: chapters[i].text, paraStart, paraCount: pcount });
    chapterMeta.push({ cid, title: chapters[i].title, paraCount: pcount });
    paraStart += pcount;
  }
  await upsert('books', { id: bookId, version: 2, title: title || '未命名', author: author || '', format, coverColor, coverImg, chapterMeta, currentChapterId: chapterMeta[0] ? chapterMeta[0].cid : null, currentParaNum: 0, currentScrollRatio: 0, createdAt: Date.now(), lastReadAt: Date.now(), lastCoReadAt: null });
  addTimelineEvent('导入了一本书', `${format === 'epub' ? 'epub · ' : ''}${title}`, 'import', { bookId });
}

/* ───────── 改变（独立周期分析，不在普通共读中判断） ─────────
   走小模型（ai.chat + apiConfigId），输出到 changes 表，
   AI 只提出「可能发生的改变」，用户确认后才正式保存。 */
async function runChangeAnalysis(force) {
  /* 节流：距上次至少 7 天（或用户手动触发） */
  if (!force) {
    try {
      const meta = await listData('meta');
      const last = meta.find(m => m.id === 'change_last');
      if (last && last.at && Date.now() - last.at < 7 * 86400000) return;
    } catch (e) {}
  }
  const understandings = S.insights.filter(i => displayType(i.type) === '我的理解');
  const practices = S.practices || [];
  const answered = S.questions.filter(q => q.status === 'answered');
  const totalSignals = understandings.length + practices.length + answered.length;
  if (totalSignals < 3) return;  // 样本不足，不做分析
  try {
    /* 4.0：改变分析必须能「跨时间」，否则判断不了长期变化。
       改成「早期 vs 近期」对照取样，带上时间戳，让 AI 看到变化起点与终点。 */
    const byTime = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
    const earlyU = [...understandings].sort(byTime).slice(0, 5);
    const lateU = [...understandings].sort(byTime).slice(-5);
    const earlyP = [...practices].sort(byTime).slice(0, 3);
    const lateP = [...practices].sort(byTime).slice(-3);
    const earlyQ = [...answered].sort(byTime).slice(0, 2);
    const lateQ = [...answered].sort(byTime).slice(-2);
    const compact = [
      '【早期记录】（观察变化的起点）',
      ...earlyU.map(i => `- 理解(${fmtDay(i.createdAt)})：${i.text}`),
      ...earlyP.map(i => `- 实践：${i.belief || ''}${i.action ? ' → ' + i.action : ''}`),
      ...earlyQ.map(q => `- 问题已回应：${q.text} → ${q.answerText}`),
      '【近期记录】（观察变化的终点）',
      ...lateU.map(i => `- 理解(${fmtDay(i.createdAt)})：${i.text}`),
      ...lateP.map(i => `- 实践：${i.belief || ''}${i.action ? ' → ' + i.action : ''}`),
      ...lateQ.map(q => `- 问题已回应：${q.text} → ${q.answerText}`),
    ].join('\n');
    const text = await lightAIText(
      '你是一位长期自我观察的分析助手。给你一段读者的长期记录，已按时间分成「早期」和「近期」两组。请对比早期与近期，判断是否存在「长期改变」：观念、行为模式、生活方式或自我认知上持续的变化趋势。要求：1) 必须基于「早期跟近期对照」发现的变化趋势，不能只看某一条记录；2) 时间跨度不足、或早期与近期没有可对照的差异，就输出「暂无」；3) 若有，输出格式：【可能改变】观念/行为/自我认知：一句话描述（附依据来源，注明从早期怎样的状态，到近期怎样的状态）。克制，宁可「暂无」不要硬凑。',
      compact, { apiConfigId: S.coset.smallApi, timeoutMs: 60000 }
    );
    const m = text.match(/【可能改变】([\s\S]+)/);
    if (m && !/暂无/.test(m[1])) {
      /* 4.0 证据链：记录这次改变由哪些理解/实践/回应支撑，详情页可逐条点回 */
      const evidence = [
        ...lateU.slice(0, 3).map(i => ({ kind: '理解', id: i.id, text: i.text, bookId: i.bookId, chapterId: i.chapterId, paraNum: i.paraNum })),
        ...lateP.slice(0, 2).map(p => ({ kind: '实践', id: p.id, text: (p.belief || '') + (p.action ? ' → ' + p.action : ''), bookId: p.bookId })),
        ...lateQ.slice(0, 1).map(q => ({ kind: '问题回应', id: q.id, text: q.text + ' → ' + q.answerText, bookId: q.bookId })),
      ];
      const change = {
        id: 'chg_' + uid(), text: m[1].slice(0, 160),
        bookId: null, source: '周期分析', confirmed: false,
        evidence, createdAt: Date.now(),
      };
      await upsert('changes', change);
      S.changes.push(change);
      toast('发现一条可能的变化，去「生活」查看确认');
    }
    await upsert('meta', { id: 'change_last', at: Date.now() });
  } catch (e) {
    /* 失败静默，下次再试 */
  }
}
/* 用户确认改变后才正式保存 */
async function confirmChange(id) {
  const rows = await listCol('changes');
  const found = rows.find(r => r.data && r.data.id === id);
  if (!found) return;
  const merged = { ...found.data, confirmed: true, confirmedAt: Date.now() };
  await A.db.update('changes', found.id, merged);
  const idx = S.changes.findIndex(c => c.id === id);
  if (idx >= 0) S.changes[idx] = merged;
  toast('已确认这条改变');
  renderMind();
}
/* 用户主动创建改变记录（观察到的长期变化） */
async function createChangeManual(text) {
  const change = {
    id: 'chg_' + uid(), text, bookId: null, source: '用户主动记录',
    confirmed: true, confirmedAt: Date.now(), createdAt: Date.now(),
  };
  await upsert('changes', change);
  S.changes.push(change);
  toast('改变记录已保存');
}

/* ───────── 共读设置（上下文全透明配置 + 改变分析 + 本次上下文查看） ───────── */
function openCoreadSettings() {
  const coset = S.coset;
  const ctxOptions = [5, 10, 20, 40, 80];
  const origLenOptions = [500, 1000, 2000, 3000, 5000];
  const summaryLenOptions = [300, 500, 800, 1200, 2000];
  const recallOptions = [1, 2, 3, 5, 8];
  const ctxHtml = `共读 · 上下文设置
    <div class="field"><label>最近对话条数</label>
      <div class="type-chips">${ctxOptions.map(n => `<button class="type-chip${coset.ctxMsgs === n ? ' sel' : ''}" data-n="${n}">${n}</button>`).join('')}</div></div>
    <div class="field"><label>原文窗口（每轮共读取多少字原文）</label>
      <div class="type-chips">${origLenOptions.map(n => `<button class="type-chip${coset.origLen === n ? ' sel' : ''}" data-ol="${n}">${n}字</button>`).join('')}</div></div>
    <div class="field"><label>章节精炼长度（进入章节时生成，覆盖整章）</label>
      <div class="type-chips">${summaryLenOptions.map(n => `<button class="type-chip${(coset.summaryLen || 800) === n ? ' sel' : ''}" data-sl="${n}">${n}字</button>`).join('')}</div></div>
    <div class="field"><label>共读角色浓缩卡</label>
      <textarea id="cardInput" placeholder="${esc(DEFAULT_CARD)}" style="min-height:80px;">${coset.card ? esc(coset.card) : ''}</textarea></div>
    <div class="field"><label>小模型 API 配置 ID（可选，用于精炼/概念提取/召回筛选/摘要等杂活；留空用默认 API）</label>
      <input type="text" id="smallApiInput" placeholder="配置 ID，如 deepseek-chat" value="${esc(coset.smallApi || '')}"></div>
    <div class="field" style="font-size:12px;color:var(--ink-3);">杂活走小模型 <code>ai.chat</code>，共读回复仍走大模型角色链路。两者都在「设置 → API 设置」配置。</div>`;

  const recallHtml = `智能检索 · 数量限制
    <div class="field"><label>本书理解 ≤</label>
      <div class="type-chips">${recallOptions.map(n => `<button class="type-chip${(coset.recall.bookU || 3) === n ? ' sel' : ''}" data-rk="bookU" data-rn="${n}">${n}</button>`).join('')}</div></div>
    <div class="field"><label>本书问题 ≤</label>
      <div class="type-chips">${recallOptions.map(n => `<button class="type-chip${(coset.recall.bookQ || 2) === n ? ' sel' : ''}" data-rk="bookQ" data-rn="${n}">${n}</button>`).join('')}</div></div>
    <div class="field"><label>跨书理解 ≤</label>
      <div class="type-chips">${recallOptions.map(n => `<button class="type-chip${(coset.recall.crossU || 2) === n ? ' sel' : ''}" data-rk="crossU" data-rn="${n}">${n}</button>`).join('')}</div></div>
    <div class="field"><label>跨书问题 ≤</label>
      <div class="type-chips">${recallOptions.map(n => `<button class="type-chip${(coset.recall.crossQ || 1) === n ? ' sel' : ''}" data-rk="crossQ" data-rn="${n}">${n}</button>`).join('')}</div></div>`;

  const memHtml = `上下文开关
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;">
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" id="ckSummary" ${coset.includeSummary ? 'checked' : ''}> 章节精炼</label>
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" id="ckMsgs" ${coset.includeMsgs !== false ? 'checked' : ''}> 最近对话</label>
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" id="ckCross" ${coset.includeCrossBook !== false ? 'checked' : ''}> 跨书召回</label>
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" id="ckCard" ${coset.includeCard ? 'checked' : ''}> 人设卡</label>
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" id="ckCore" ${coset.includeCore ? 'checked' : ''}> 核心记忆</label>
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;"><input type="checkbox" id="ckLong" ${coset.includeMemLong ? 'checked' : ''}> 长期记忆</label>
    </div>`;

  const ctxState = `本次共读上下文
    <div class="field" style="font-size:12px;color:var(--ink-3);line-height:1.6;">
      ${ctxLog.origLen > 0 ? `原文窗口：${ctxLog.origLen} 字 ✓<br>` : '原文窗口：未开始共读<br>'}
      ${ctxLog.summary ? '章节精炼：✓<br>' : ''}
      ${ctxLog.bookU > 0 ? `本书理解：${ctxLog.bookU} 条<br>` : ''}
      ${ctxLog.bookQ > 0 ? `本书问题：${ctxLog.bookQ} 条<br>` : ''}
      ${ctxLog.crossU > 0 ? `跨书理解：${ctxLog.crossU} 条<br>` : ''}
      ${ctxLog.crossQ > 0 ? `跨书问题：${ctxLog.crossQ} 条<br>` : ''}
      ${ctxLog.concepts > 0 ? `概念引用：${ctxLog.concepts} 条<br>` : ''}
      ${ctxLog.sessions > 0 ? `会话摘要：${ctxLog.sessions} 条<br>` : ''}
      ${ctxLog.card ? '人设卡：✓<br>' : ''}
      ${ctxLog.msgs > 0 ? `最近对话：${ctxLog.msgs} 条<br>` : ''}
      ${ctxLog.core ? '核心记忆：✓<br>' : ''}
      ${ctxLog.memLong ? '长期记忆：✓<br>' : ''}
      ${ctxLog.tokenEst > 0 ? `预估 token：~${ctxLog.tokenEst} tokens<br>` : ''}
      ${ctxLog.origLen === 0 ? '<span style="color:var(--ink-3);">开始一次共读后会自动记录</span>' : ''}
    </div>`;

  openSheet({
    title: '共读设置',
    html: `<div class="setting-section">${ctxHtml}</div>
      <div class="setting-section" style="margin-top:18px;">${recallHtml}</div>
      <div class="setting-section" style="margin-top:18px;">${memHtml}</div>
      <div class="btn-row"><button class="btn-c" id="csCancel">取消</button><button class="btn-p" id="csSave">保存</button></div>
      <div class="setting-section" style="margin-top:18px;padding-top:14px;border-top:1px dashed var(--line);">
        <div class="section-label">本次共读 AI 看到的上下文</div>
        ${ctxState}
      </div>
      <div style="margin-top:18px;"><button class="change-btn" id="csChange">✧ 手动运行「改变」周期分析</button>
      <div style="font-size:11.5px;color:var(--ink-3);margin-top:4px;">改变不会在普通共读中自动判断；它只在这里（手动）或积累一段阅读周期后由独立分析提出，你确认后才会保存。</div></div>`,
    onOpen: (root) => {
      /* 最近对话条数 */
      root.querySelectorAll('.type-chip[data-n]').forEach(c => c.addEventListener('click', () => {
        root.querySelectorAll('.type-chip[data-n]').forEach(x => x.classList.remove('sel'));
        c.classList.add('sel');
        coset.ctxMsgs = parseInt(c.dataset.n);
      }));
      /* 原文长度 */
      root.querySelectorAll('.type-chip[data-ol]').forEach(c => c.addEventListener('click', () => {
        root.querySelectorAll('.type-chip[data-ol]').forEach(x => x.classList.remove('sel'));
        c.classList.add('sel');
        coset.origLen = parseInt(c.dataset.ol);
      }));
      /* 精炼长度 */
      root.querySelectorAll('.type-chip[data-sl]').forEach(c => c.addEventListener('click', () => {
        root.querySelectorAll('.type-chip[data-sl]').forEach(x => x.classList.remove('sel'));
        c.classList.add('sel');
        coset.summaryLen = parseInt(c.dataset.sl);
      }));
      /* 检索量 */
      root.querySelectorAll('.type-chip[data-rk]').forEach(c => c.addEventListener('click', () => {
        const key = c.dataset.rk;
        const val = parseInt(c.dataset.rn);
        root.querySelectorAll(`.type-chip[data-rk="${key}"]`).forEach(x => x.classList.remove('sel'));
        c.classList.add('sel');
        if (!coset.recall) coset.recall = {};
        coset.recall[key] = val;
      }));
      root.querySelector('#csCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#csSave').addEventListener('click', async () => {
        coset.card = root.querySelector('#cardInput').value.trim();
        coset.smallApi = root.querySelector('#smallApiInput').value.trim();
        coset.includeCore = root.querySelector('#ckCore').checked;
        coset.includeMemLong = root.querySelector('#ckLong').checked;
        coset.includeCard = root.querySelector('#ckCard').checked;
        coset.includeSummary = root.querySelector('#ckSummary').checked;
        coset.includeMsgs = root.querySelector('#ckMsgs').checked;
        coset.includeCrossBook = root.querySelector('#ckCross').checked;
        await saveCoreadSettings();
        closeTopSheet();
        toast('已保存');
      });
      root.querySelector('#csChange').addEventListener('click', async () => {
        toast('开始分析…');
        await runChangeAnalysis(true);
        closeTopSheet();
        toast('分析完成，如发现改变会出现在「生活」');
      });
    },
  });
}

/* ───────── Bottom Sheet 通用组件 ───────── */
let sheetStack = [];
function openSheet({ title, html, onOpen }) {
  const root = $id('sheetRoot');
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="sheet"><div class="grab"></div><div class="s-title">${esc(title)}</div><div class="sheet-content">${html}</div></div>`;
  root.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  mask.addEventListener('click', (e) => { if (e.target === mask && sheetStack[sheetStack.length - 1] === mask) closeTopSheet(); });
  sheetStack.push(mask);
  if (onOpen) onOpen(mask.querySelector('.sheet-content'), mask);
  return mask;
}
function closeTopSheet() {
  const mask = sheetStack.pop();
  if (!mask) return;
  mask.classList.remove('open');
  setTimeout(() => mask.remove(), 260);
}

/* ───────── 时间线事件 ───────── */
async function addTimelineEvent(kind, text, type, anchor) {
  const rec = {
    id: 'tl_' + uid(), kind, text,
    bookId: anchor ? anchor.bookId : (S.rBook ? S.rBook.id : null),
    chapterId: anchor ? anchor.chapterId : (S.rChapter ? S.rChapter.id : null),
    ts: Date.now(),
  };
  await upsert('timeline', rec);
  S.timeline.push(rec);
}

/* ───────── 导航 ───────── */
function switchTab(tab) {
  S.tab = tab;
  if (tab === 'desk') renderDesk();
  else if (tab === 'lib') renderLib();
  else if (tab === 'life') renderLife();
  else renderMind();
}
$qa('.tabbar button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ───────── 初始化 ───────── */
async function init() {
  if (!A) { $id('deskBody').innerHTML = '<div style="text-align:center;padding:60px;color:#aaa;">请在 AI 小手机内打开</div>'; return; }
  buildSelBar();
  /* 旧数据轻迁移 */
  const bookRows = await listCol('books');
  for (const row of bookRows) {
    const b = row.data;
    if (!b) continue;
    if (b.version === 2) continue;
    if (typeof b.content === 'string') {
      const chapters = splitBook(b.content);
      const chapterMeta = [];
      let paraStart = 0;
      for (let i = 0; i < chapters.length; i++) {
        const cid = 'ch_' + b.id + '_' + i;
        const pcount = parasOf(chapters[i].text).length;
        await upsert('chapters', { id: cid, bookId: b.id, idx: i, title: chapters[i].title, text: chapters[i].text, paraStart, paraCount: pcount });
        chapterMeta.push({ cid, title: chapters[i].title, paraCount: pcount });
        paraStart += pcount;
      }
      const oldChapter = b.currentChapter || 0;
      const oldPara = b.currentPara || 0;
      const meta = chapterMeta[oldChapter] || chapterMeta[0];
      const base = meta ? chapterMeta.slice(0, oldChapter).reduce((a, m) => a + m.paraCount, 0) : 0;
      await A.db.update('books', row.id, {
        ...b, version: 2, chapterMeta,
        currentChapterId: meta ? meta.cid : (chapterMeta[0] && chapterMeta[0].cid),
        currentParaNum: Math.max(0, Math.min(base + oldPara, paraStart - 1)),
        currentScrollRatio: 0,
      });
    }
  }
  await loadAll();
  await loadCoreadSettings();
  /* 打开 App 默认进入「书桌」，不再自动打开上次的阅读器 */
  renderDesk();
  /* 后台尝试改变分析（节流 7 天） */
  setTimeout(() => runChangeAnalysis(false), 2000);
}
window.addEventListener('pagehide', () => { saveProgress().catch(() => {}); });
init();