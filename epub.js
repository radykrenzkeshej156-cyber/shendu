/* 深读 · epub.js —— 浏览器内 EPUB 解析（零依赖，5.7.4 保守重构）
   改动最小化：删掉两个最有问题的启发式（截断标题 + 合并短章），保留树结构
*/

const EpubParser = (() => {
  const te = new TextDecoder('utf-8');

  async function openZip(file) {
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    const min = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= min; i--) {
      if (u8[i] === 0x50 && u8[i+1] === 0x4b && u8[i+2] === 0x05 && u8[i+3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB（zip 结构损坏）');
    const view = new DataView(buf);
    const cdCount = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (cdOffset === 0xFFFFFFFF) throw new Error('不支持 Zip64 格式的 EPUB');
    const index = {};
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = te.decode(u8.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      index[name] = { start: dataStart, csize, method };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { u8, index };
  }

  async function readEntry(z, path) {
    const e = z.index[path];
    if (!e) throw new Error('not found: ' + path);
    const raw = z.u8.subarray(e.start, e.start + e.csize);
    if (e.method === 0) return te.decode(raw);
    if (e.method === 8) {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        const out = await new Response(stream).arrayBuffer();
        return te.decode(new Uint8Array(out));
      } catch (err) { throw new Error('浏览器不支持 EPUB 解压'); }
    }
    throw new Error('不支持的压缩方式');
  }

  async function readEntryBlob(z, path) {
    const e = z.index[path];
    if (!e) throw new Error('not found: ' + path);
    const raw = z.u8.subarray(e.start, e.start + e.csize);
    if (e.method === 0) return new Blob([raw]);
    if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      return await new Response(stream).blob();
    }
    throw new Error('不支持的压缩方式');
  }

  const textDoc = (s, mime) => new DOMParser().parseFromString(s, mime);

  async function readMeta(z) {
    let container;
    try { container = await readEntry(z, 'META-INF/container.xml'); }
    catch (e) { throw new Error('不是有效的 EPUB（缺少 container.xml）'); }
    const doc = textDoc(container, 'application/xml');
    const rf = doc.querySelector('rootfile');
    const opfPath = rf && rf.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB 缺少 OPF 文件声明');
    return opfPath;
  }

  function resolve(base, href) {
    const parts = base.split('/').slice(0, -1).concat(href.split('/'));
    const out = [];
    for (const seg of parts) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    let s = out.join('/');
    try { s = decodeURIComponent(s); } catch (e) {}
    return s;
  }

  /* 5.7.4：简化的标题拼接 — 只做必要的去重，删掉截断逻辑 */
  function formatTitleChain(chain) {
    const uniq = [];
    for (const s of chain) {
      const last = uniq[uniq.length - 1];
      // 避免「第一卷 · 第一卷」这种重复，但保留副标题
      if (last && (s === last || (last.includes(s) && s.length > 2) || (s.includes(last) && last.length > 2))) continue;
      uniq.push(s);
    }
    return uniq.join(' · ');
  }

  async function readNavEntries(z, manifest, manifestProps, opfPath) {
    let best = [];
    const out = [];
    const push = (navPath, hrefRaw, label, parents) => {
      if (!hrefRaw || !label) return;
      const hashAt = String(hrefRaw).indexOf('#');
      const filePart = hashAt >= 0 ? hrefRaw.slice(0, hashAt) : String(hrefRaw);
      const fragPart = hashAt >= 0 ? hrefRaw.slice(hashAt + 1) : '';
      if (!filePart) return;
      const path = resolve(navPath, filePart);
      let fragment = fragPart;
      try { fragment = decodeURIComponent(fragPart); } catch (e) {}
      if (out.some(e => e.path === path && e.fragment === fragment)) return;
      // 5.7.4：保留完整链，删掉 joinTitle 的截断
      out.push({ path, fragment, label, parents: parents || [], depth: (parents || []).length });
    };
    const localName = (n) => String(n.localName || n.tagName || '').toLowerCase();
    const childEl = (node, name) => Array.from(node.children || []).find(c => localName(c) === name) || null;
    const childText = (node, name) => {
      const el = childEl(node, name);
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    };
    
    const cands = [];
    for (const id of Object.keys(manifest)) {
      const href = manifest[id];
      const p = (manifestProps && manifestProps[id]) || {};
      const declaredNav = /\bnav\b/.test(p.props || '');
      const declaredNcx = /ncx/.test(p.mime || '') || /\.ncx$/i.test(href);
      const byName = /(toc|nav|ncx|contents)/i.test(href) && /\.(ncx|x?html?|xhtm)$/i.test(href);
      if (declaredNav || declaredNcx || byName) cands.push({ href, isNcx: declaredNcx || /\.ncx$/i.test(href) });
    }
    
    for (const cand of cands) {
      const href = cand.href;
      const navPath = resolve(opfPath, href);
      let content = '';
      try { content = await readEntry(z, navPath); } catch (e) { continue; }
      if (cand.isNcx) {
        const doc = textDoc(content, 'application/xml');
        const walkNP = (np, parents) => {
          const navLabel = childEl(np, 'navlabel');
          const label = navLabel ? childText(navLabel, 'text') : childText(np, 'text');
          const cEl = childEl(np, 'content');
          const src = cEl ? (cEl.getAttribute('src') || '') : '';
          if (label && src) push(navPath, src, label, parents);
          for (const kid of Array.from(np.childNodes)) {
            if (kid.nodeType === 1 && localName(kid) === 'navpoint') walkNP(kid, label ? parents.concat(label) : parents);
          }
        };
        doc.querySelectorAll('navPoint').forEach(np => {
          let p = np.parentNode, nested = false;
          while (p && p.nodeType === 1) { if (localName(p) === 'navpoint') { nested = true; break; } p = p.parentNode; }
          if (!nested) walkNP(np, []);
        });
      } else {
        const doc = textDoc(content, 'text/html');
        const walkOl = (ol, parents) => {
          for (const li of Array.from(ol.children)) {
            if (localName(li) !== 'li') continue;
            const kids = Array.from(li.children);
            const a = kids.find(n => localName(n) === 'a' || localName(n) === 'span');
            const label = a ? (a.textContent || '').trim().replace(/\s+/g, ' ') : '';
            const hrefRaw = a ? (a.getAttribute('href') || '') : '';
            const sub = kids.find(n => localName(n) === 'ol');
            if (label && hrefRaw) push(navPath, hrefRaw, label, parents);
            if (sub) walkOl(sub, label ? parents.concat(label) : parents);
          }
        };
        const navs = Array.from(doc.querySelectorAll('nav'));
        const navRoot = navs.find(n => /(^|\s)toc(\s|$)/.test(n.getAttribute('epub:type') || n.getAttribute('type') || ''))
          || navs.find(n => n.querySelector('ol'))
          || doc.body;
        if (navRoot) navRoot.querySelectorAll('ol').forEach(ol => {
          let p = ol.parentNode, nested = false;
          while (p && p.nodeType === 1) { if (localName(p) === 'ol') { nested = true; break; } p = p.parentNode; }
          if (!nested) walkOl(ol, []);
        });
      }
      if (out.length > best.length) best = out.slice();
      out.length = 0;
    }
    return best;
  }

  /* 5.7.4：极简版章节切割 — 只按文件 + 锚点粗切，删掉启发式合并 */
  function splitByNavEntries(html, entries) {
    const doc = textDoc(cleanHTML(html), 'text/html');
    doc.querySelectorAll('img, svg, video, audio, canvas, iframe').forEach(n => n.remove());
    const root = doc.body || doc.documentElement;
    if (!root) return [];
    const list = entries || [];
    
    // 简化：只按锚点位置建立标记，不做内容启发式处理
    const marks = [];
    for (const e of list) {
      if (!e.fragment) continue;
      let el = null;
      try { el = doc.getElementById(e.fragment); } catch (err) { el = null; }
      if (!el) {
        for (const c of Array.from(root.querySelectorAll('[id], a[name]'))) {
          if (c.getAttribute('id') === e.fragment || c.getAttribute('name') === e.fragment) { el = c; break; }
        }
      }
      if (el && root.contains(el)) marks.push({ el, entry: e });
    }
    
    if (!marks.length) {
      const text = xhtmlToText(html);
      const t = list.length ? (list[0].label) : '';
      return text.trim() ? [{ title: t, text }] : [];
    }
    
    // 按文档顺序排序
    marks.sort((a, b) => {
      const p = a.el.compareDocumentPosition(b.el);
      if (p & 4) return -1;
      if (p & 2) return 1;
      return 0;
    });
    
    const markIdx = new Map();
    marks.forEach((m, i) => markIdx.set(m.el, i));
    const buckets = marks.map(() => []);
    const front = [];
    let idx = -1;
    const pushLine = (s) => { (idx >= 0 ? buckets[idx] : front).push(s); };
    
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = child.textContent.replace(/\s+/g, ' ').replace(/ *\n+ */g, ' ').trim();
          if (!t) continue;
          pushLine(t);
        } else if (child.nodeType === 1) {
          const mi = markIdx.get(child);
          if (mi !== undefined) idx = mi;
          const tag = child.localName ? String(child.localName).toLowerCase() : String(child.tagName || '').toLowerCase();
          if (tag === 'br') { pushLine(''); continue; }
          const isBlock = ['div','p','li','h1','h2','h3','h4','h5','h6','blockquote','section','article','tr','table','ul','ol','header','footer','nav','hr'].includes(tag);
          if (isBlock && (child.textContent || '').trim()) pushLine('');
          walk(child);
          if (isBlock) pushLine('');
        }
      }
    };
    walk(root);
    
    // 5.7.4：不再做启发式「短章并进」，直接按锚点切
    const out = [];
    const frontText = linesToText(front);
    
    marks.forEach((m, i) => {
      let text = linesToText(buckets[i]);
      if (!text.trim()) return;
      out.push({ 
        title: formatTitleChain([...(m.entry.parents || []), m.entry.label]),
        text 
      });
    });
    
    if (!out.length) {
      const text = xhtmlToText(html);
      return text.trim() ? [{ title: list.length ? list[0].label : '', text }] : [];
    }
    
    // 前置长的引言（但不启发式判断短小）
    if (frontText && frontText.length > 200) {
      out.unshift({ title: list.length ? list[0].label : '', text: frontText });
    }
    
    return out;
  }

  function linesToText(lines) {
    const out = [];
    let current = '';
    for (const raw of lines) {
      if (raw === '') { if (current) { out.push(current); current = ''; } continue; }
      if (current === '') { current = raw; continue; }
      if (/[。！？!?；;：:…。」』""]$/.test(current)) out.push(current), current = raw;
      else current += raw;
    }
    if (current) out.push(current);
    return out.map(s => s.trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function cleanHTML(html) {
    return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  function xhtmlToText(html) {
    const doc = textDoc(cleanHTML(html), 'text/html');
    doc.querySelectorAll('img, svg, video, audio, canvas, iframe').forEach(n => n.remove());
    const lines = [];
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = child.textContent.replace(/\s+/g, ' ').replace(/ *\n+ */g, ' ').trim();
          if (!t) continue;
          lines.push(t);
        } else if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (tag === 'br') { lines.push(''); continue; }
          const isBlock = ['div','p','li','h1','h2','h3','h4','h5','h6','blockquote','section','article','tr','table','ul','ol','header','footer','nav','hr'].includes(tag);
          if (isBlock && (child.textContent || '').trim()) lines.push('');
          walk(child);
          if (isBlock) lines.push('');
        }
      }
    };
    walk(doc.body || doc.documentElement);
    return linesToText(lines);
  }

  async function parse(file) {
    const z = await openZip(file);
    const opfPath = await readMeta(z);
    const opf = textDoc(await readEntry(z, opfPath), 'application/xml');
    const title = (opf.querySelector('metadata > title')?.textContent || '').trim();
    const author = (opf.querySelector('metadata > creator')?.textContent || '').trim();
    
    const manifest = {};
    const manifestProps = {};
    opf.querySelectorAll('manifest > item').forEach(it => {
      const id = it.getAttribute('id'), href = it.getAttribute('href');
      if (id && href) {
        manifest[id] = href;
        manifestProps[id] = {
          props: (it.getAttribute('properties') || '').toLowerCase(),
          mime: (it.getAttribute('media-type') || '').toLowerCase(),
        };
      }
    });
    
    const spine = [];
    opf.querySelectorAll('spine > itemref').forEach(r => {
      const id = r.getAttribute('idref');
      if (id && manifest[id]) spine.push(manifest[id]);
    });
    
    const navEntries = await readNavEntries(z, manifest, manifestProps, opfPath);
    
    let coverDataUrl = '';
    const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
    const coverHref = (coverId && manifest[coverId]) || opf.querySelector('manifest > item[properties~="cover-image"]')?.getAttribute('href');
    if (coverHref) {
      try {
        const blob = await readEntryBlob(z, resolve(opfPath, coverHref));
        if (blob.size <= 400 * 1024 && blob.type.startsWith('image/')) {
          coverDataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => res(''); r.readAsDataURL(blob); });
        }
      } catch (e) {}
    }
    
    const chapters = [];
    for (const href of spine) {
      const path = resolve(opfPath, href);
      let html = '';
      try { html = await readEntry(z, path); } catch (e) { continue; }
      
      // 5.7.4：按本文件对应的目录条目切分
      const fileEntries = navEntries.filter(e => e.path === path);
      const pieces = splitByNavEntries(html, fileEntries);
      
      for (const pc of pieces) {
        if (!pc.text || !pc.text.trim()) continue;
        chapters.push({ title: pc.title || ('第 ' + (chapters.length + 1) + ' 节'), text: pc.text });
        if (chapters.length >= 4000) break;
      }
      if (chapters.length >= 4000) break;
    }
    
    if (!chapters.length) throw new Error('没有解析出正文');
    return { title, author, coverDataUrl, chapters };
  }

  return { parse, supported: () => typeof DecompressionStream !== 'undefined' };
})();
