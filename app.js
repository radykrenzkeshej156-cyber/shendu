/* ============================================================
   深读 2.0 · app.js
   数据模型：
   - books     {id, version:2, title, author, format, coverColor, coverImg,
                chapterMeta:[{cid,title,paraCount}], currentChapterId,
                currentParaNum, currentScrollRatio, createdAt, lastReadAt, lastCoReadAt}
   - chapters  {id, bookId, idx, title, text, paraStart}
   - insights  {id, slug, rootId, type, text, bookId, chapterId, paraNum, quote,
                createdAt, growthAt}   (rootId=null 是思想根；growth 记录挂在 root 下)
   - questions {id, text, bookId, chapterId, paraNum, quote, status, answerText,
                answeredAt, createdAt, anchors:[{bookId,chapterId,paraNum}]}
   - sessions  {id, bookId, chapterId, paraNum, quote, topic, msgs:[], createdAt}
   - traces    {id, bookId, chapterId, paraNum, type, sessionId, summary, ts}
   - timeline  {id, kind, title, text, bookId, chapterId, ts}
   - settings  {id:'companion', companionId}
   - state     {id:'reading', bookId, chapterId, paraNum, scrollRatio}
   ============================================================ */
'use strict';
const A = window.AiPhone;
/* 全局选择器：传 ID 用 getElementById（写 'rChapTitle' 或 '#rChapTitle' 都行），
   传复杂选择器用 querySelector/querySelectorAll */
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
function fmtDT(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  return fmtDay(ts);
}

/* 归一化 db.list 的两种返回形态 */
function normRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map(x => {
    if (x && typeof x === 'object' && 'data' in x && x.data && typeof x.data === 'object') {
      return { id: x.id, data: x.data };
    }
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
async function listData(col) {
  const rows = await listCol(col);
  return rows.map(r => r.data).filter(Boolean);
}

/* ───────── 全局状态 ───────── */
const S = {
  tab: 'desk',
  books: [], groups: [], insights: [], questions: [], timeline: [],
  companionId: null,
  rBook: null, rChapter: null, rChapters: [],
  rParas: [], rParaCur: 0, rUI: false, rMaxLoaded: 400,
  coSession: null, generating: false,
};
const WORDS = ['我的理解', '我的故事', '共鸣', '闪回', '概念', '延伸'];
const INSIGHT_TYPES = WORDS;

/* ───────── 章节切分 ───────── */
const CHAPTER_RE = /^(第[\d一二三四五六七八九十百千万零〇两]+[章节回卷篇部]|序章|序言|尾声|终章|引子|楔子|后记|跋|附录|Chapter\s+\d+|#+\s+|第[\d一二三四五六七八九十百千万零〇两]+章[:\s])/i;

function stripTocLines(lines) {
  const head = lines.slice(0, 60);
  const hasToc = head.some(l => /^目\s*录\s*$/.test(l.trim()) || /^contents\s*$/i.test(l.trim()));
  if (!hasToc) return lines;
  let firstChap = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CHAPTER_RE.test(lines[i].trim())) { firstChap = i; break; }
  }
  if (firstChap > 2) {
    const seg = lines.slice(0, firstChap);
    const dotted = seg.filter(l => l.includes('…') || l.includes('...') || l.includes('……')).length;
    if (dotted >= Math.max(2, seg.length * 0.25)) return lines.slice(firstChap);
  }
  return lines;
}

function splitBook(content) {
  const rawLines = String(content).split(/\n/);
  const lines = stripTocLines(rawLines);
  const chapters = [];
  let cur = null;
  for (const line of lines) {
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
  if (!chapters.length) chapters.push({ title: '', lines: rawLines });
  if (!chapters[0].title) chapters[0].title = '开篇';
  return chapters.map(c => ({
    title: c.title || '未命名',
    text: c.lines.join('\n').replace(/\n{3,}/g, '\n\n'),
  }));
}

function parasOf(text) {
  return text.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => ({
    t: s, head: CHAPTER_RE.test(s) || false,
  }));
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

/* ───────── 迁移：V1 → V2（旧数据可选，不跑也没事） ───────── */
const _migrated = 'deepread_v2_migrated';
async function migrateIfNeeded() {
  try {
    const flag = await listData('meta');
    if (flag.some(m => m && m.id === _migrated)) return;
  } catch (e) {}
  const bookRows = await listCol('books');
  let did = false;
  for (const row of bookRows) {
    const b = row.data;
    if (!b || b.version === 2 || typeof b.content !== 'string') continue;
    const chapters = splitBook(b.content);
    const chapterMeta = [];
    let paraStart = 0;
    for (let i = 0; i < chapters.length; i++) {
      const cid = 'ch_' + b.id + '_' + i;
      const pcount = parasOf(c.text).length;
      await upsert('chapters', { id: cid, bookId: b.id, idx: i, title: c.title, text: c.text, paraStart, paraCount: pcount });
      chapterMeta.push({ cid, title: c.title, paraCount: pcount });
      paraStart += pcount;
    }
    const oldChapter = b.currentChapter || 0;
    const oldPara = b.currentPara || 0;
    const meta = chapterMeta[oldChapter] || chapterMeta[0];
    let newParaNum = 0;
    if (meta) {
      const base = chapterMeta.slice(0, oldChapter).reduce((a, m) => a + m.paraCount, 0);
      newParaNum = Math.min(base + oldPara, paraStart - 1);
    }
    await A.db.update('books', row.id, {
      ...b, version: 2,
      chapterMeta,
      currentChapterId: meta ? meta.cid : (chapterMeta[0] && chapterMeta[0].cid),
      currentParaNum: Math.max(0, newParaNum),
      currentScrollRatio: 0,
    });
    did = true;
  }
  await upsert('meta', { id: _migrated, at: Date.now() });
  return did;
}

/* ───────── 书库加载 / 书单 ───────── */
async function loadBooks() { S.books = await listData('books'); return S.books; }
async function loadGroups() { S.groups = await listData('groups'); return S.groups; }
async function loadInsights() { S.insights = await listData('insights'); return S.insights; }
async function loadQuestions() { S.questions = await listData('questions'); return S.questions; }
async function loadTimeline() { S.timeline = await listData('timeline'); return S.timeline; }

async function bookChapters(bookId) {
  const rows = await listCol('chapters');
  return rows.map(r => r.data).filter(c => c && c.bookId === bookId).sort((a, b) => a.idx - b.idx);
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
    if (!book.currentChapterId && chapterMeta.length) book.currentChapterId = chapterMeta[0].cid;
    await upsert('books', book);
    return await bookChapters(book.id);
  }
  return [];
}

/* 打开阅读器 */
async function openReader(bookId, chapterIdTo, paraTo) {
  try {
    const book = S.books.find(b => b.id === bookId);
    if (!book) { toast('书不见了'); return; }
    S.rBook = book;
    S.rChapters = await ensureBookChapters(book);
    if (!S.rChapters.length) { toast('这本书还没有可读的正文'); return; }
    S.readerChapterIndex = Math.max(0, S.rChapters.findIndex(c => c.id === (chapterIdTo || book.currentChapterId)));
    if (S.readerChapterIndex < 0) S.readerChapterIndex = 0;
    const ch = S.rChapters[S.readerChapterIndex];
    S.rChapter = ch;
    $id('rChapTitle').textContent = ch ? ch.title : '';
    S.rParaCur = paraTo != null ? paraTo : Math.max(0, book.currentParaNum || 0);
    const base = ch ? chapterParaStart(book, ch.id) : 0;
    S.rParaLocal = Math.max(0, S.rParaCur - base);
    S.rParas = ch ? parasOf(ch.text) : [];
    const rScroll = $id('rScroll');
    rScroll.scrollTop = 0;
    $id('reader').classList.add('open');
    document.body.style.overflow = 'hidden';
    renderChapter();
    if (paraTo == null && (book.currentParaNum || 0) > 0) {
      const ratio = book.currentScrollRatio || 0;
      if (ratio > 0 && ratio < 1) {
        rScroll.scrollTop = ratio * (rScroll.scrollHeight - rScroll.clientHeight);
        setTimeout(() => recalcParaFromViewport(), 50);
      } else if (S.rParaLocal > 0) {
        scrollToLocalPara(S.rParaLocal);
      }
    } else if (S.rParaLocal > 0) {
      scrollToLocalPara(S.rParaLocal);
    }
    await saveProgress();
    await saveReadingState({ chapterId: ch ? ch.id : null, paraNum: S.rParaCur, scrollRatio: book.currentScrollRatio || 0 });
    loadCoSessionFor(ch ? ch.id : null).then(() => {});
    updateCompanionAvatar();
  } catch (e) {
    console.error('openReader:', e);
    toast('打开失败：' + (e && e.message ? e.message : e));
  }
}

/* 渲染阅读页 */
function renderChapter() {
  const inner = $id('rInner');
  if (!S.rChapter) { inner.innerHTML = '<div class="empty">这本书没有内容</div>'; return; }
  inner.innerHTML = chapterTitleHtml(S.rChapter, S.readerChapterIndex) + renderParaBatch(S.rParas, 0, S.rMaxLoaded);
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
function renderParaBatch(paras, from, to) {
  let html = '';
  for (let i = from; i < Math.min(to, paras.length); i++) {
    const p = paras[i];
    html += `<div class="para ${p.head ? 'head' : ''}" data-para-i="${i}">${esc(p.t)}</div>`;
  }
  return html;
}

function toggleReaderUI(force) {
  S.rUI = force != null ? force : !S.rUI;
  $id('reader').classList.toggle('ui', S.rUI);
}
function closeReader() {
  saveProgress();
  if (S.rChapter) saveReadingState({ chapterId: S.rChapter.id, paraNum: S.rParaCur });
  $id('reader').classList.remove('open');
  document.body.style.overflow = '';
  S.rUI = false;
}
function jumpReaderTo(chapterId, paraNum) {
  const idx = Math.max(0, S.rChapters.findIndex(c => c.id === chapterId));
  if (idx < 0) return;
  S.readerChapterIndex = idx;
  S.rChapter = S.rChapters[idx];
  S.rParas = parasOf(S.rChapter.text);
  const base = chapterParaStart(S.rBook, chapterId);
  S.rParaCur = base + Math.max(0, paraNum || 0);
  S.rParaLocal = Math.max(0, paraNum || 0);
  S.rBook.currentChapterId = chapterId;
  S.rBook.currentParaNum = S.rParaCur;
  $id('rChapTitle').textContent = S.rChapter.title;
  S.rUI = false;
  renderChapter();
  saveProgress();
  saveReadingState({ chapterId, paraNum: S.rParaCur });
  $id('rNextHint').hidden = true;
}
function scrollToLocalPara(local) {
  const el = $q(`.para[data-para-i="${local}"]`);
  if (el) el.scrollIntoView({ block: 'start' });
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
  const base = chapterParaStart(S.rBook, S.rChapter.id);
  S.rParaLocal = i;
  S.rParaCur = base + i;
  S.rBook.currentParaNum = S.rParaCur;
  $id('rProgress').textContent = progressLabel();
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
  } else chip.hidden = true;
}

$id('rBack').addEventListener('click', closeReader);
$id('rToc').addEventListener('click', () => { openTocSheet(S.rBook.id, S.rChapter ? S.rChapter.id : null); toggleReaderUI(false); });
$id('rScroll').addEventListener('click', (e) => {
  if (e.target.closest('[data-para-i],.trace-dot,.chip-nav,.reader-top,.reader-bottom')) return;
  toggleReaderUI();
});
$id('rDetail').addEventListener('click', () => { toggleReaderUI(false); openBookDetail(S.rBook.id); });
$id('rMind').addEventListener('click', () => { closeReader(); switchTab('mind'); });
$id('rCo').addEventListener('click', () => {
  if (!S.companionId) ensureCompanion().then(ok => ok && openCoRead('chapter', '', 0, 0));
  else openCoRead('chapter', '', 0, 0);
});
/* ───────── 痕迹 ───────── */
async function loadTraces(bookId) {
  const rows = await listCol('traces');
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
    const hit = traces.find(t => t.chapterId === ch.id && t.paraNum === num) || traces.find(t => t.paraNum === num);
    if (hit) {
      const dot = document.createElement('span');
      dot.className = 'trace-dot ' + (hit.type === 'insight' ? 'insight' : hit.type === 'question' ? 'question' : '');
      dot.addEventListener('click', (e) => { e.stopPropagation(); openTraceDetail(hit.id); });
      pEl.appendChild(dot);
    }
  });
}
function updateAllTraces() { applyTraceDots().then(() => {}); }
async function openTraceDetail(traceId) {
  const rows = await listCol('traces');
  const trace = rows.map(r => r.data).find(t => t && t.id === traceId);
  if (!trace) return;
  const lines = [];
  if (trace.summary) lines.push('「' + trace.summary + '」');
  if (trace.type === 'coread' && trace.sessionId) {
    const sRows = await listCol('sessions');
    const sess = sRows.map(r => r.data).find(s => s && s.id === trace.sessionId);
    if (sess && sess.msgs) lines.push(`共读 ${sess.msgs.length} 条记录，可重新打开继续读`);
  } else if (trace.type === 'insight') {
    const ins = S.insights.find(i => i.id === trace.insightId) || S.insights.find(i => i.quote === trace.summary);
    if (ins) lines.push('沉淀为「' + ins.type + '」: ' + ins.text);
  }
  openSheet({ title: '阅读痕迹', html: `<div style="font-size:13.5px;line-height:1.8;color:var(--ink-2);">${esc(lines.join('\n'))}</div>` });
}

/* ───────── 文本选择工具条 ───────── */
let selInfo = { text: '', para: 0, chapId: null };
function buildSelBar() {
  const bar = $id('selBar');
  bar.innerHTML = `
    <button data-act="coread">共读</button>
    <button data-act="mark">标记</button>
    <button data-act="question">悬题</button>
    <button data-act="note">笔记</button>`;
  bar.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    hideSelBar();
    handleSelAction(act);
  }));
}
function hideSelBar() { $id('selBar').classList.remove('show'); }
$id('rScroll').addEventListener('mouseup', onTextSelect);
$id('rScroll').addEventListener('touchend', onTextSelect);
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) hideSelBar();
});
function onTextSelect() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSelBar(); return; }
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
  else if (act === 'mark') saveMark(text, para);
  else if (act === 'question') openQuestionSheet({ bookId: S.rBook ? S.rBook.id : null, chapterId: chapId, para, local, quote: text });
  else if (act === 'note') openNoteSheet(text, para);
}

/* ───────── 目录抽屉 ───────── */
function openTocSheet(bookId, currentChapterId) {
  const book = S.books.find(b => b.id === bookId);
  if (!book) return;
  const chapters = book.chapterMeta || [];
  const html = `<div class="s-title">目录</div>` +
    chapters.map((c, i) => {
      const isCur = c.cid === (currentChapterId || book.currentChapterId);
      return `<button class="row-btn${isCur ? ' current' : ''}" data-cid="${c.cid}" data-i="${i}"
        style="${isCur ? 'color:var(--accent);font-weight:600;' : ''}">
        <span style="font-size:12px;color:var(--ink-3);margin-right:10px;">${String(i + 1).padStart(2, '0')}</span>${esc(c.title)}
      </button>`;
    }).join('');
  openSheet({
    title: '目录',
    html,
    onOpen: (root, mask) => {
      root.querySelectorAll('.row-btn[data-cid]').forEach(btn => btn.addEventListener('click', () => {
        closeTopSheet();
        jumpReaderTo(btn.dataset.cid, 0);
      }));
    },
  });
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
async function ensureCompanion() {
  if (S.companionId) return true;
  const chars = await A.characters.list();
  if (!chars.length) { toast('请先在聊天中创建角色'); return false; }
  if (chars.length === 1) {
    S.companionId = chars[0].id;
    await upsert('settings', { id: 'companion', companionId: S.companionId });
    return true;
  }
  return await new Promise((resolve) => {
    openSheet({
      title: '选择共读伙伴',
      html: chars.map(c => `<div class="char-row" data-id="${c.id}">
        <div class="av">${esc((c.name || '?')[0])}</div>
        <div style="font-size:14.5px;">${esc(c.name || '未命名')}</div>
      </div>`).join(''),
      onOpen: (root, mask) => {
        root.querySelectorAll('.char-row').forEach(row => row.addEventListener('click', async () => {
          S.companionId = row.dataset.id;
          closeTopSheet();
          await upsert('settings', { id: 'companion', companionId: S.companionId });
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
async function openCoRead(mode, quote, paraNum, local) {
  const ok = await ensureCompanion();
  if (!ok) return;
  if (!S.rChapter) { toast('请先打开一本书'); return; }
  newCoSession(mode, quote, paraNum, local);
  $id('coDrawer').classList.add('open');
  updateCompanionAvatar();
  renderCoHeader();
  renderCoMsgs();
}
function newCoSession(mode, quote, paraNum, local) {
  const chapter = S.rChapter;
  const topic = mode === 'quote' ? `划线共读 · ${chapter.title}` : `整章共读 · ${chapter.title}`;
  S.coSession = {
    id: 'sess_' + uid(),
    bookId: S.rBook.id, chapterId: chapter.id, chapterIdx: S.readerChapterIndex,
    paraNum: paraNum || 0, quote: quote || '', topic,
    msgs: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  upsert('sessions', S.coSession);
  upsert('traces', {
    id: 'tr_' + uid(), bookId: S.rBook.id, chapterId: chapter.id,
    paraNum: paraNum || 0, type: 'coread', sessionId: S.coSession.id,
    summary: quote ? quote.slice(0, 40) : chapter.title, ts: Date.now(),
  });
  addTimelineEvent(
    mode === 'quote' ? '开始共读一段原文' : '开始共读一章',
    `${S.rBook.title} · ${chapter.title}${mode === 'quote' ? '「' + quote.slice(0, 30) + '」' : ''}`,
    'coread'
  );
  updateAllTraces();
}
function renderCoHeader() {
  const s = S.coSession;
  if (!s) { $id('coTopic').textContent = '——'; return; }
  $id('coTopic').textContent = s.topic;
  const q = $id('coQuote');
  if (s.quote) {
    q.hidden = false;
    q.innerHTML = '<span class="qlabel">当前共读 · 原文</span>' + esc(s.quote);
  } else {
    q.hidden = false;
    q.innerHTML = '<span class="qlabel">当前共读 · 原文</span>' + esc(extractUnit(S.rChapter.text, Math.max(0, S.rParaLocal), 500));
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
    const qRef = m.quote ? `<div class="quote-ref">「${esc(m.quote.slice(0, 60))}」</div>` : '';
    html += `<div class="msg ${isUser ? 'user' : 'ai'}">${qRef}${esc(m.text)}</div>`;
  });
  el.innerHTML = html || '<div class="typing">说点什么，开始共读。</div>';
  el.scrollTop = el.scrollHeight;
}
async function sendCoMessage(msgText) {
  const s = S.coSession;
  if (!s || !msgText || S.generating) return;
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
    s.msgs.push({ role: 'ai', text: '（这次共读没能接通，请检查 API 设置后再试）', quote: '', at: Date.now() });
  }
  typingEl.remove();
  renderCoMsgs();
  S.generating = false;
  $id('coSend').disabled = false;
}
async function generateCoReply(userText, s) {
  const chapter = S.rChapters[S.readerChapterIndex] || S.rChapter;
  if (!chapter || !chapter.text) return '（这本书的章节暂时读不到原文，换个位置再共读吧）';
  const base = chapterParaStart(S.rBook, chapter.id);
  const local = Math.max(0, (s.paraNum || 0) - base);
  const unit = extractUnit(chapter.text, local, 2600);
  const relatedInsights = S.insights.filter(i => i.bookId === S.rBook.id && i.rootId == null).slice(-4);
  const relatedQuestions = S.questions.filter(q => q.bookId === S.rBook.id).slice(-4);
  const userLabel = '你';
  const history = s.msgs.slice(-6).map(m => `${m.role === 'user' ? userLabel : 'AI'}：${m.text}`).join('\n');
  const instruction = `你现在和${userLabel}一起深读《${S.rBook.title}》，这里是${chapter.title}。

【当前共读的原文】${s.quote ? '这是用户划线的句子：' + s.quote + '\n' : ''}【上下文】
${unit}

【${userLabel}刚才说】
${userText}

【前面几轮对话】${history ? '\n' + history : '（无）'}

【TA在这本书里留下的理解】
${relatedInsights.map(i => `-（${i.type}）${i.text}`).join('\n') || '（暂无）'}

【TA留过的悬题】
${relatedQuestions.map(q => `- ${q.text}${q.status === 'answered' ? '（已在想：' + q.answerText + '）' : '（仍在悬着）'}`).join('\n') || '（暂无）'}

【共读守则】
1. 你是共读者，不是老师、不是客服、不是总结工具。保持你自己的性格说话。
2. 你的全部重心是陪${userLabel}把这段原文想透：解释、澄清、追问、举例、比较、联系前后文、指出可能的矛盾、给出不同读法——但不要替TA下结论。
3. 不要轻易说「你的理解正确」。TA理解与原文有出入时温和指出；有歧义就承认有歧义；你不确定的就说不知道。
4. 不要输出大段总结或填充答案。一次只说一两个真正值得想的点，3～6 句。
5. 如果${userLabel}说出了值得长期留住的理解、经历、共鸣或悬而未决的问题，最后单独一行输出：
   【值得沉淀】类型：我的理解/我的故事/共鸣/闪回/概念/延伸/悬题
   内容：TA原话或概括的一句话
   没有就完全不输出这行。`;

  const result = await A.ai.generate({
    characterId: S.companionId,
    appTags: ['deepread', 'coread'],
    instruction,
  });
  let reply = (result.text || '').trim();
  const sugMatch = reply.match(/【值得沉淀】[ \t]*\n?(.*)$/s);
  if (sugMatch) {
    const body = sugMatch[1];
    const typeMatch = body.match(/类型[:：]\s*(我的理解|我的故事|共鸣|闪回|概念|延伸|悬题)\s*\n/);
    let type = null, content = null;
    if (typeMatch) {
      type = typeMatch[1];
      content = body.slice(typeMatch.index + typeMatch[0].length).replace(/^内容[:：]\s*/, '').trim();
    } else content = body.trim();
    reply = reply.slice(0, sugMatch.index).trim();
    if (content) showSuggestion(type || '我的理解', content, s);
  }
  return reply || '我在想。';
}
function showSuggestion(type, content, s) {
  const msgs = $id('coMsgs');
  const div = document.createElement('div');
  div.className = 'sugg-card';
  div.innerHTML = `<div class="s-title">值得沉淀为「${esc(type)}」</div><div>${esc(content)}</div>
  <div class="s-actions">
    <button class="s-save">保存</button>
    ${type !== '悬题' ? '<button class="s-branch">归入已有思想</button>' : ''}
    <button class="s-ignore">忽略</button>
  </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  div.querySelector('.s-save').addEventListener('click', async () => {
    div.remove();
    if (type === '悬题') {
      await createQuestion({ text: content, bookId: s.bookId, chapterId: s.chapterId, paraNum: s.paraNum, quote: s.quote });
      toast('悬题已留下');
    } else {
      await createInsight(type, content, { bookId: s.bookId, chapterId: s.chapterId, paraNum: s.paraNum, quote: s.quote });
      toast('已沉淀');
    }
  });
  const branch = div.querySelector('.s-branch');
  if (branch) branch.addEventListener('click', async () => {
    div.remove();
    openBranchSheet(type, content, s);
  });
  div.querySelector('.s-ignore').addEventListener('click', () => div.remove());
}
function openBranchSheet(type, content, s) {
  const candidates = S.insights.filter(i => i.rootId == null);
  openSheet({
    title: '这与哪个思想是一脉？',
    html: candidates.length ? candidates.map(i => `
      <button class="row-btn" data-iid="${i.id}">「${esc(i.type)}」${esc(i.text.slice(0, 40))}</button>`).join('')
      : `<div class="empty">还没有可归入的思想，直接保存为新思想吧。</div>`,
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-iid]').forEach(b => b.addEventListener('click', async () => {
        closeTopSheet();
        const parent = S.insights.find(i => i.id === b.dataset.iid);
        if (parent) {
          await upsert('insights', {
            id: uid(), slug: parent.slug, rootId: parent.id, type: type || parent.type,
            text: content, bookId: s.bookId, chapterId: s.chapterId, paraNum: s.paraNum,
            quote: s.quote || '', createdAt: Date.now(), growthAt: Date.now(),
          });
          toast('已归入这个思想的成长轨迹');
        }
      }));
    },
  });
}/* ───────── 共读抽屉事件 ───────── */
$id('coClose').addEventListener('click', () => { $id('coDrawer').classList.remove('open'); });
$id('coSend').addEventListener('click', () => {
  const input = $id('coInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendCoMessage(text);
});
$id('coInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $id('coSend').click(); } });
$id('coSaveI').addEventListener('click', () => {
  openInsightSheet({ quote: S.coSession ? S.coSession.quote : '' });
});
$id('coSaveQ').addEventListener('click', () => {
  if (!S.rBook || !S.rChapter) return;
  openQuestionSheet({ bookId: S.rBook.id, chapterId: S.rChapter.id, paraNum: S.rParaCur, quote: S.coSession ? S.coSession.quote : '', local: S.rParaLocal });
});
$id('coSess').addEventListener('click', openSessionList);

async function createInsight(type, text, anchor) {
  const root = {
    id: uid(), slug: normalize(text.slice(0, 12)), rootId: null,
    type, text, bookId: anchor.bookId, chapterId: anchor.chapterId,
    paraNum: anchor.paraNum || 0, quote: anchor.quote || '',
    createdAt: Date.now(), growthAt: Date.now(),
  };
  await upsert('insights', root);
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: anchor.bookId, chapterId: anchor.chapterId,
    paraNum: anchor.paraNum || 0, type: 'insight', insightId: root.id,
    summary: text.slice(0, 40), ts: Date.now(),
  });
  addTimelineEvent('留下理解', `「${type}」${text}`, 'insight', anchor);
  S.insights.push(root);
  updateAllTraces();
}
function normalize(s) { return String(s).trim().replace(/\s+/g, '-').slice(0, 16); }
function openInsightSheet(init) {
  init = init || {};
  openSheet({
    title: '记下这一笔',
    html: `
      <div class="field"><label>类型</label>
        <div class="type-chips">
          ${INSIGHT_TYPES.map(t => `<button class="type-chip${(!init.type && t === '我的理解') || init.type === t ? ' sel' : ''}" data-t="${t}">${t}</button>`).join('')}
        </div></div>
      <div class="field"><label>内容</label><textarea id="itText" placeholder="写下此刻的理解…">${init.text ? esc(init.text) : ''}</textarea></div>
      ${init.quote ? `<div class="field"><label>来自原文</label><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">${esc(init.quote.slice(0, 80))}</div></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="itCancel">取消</button><button class="btn-p" id="itSave">保存</button></div>`,
    onOpen: (root) => {
      let selType = init.type || '我的理解';
      root.querySelectorAll('.type-chip').forEach(ch => ch.addEventListener('click', () => {
        root.querySelectorAll('.type-chip').forEach(c => c.classList.remove('sel'));
        ch.classList.add('sel');
        selType = ch.dataset.t;
      }));
      root.querySelector('#itCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#itSave').addEventListener('click', async () => {
        const text = root.querySelector('#itText').value.trim();
        if (!text) { toast('写点内容'); return; }
        closeTopSheet();
        if (!S.rBook || !S.rChapter) { toast('请先打开一本书'); return; }
        await createInsight(selType, text, {
          bookId: S.rBook.id, chapterId: S.rChapter.id,
          paraNum: S.rParaCur, quote: init.quote || '',
        });
        toast('已保存');
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
      ${init.quote ? `<div class="field"><label>来自原文</label><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">${esc(init.quote.slice(0, 80))}</div></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="qCancel">取消</button><button class="btn-p" id="qSave">留下</button></div>`,
    onOpen: (root) => {
      root.querySelector('#qCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#qSave').addEventListener('click', async () => {
        const text = root.querySelector('#qText').value.trim();
        if (!text) { toast('写点内容'); return; }
        closeTopSheet();
        await createQuestion({
          text, bookId: init.bookId || (S.rBook ? S.rBook.id : null),
          chapterId: init.chapterId || (S.rChapter ? S.rChapter.id : null),
          paraNum: init.paraNum || S.rParaCur || 0, quote: init.quote || '',
        });
        toast('悬题已留下');
      });
    },
  });
}
async function createQuestion(q) {
  const rec = {
    id: uid(), text: q.text, bookId: q.bookId, chapterId: q.chapterId,
    paraNum: q.paraNum || 0, quote: q.quote || '',
    status: 'open', answerText: '', answeredAt: null, createdAt: Date.now(),
  };
  await upsert('questions', rec);
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: q.bookId, chapterId: q.chapterId,
    paraNum: q.paraNum || 0, type: 'question', questionId: rec.id,
    summary: q.text.slice(0, 40), ts: Date.now(),
  });
  addTimelineEvent('留下悬题', q.text, 'question', { bookId: q.bookId, chapterId: q.chapterId });
  S.questions.push(rec);
  updateAllTraces();
}
async function convertQuestionToInsight(q) {
  await createInsight('我的理解', q.answerText || q.text, {
    bookId: q.bookId, chapterId: q.chapterId, paraNum: q.paraNum, quote: q.quote,
  });
  q.status = 'answered';
  q.answeredAt = Date.now();
  await upsert('questions', q);
  addTimelineEvent('悬题有了回应', `${q.text} → ${q.answerText || '（已想通）'}`, 'question');
}
function openAnswerSheet(q) {
  openSheet({
    title: '这个悬题，你怎么想？',
    html: `
      <div class="field"><div style="font-size:13.5px;line-height:1.7;color:var(--ink);">${esc(q.text)}</div></div>
      <div class="field"><label>我的回应</label><textarea id="qAns" placeholder="此刻你是怎么想的…">${q.answerText ? esc(q.answerText) : ''}</textarea></div>
      <div class="btn-row"><button class="btn-c" id="qCancel">取消</button><button class="btn-p" id="qSave">留下回应</button></div>`,
    onOpen: (root) => {
      root.querySelector('#qCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#qSave').addEventListener('click', async () => {
        const text = root.querySelector('#qAns').value.trim();
        if (!text) { toast('写点内容'); return; }
        closeTopSheet();
        await convertQuestionToInsight(Object.assign({}, q, { answerText: text }));
        toast('已回应，并沉淀为你的一条理解');
      });
    },
  });
}
async function saveMark(quote, para) {
  if (!S.rBook || !S.rChapter) return;
  await upsert('annotations', {
    id: uid(), bookId: S.rBook.id, chapterId: S.rChapter.id,
    paraNum: para, selectedText: quote, content: '', fromWho: 'user', createdAt: Date.now(),
  });
  await upsert('traces', {
    id: 'tr_' + uid(), bookId: S.rBook.id, chapterId: S.rChapter.id,
    paraNum: para, type: 'mark', summary: quote.slice(0, 40), ts: Date.now(),
  });
  toast('已标记');
  updateAllTraces();
}
function openNoteSheet(quote, para) {
  openSheet({
    title: '批注',
    html: `
      <div class="field"><div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;background:var(--surface-2);border-radius:9px;padding:9px 11px;">「${esc(quote.slice(0, 100))}」</div></div>
      <div class="field"><textarea id="noteText" placeholder="写一笔…"></textarea></div>
      <div class="btn-row"><button class="btn-c" id="nCancel">取消</button><button class="btn-p" id="nSave">保存</button></div>`,
    onOpen: (root) => {
      root.querySelector('#nCancel').addEventListener('click', closeTopSheet);
      root.querySelector('#nSave').addEventListener('click', async () => {
        const content = root.querySelector('#noteText').value.trim();
        if (!content) { toast('写点什么'); return; }
        closeTopSheet();
        if (!S.rBook || !S.rChapter) return;
        await upsert('annotations', {
          id: uid(), bookId: S.rBook.id, chapterId: S.rChapter.id,
          paraNum: para, selectedText: quote, content, fromWho: 'user', createdAt: Date.now(),
        });
        await upsert('traces', {
          id: 'tr_' + uid(), bookId: S.rBook.id, chapterId: S.rChapter.id,
          paraNum: para, type: 'note', summary: quote.slice(0, 40), ts: Date.now(),
        });
        toast('已记住');
        updateAllTraces();
      });
    },
  });
}
async function openSessionList() {
  const rows = await listData('sessions');
  const mine = rows.filter(s => S.rBook && s.bookId === S.rBook.id).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  openSheet({
    title: '这个章节的共读',
    html: mine.length ? mine.map(s => `
      <button class="row-btn" data-sid="${s.id}">
        <b>${esc(s.topic)}</b><br>
        <span style="font-size:11.5px;color:var(--ink-3);">${s.msgs.length} 轮 · ${timeAgo(s.updatedAt)}</span>
      </button>`).join('') : '<div class="empty">还没有共读记录</div>',
    onOpen: (root) => {
      root.querySelectorAll('.row-btn[data-sid]').forEach(b => b.addEventListener('click', async () => {
        const sid = b.dataset.sid;
        const all = await listData('sessions');
        const found = all.find(x => x.id === sid);
        closeTopSheet();
        if (!found) return;
        S.coSession = found;
        $id('coDrawer').classList.add('open');
        renderCoHeader();
        renderCoMsgs();
      }));
    },
  });
}

/* ───────── 时间线事件 ───────── */
async function addTimelineEvent(kind, text, type, anchor) {
  await upsert('timeline', {
    id: 'tl_' + uid(), kind, text,
    bookId: anchor ? anchor.bookId : (S.rBook ? S.rBook.id : null),
    chapterId: anchor ? anchor.chapterId : (S.rChapter ? S.rChapter.id : null),
    ts: Date.now(),
  });
}

/* ───────── 思想空间 ───────── */
async function renderMind(filter = 'all') {
  S.tab = 'mind';
  S.mindFilter = filter;
  $qa('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'mind'));
  $qa('.page').forEach(p => p.classList.remove('active'));
  $id('p-mind').classList.add('active');
  await loadInsights();
  await loadQuestions();
  await loadTimeline();
  await loadBooks();
  const roots = S.insights.filter(i => i.rootId == null).sort((a, b) => b.growthAt - a.growthAt);
  const questions = S.questions.slice().sort((a, b) => b.createdAt - a.createdAt);
  const tabs = [['all', '全部思想'], ...INSIGHT_TYPES.map(t => [t, t]), ['悬念', '悬题'], ['timeline', '时间线']];
  let html = `<div class="h-page">思想</div><div class="h-sub">这些书在我身上留下了什么</div>
    <div class="mind-tabs">${tabs.map(t => `<button data-f="${t[0]}" class="${filter === t[0] ? 'active' : ''}">${t[1]}</button>`).join('')}</div>`;
  if (filter === '悬念') html += renderQuestionList(questions);
  else if (filter === 'timeline') html += renderTimelineList();
  else if (filter === 'all') {
    html += '<div class="section-label">悬 题</div>' + (questions.length ? renderQuestionList(questions.slice(0, 3)) : '<div class="empty">还没有悬题</div>');
    html += '<div class="section-label">思 想</div>' + (roots.length ? renderInsightList(roots) : '<div class="empty">阅读时记下的理解会在这里慢慢长出来</div>');
  } else {
    const filtered = roots.filter(i => i.type === filter);
    html += filtered.length ? renderInsightList(filtered) : '<div class="empty">还没有这类型的沉淀</div>';
  }
  $id('mindBody').innerHTML = html;
  bindMindEvents(filter);
}
function renderInsightList(list) {
  return list.map(i => {
    const book = S.books.find(b => b.id === i.bookId);
    const growth = S.insights.filter(g => g.rootId === i.id).sort((a, b) => a.createdAt - b.createdAt);
    return `<div class="thought-item card" data-iid="${i.id}">
      <div class="tt">${esc(i.type)}${growth.length ? ' · ' + growth.length + ' 次生长' : ''}</div>
      <div class="bd">${esc(i.text)}</div>
      ${growth.length ? '<div class="growth">' + growth.slice(-3).map(g => `<div class="g-row">· ${esc(g.text.slice(0, 60))}${g.text.length > 60 ? '…' : ''}</div>`).join('') + '</div>' : ''}
      <div class="origin">${book ? '📖 ' + esc(book.title) : ''}${i.quote ? ' · 「' + esc(i.quote.slice(0, 14)) + '…」' : ''} · ${timeAgo(i.createdAt)}</div>
    </div>`;
  }).join('');
}
function renderQuestionList(list) {
  return list.map(q => {
    const origins = [];
    if (q.bookId) { const book = S.books.find(b => b.id === q.bookId); if (book) origins.push(book.title); }
    return `<div class="q-item card" data-qid="${q.id}">
      <div class="bd">${esc(q.text)}</div>
      ${q.answerText ? `<div class="ans">回应：${esc(q.answerText.slice(0, 80))}${q.answerText.length > 80 ? '…' : ''}</div>` : ''}
      <div class="mt">${q.status === 'answered' ? '已回应' : '悬着'} · ${origins.join(' / ') || '无出处'} · ${timeAgo(q.createdAt)}</div>
    </div>`;
  }).join('');
}
function renderTimelineList() {
  const grouped = {};
  S.timeline.slice().sort((a, b) => b.ts - a.ts).forEach(t => {
    const day = new Date(t.ts).toDateString();
    (grouped[day] = grouped[day] || []).push(t);
  });
  let html = '';
  for (const day of Object.keys(grouped)) {
    const date = new Date(day);
    html += `<div class="tl-day">${date.getMonth() + 1}月${date.getDate()}日</div>`;
    for (const t of grouped[day]) {
      const book = S.books.find(b => b.id === t.bookId);
      html += `<div class="tl-item card"><div class="t">${esc(t.kind)} · ${esc(t.text.slice(0, 60))}${t.text.length > 60 ? '…' : ''}</div><div class="src">${book ? esc(book.title) : ''}</div></div>`;
    }
  }
  return html || '<div class="empty">阅读轨迹会随时间线慢慢变长</div>';
}
function bindMindEvents(filter) {
  $qa('#mindBody .mind-tabs button').forEach(b => b.addEventListener('click', () => renderMind(b.dataset.f)));
  $qa('#mindBody .thought-item').forEach(el => el.addEventListener('click', () => openInsightDetail(el.dataset.iid)));
  $qa('#mindBody .q-item').forEach(el => el.addEventListener('click', () => openQuestionDetail(el.dataset.qid)));
}
async function openInsightDetail(id) {
  const root = S.insights.find(i => i.id === id);
  if (!root) return;
  const growth = S.insights.filter(g => g.rootId === id).sort((a, b) => a.createdAt - b.createdAt);
  const book = S.books.find(b => b.id === root.bookId);
  const chTitle = book && book.chapterMeta ? (book.chapterMeta.find(c => c.cid === root.chapterId) || {}).title : null;
  openSheet({
    title: root.type,
    html: `
      <div style="font-size:14px;line-height:1.8;margin-bottom:12px;">${esc(root.text)}</div>
      ${growth.length ? '<div class="section-label">成长轨迹</div>' + growth.map(g => `
        <div style="padding:10px 0;border-top:1px dashed var(--line);">
          <div style="font-size:13px;line-height:1.7;">${esc(g.text)}</div>
          <div style="font-size:11px;color:var(--ink-3);margin-top:4px;">${timeAgo(g.createdAt)}</div>
        </div>`).join('') : ''}
      <div class="section-label">来自</div>
      <div style="font-size:13px;color:var(--ink-2);line-height:1.7;">${book ? '📖 ' + esc(book.title) + (chTitle ? ' · ' + esc(chTitle) : '') : '（无出处）'}
      ${root.quote ? '<br>「' + esc(root.quote.slice(0, 80)) + '…」' : ''}</div>
      ${book ? `<div class="btn-row"><button class="btn-p" id="jumpOrigin">回到那里继续读</button></div>` : ''}
      <div class="btn-row"><button class="btn-c" id="delInsight" style="color:var(--danger);">删除这条思想</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#jumpOrigin')?.addEventListener('click', () => {
        closeTopSheet();
        openReader(book.id, root.chapterId, Math.max(0, root.paraNum - chapterParaStart(book, root.chapterId)));
      });
      rootEl.querySelector('#delInsight')?.addEventListener('click', async () => {
        closeTopSheet();
        for (const g of growth) await removeById('insights', g.id);
        await removeById('insights', id);
        S.insights = await listData('insights');
        toast('已删除');
        renderMind();
      });
    },
  });
}
async function openQuestionDetail(id) {
  const q = S.questions.find(x => x.id === id);
  if (!q) return;
  const book = S.books.find(b => b.id === q.bookId);
  const chTitle = book && book.chapterMeta ? (book.chapterMeta.find(c => c.cid === q.chapterId) || {}).title : null;
  openSheet({
    title: '悬题',
    html: `
      <div style="font-size:14.5px;line-height:1.8;margin-bottom:14px;">${esc(q.text)}</div>
      ${q.answerText ? `<div class="ans" style="margin-bottom:10px;">回应：${esc(q.answerText)}</div>` : ''}
      <div class="section-label">来自</div>
      <div style="font-size:13px;color:var(--ink-2);line-height:1.7;margin-bottom:8px;">${book ? '📖 ' + esc(book.title) + (chTitle ? ' · ' + esc(chTitle) : '') : '（无出处）'}
      ${q.quote ? '<br>「' + esc(q.quote.slice(0, 80)) + '…」' : ''}</div>
      ${book ? `<div class="btn-row"><button class="btn-c" id="jumpOrigin">回到那里再读</button></div>` : ''}
      <div class="btn-row"><button class="btn-p" id="answerQ">${q.answerText ? '更新回应' : '写下回应'}</button></div>
      <div class="btn-row"><button class="btn-c" id="delQ" style="color:var(--danger);">删除</button></div>`,
    onOpen: (rootEl) => {
      rootEl.querySelector('#jumpOrigin')?.addEventListener('click', () => {
        closeTopSheet();
        openReader(book.id, q.chapterId, Math.max(0, q.paraNum - chapterParaStart(book, q.chapterId)));
      });
      rootEl.querySelector('#answerQ')?.addEventListener('click', () => { closeTopSheet(); openAnswerSheet(q); });
      rootEl.querySelector('#delQ')?.addEventListener('click', async () => {
        closeTopSheet();
        await removeById('questions', id);
        S.questions = await listData('questions');
        toast('已删除');
        renderMind();
      });
    },
  });
}

/* ───────── 桌面 ───────── */
async function renderDesk() {
  S.tab = 'desk';
  $qa('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'desk'));
  $qa('.page').forEach(p => p.classList.remove('active'));
  $id('p-desk').classList.add('active');
  await loadBooks();
  await loadInsights();
  await loadQuestions();
  await loadTimeline();
  const reading = S.books.filter(b => b.lastReadAt).sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, 3);
  const latest = [...S.timeline].sort((a, b) => b.ts - a.ts)[0];
  let html = `<div class="h-page">书桌</div>
    <div class="h-sub">${new Date().toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })}</div>`;
  html += '<div class="section-label">正 在 读</div>';
  if (reading.length) {
    html += reading.map(b => {
      const idx = (b.chapterMeta || []).findIndex(c => c.cid === b.currentChapterId);
      const chTitle = idx >= 0 ? b.chapterMeta[idx].title : '';
      return `<div class="now-card card" data-bid="${b.id}">
        <div class="cover" style="background:${esc(b.coverColor || '#6f5d48')};">${esc((b.title || '书')[0])}</div>
        <div class="info"><div class="t">${esc(b.title)}</div>
        <div class="m">${chTitle ? esc(chTitle) : ''} · 上次 ${timeAgo(b.lastReadAt)}</div></div>
        <div class="go">›</div>
      </div>`;
    }).join('');
  } else html += '<div class="empty">还没有在读的书<br>去书库导入一本吧</div>';
  html += '<div class="section-label">最 近 留 下 的</div>';
  if (latest) {
    const book = S.books.find(b => b.id === latest.bookId);
    html += `<div class="pulse-strip"><div class="tt">${esc(latest.kind)}</div><div class="bd">${esc(latest.text.slice(0, 60))}${latest.text.length > 60 ? '…' : ''}</div><div class="mt">${book ? esc(book.title) + ' · ' : ''}${timeAgo(latest.ts)}</div></div>`;
  } else html += '<div class="empty">还没有什么留下来<br>读着读着，会有的</div>';
  $id('deskBody').innerHTML = html;
  $qa('#deskBody .now-card').forEach(c => c.addEventListener('click', () => openReader(c.dataset.bid)));
}

/* ───────── 书库 ───────── */
async function renderLib(groupId) {
  S.tab = 'lib';
  if (groupId !== undefined) S.currentGroup = groupId;
  $qa('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'lib'));
  $qa('.page').forEach(p => p.classList.remove('active'));
  $id('p-lib').classList.add('active');
  await loadBooks();
  await loadGroups();
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
      return `<div class="book-card card" data-bid="${b.id}">
        <div class="cover" style="background:${esc(b.coverColor || '#6f5d48')};">${esc((b.title || '书')[0])}</div>
        <div class="info"><div class="t">${esc(b.title)}</div>
        <div class="m">${esc(b.author || '')}${b.format === 'epub' ? ' · epub' : ''}</div>
        <div class="p"><i style="width:${pct}%"></i></div></div>
        <button class="more" data-bid="${b.id}">⋯</button>
      </div>`;
    }).join('');
    html += `<button class="add-book-btn" id="addBookBtn">＋ 导入书籍</button>`;
  } else html += `<div class="empty">${cur === 'all' ? '书库还空着' : '这个书单还没有书'}</div><button class="add-book-btn" id="addBookBtn">＋ 导入书籍</button>`;
  $id('libBody').innerHTML = html;
  $id('libBody').addEventListener('click', (e) => {
    const moreBtn = e.target.closest('.more');
    if (moreBtn) { e.stopPropagation(); openBookMenu(moreBtn.dataset.bid); return; }
    const card = e.target.closest('.book-card');
    if (card) { openReader(card.dataset.bid); }
  });
  const ab = $id('addBookBtn');
  if (ab) ab.addEventListener('click', openImportSheet);
  const agb = $id('addGroupBtn');
  if (agb) agb.addEventListener('click', openGroupEditor);
  $qa('#libBody .shelf-tab[data-g]').forEach(t => t.addEventListener('click', () => renderLib(t.dataset.g)));
}
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
      root.querySelector('#bmDelete').addEventListener('click', async () => { closeTopSheet(); await deleteBook(bookId); toast('已删除'); renderLib(); });
    },
  });
}
async function deleteBook(bookId) {
  await removeById('books', bookId);
  const chaps = await listCol('chapters');
  for (const c of chaps) { if (c.data && c.data.bookId === bookId) await A.db.delete('chapters', c.id); }
  for (const col of ['traces', 'sessions', 'insights', 'questions']) {
    for (const r of await listCol(col)) { if (r.data && r.data.bookId === bookId) await A.db.delete(col, r.id); }
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
    html: S.groups.map(g => `<div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--line-soft);"><span style="flex:1;font-size:14px;">${esc(g.name)}（${(g.bookIds || []).length} 本）</span><button class="btn-c" data-delg="${esc(g.id)}" style="padding:6px 12px;border:none;border-radius:9px;font-size:12px;">删除</button></div>`).join('') + `
      <div style="display:flex;gap:8px;margin-top:12px;"><input id="newGName" placeholder="新书单名称" style="flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#f9f6f1;font-size:14px;outline:none;"><button class="btn-p" id="addG" style="border:none;border-radius:10px;padding:0 16px;">添加</button></div>`,
    onOpen: (root) => {
      root.querySelectorAll('[data-delg]').forEach(b => b.addEventListener('click', async () => { closeTopSheet(); await removeById('groups', b.dataset.delg); S.groups = await listData('groups'); renderLib(); }));
      root.querySelector('#addG').addEventListener('click', async () => {
        const name = root.querySelector('#newGName').value.trim();
        if (!name) return;
        await upsert('groups', { id: 'g_' + uid(), name, bookIds: [] });
        S.groups = await listData('groups'); closeTopSheet(); renderLib();
      });
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

/* ───────── 书籍详情 ───────── */
async function openBookDetail(bookId) {
  const book = S.books.find(b => b.id === bookId);
  if (!book) return;
  const insights = S.insights.filter(i => i.bookId === bookId && i.rootId == null);
  const questions = S.questions.filter(q => q.bookId === bookId);
  const coCount = (await listCol('sessions')).map(r => r.data).filter(s => s.bookId === bookId).length;
  const pct = totalParas(book) ? Math.round((book.currentParaNum / totalParas(book)) * 100) : 0;
  const idx = (book.chapterMeta || []).findIndex(c => c.cid === book.currentChapterId);
  const chTitle = idx >= 0 ? book.chapterMeta[idx].title : '';
  openSheet({
    title: book.title,
    html: `<div style="text-align:center;font-size:12.5px;color:var(--ink-3);margin-bottom:10px;">${esc(chTitle || '未开始')} · 上次阅读 ${book.lastReadAt ? timeAgo(book.lastReadAt) : '—'}</div>
      <div class="stat-grid"><div class="st"><b>${pct}%</b><span>已读</span></div><div class="st"><b>${coCount}</b><span>共读</span></div><div class="st"><b>${insights.length}</b><span>理解</span></div><div class="st"><b>${questions.length}</b><span>悬题</span></div></div>
      ${insights.length ? '<div class="section-label">最近理解</div>' + insights.slice(0, 3).map(i => `<div style="font-size:13.5px;line-height:1.7;padding:8px 0;border-bottom:1px solid var(--line-soft);">${esc(i.text.slice(0, 50))}</div>`).join('') : ''}
      ${questions.length ? '<div class="section-label">悬题</div>' + questions.slice(0, 3).map(q => `<div style="font-size:13.5px;line-height:1.7;padding:8px 0;border-bottom:1px solid var(--line-soft);">${esc(q.text.slice(0, 50))}</div>`).join('') : ''}
      <div class="btn-row"><button class="btn-p" id="bdContinue">继续阅读</button></div>
      <div class="btn-row"><button class="btn-c" id="bdIdeas">我的理解</button><button class="btn-c" id="bdQs">悬题</button></div>
      <div class="btn-row"><button class="btn-c" id="bdClose">关闭</button></div>`,
    onOpen: (root) => {
      root.querySelector('#bdContinue').addEventListener('click', () => { closeTopSheet(); openReader(bookId); });
      root.querySelector('#bdIdeas').addEventListener('click', () => { closeTopSheet(); switchTab('mind'); });
      root.querySelector('#bdQs').addEventListener('click', () => { closeTopSheet(); switchTab('mind'); renderMind('悬念'); });
      root.querySelector('#bdClose').addEventListener('click', closeTopSheet);
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

/* ───────── 导航 ───────── */
function switchTab(tab) {
  S.tab = tab;
  if (tab === 'desk') renderDesk();
  else if (tab === 'lib') renderLib();
  else renderMind(S.mindFilter || 'all');
}
$qa('.tabbar button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ───────── 初始化 ───────── */
async function init() {
  if (!A) { $id('deskBody').innerHTML = '<div style="text-align:center;padding:60px;color:#aaa;">请在 AI 小手机内打开</div>'; return; }
  buildSelBar();
  await migrateIfNeeded();
  await loadBooks();
  await loadGroups();
  await loadInsights();
  await loadQuestions();
  await loadTimeline();
  try {
    const st = (await listData('state')).find(s => s.id === 'reading');
    if (st && st.bookId) {
      const book = S.books.find(b => b.id === st.bookId);
      if (book) { await openReader(st.bookId, st.chapterId, st.paraNum); return; }
    }
  } catch (e) {}
  renderDesk();
}
window.addEventListener('pagehide', () => { saveProgress().catch(() => {}); });
init();