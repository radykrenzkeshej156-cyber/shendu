/* 深读 · epub.js —— 浏览器内 EPUB 解析（零依赖）
   思路：EPUB 是 zip。手写一个极小的 zip 读取器：
   从文件末尾找 EOCD → 遍历 Central Directory 建立文件索引 →
   按需解压（原生 DecompressionStream，deflate-raw / stored）。
   输出 { title, author, coverDataUrl, chapters:[{title, text}] } */

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
    let cdOffset = view.getUint32(eocd + 16, true);
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

  async function parse(file) {
    const z = await openZip(file);
    const opfPath = await readMeta(z);
    const opf = textDoc(await readEntry(z, opfPath), 'application/xml');
    const title = (opf.querySelector('metadata > title')?.textContent || '').trim();
    const author = (opf.querySelector('metadata > creator')?.textContent || '').trim();
    const manifest = {};
    opf.querySelectorAll('manifest > item').forEach(it => {
      const id = it.getAttribute('id'), href = it.getAttribute('href');
      if (id && href) manifest[id] = href;
    });
    const spine = [];
    opf.querySelectorAll('spine > itemref').forEach(r => {
      const id = r.getAttribute('idref');
      if (id && manifest[id]) spine.push(manifest[id]);
    });
    const navTitles = await readNavTitles(z, manifest, opfPath);
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
      const text = xhtmlToText(html);
      if (!text.trim()) continue;
      chapters.push({ title: navTitles[href] || navTitles[path] || ('第 ' + (chapters.length + 1) + ' 节'), text });
      if (chapters.length >= 4000) break;
    }
    if (!chapters.length) throw new Error('没有解析出正文');
    return { title, author, coverDataUrl, chapters };
  }

  async function readNavTitles(z, manifest, opfPath) {
    const titles = {};
    for (const href of Object.values(manifest)) {
      if (!/toc|nav|ncx/i.test(href) || !/\.(ncx|html|xhtml|xhtm)$/i.test(href)) continue;
      const path = resolve(opfPath, href);
      let content = '';
      try { content = await readEntry(z, path); } catch (e) { continue; }
      if (href.toLowerCase().endsWith('.ncx')) {
        const doc = textDoc(content, 'application/xml');
        doc.querySelectorAll('navPoint').forEach(np => {
          const src = (np.querySelector('content')?.getAttribute('src') || '').replace(/#.*$/, '');
          const label = (np.querySelector('text')?.textContent || '').trim();
          if (src && label) titles[resolve(opfPath, src)] = label;
        });
      } else {
        const doc = textDoc(content, 'text/html');
        doc.querySelectorAll('a, nav a').forEach(a => {
          const hrefRaw = a.getAttribute('href') || '';
          if (!hrefRaw) return;
          const src = resolve(opfPath, hrefRaw.replace(/#.*$/, ''));
          const label = a.textContent.trim().replace(/\s+/g, ' ');
          if (src && label && !titles[src]) titles[src] = label;
        });
      }
    }
    return titles;
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
    const out = [];
    let current = '';
    for (const raw of lines) {
      if (raw === '') { if (current) { out.push(current); current = ''; } continue; }
      if (current === '') { current = raw; continue; }
      if (/[。！？!?；;：:…。」』””]$/.test(current)) out.push(current), current = raw;
      else current += raw;
    }
    if (current) out.push(current);
    return out.map(s => s.trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
  }

  return { parse, supported: () => typeof DecompressionStream !== 'undefined' };
})();