/* 深读 · epub.js —— 浏览器内 EPUB 解析（零依赖，5.7.4 重构版）
   架构：ZIP 读取 → OPF 解析 → 完整目录树 + 线性块流 → 按锚点切割章节
   
   核心数据结构（替代旧的四套启发式）：
   NavNode    目录树节点，保留完整层级关系，不拍平
   Block      全书线性块流，每块一个段落级文本单元 + 该块内的所有锚点
   Cut        目录条目在块流上的切点位置
   Chapter    最终输出，包含 labelChain 完整层级和正文范围
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

  /* 5.7.4：新数据结构 — 目录树节点（保留完整层级，不拍平）*/
  function NavNode(label, href, fragment) {
    this.label = label;
    this.href = href;       // OPF 相对路径（用 resolve 转成 path）
    this.fragment = fragment;  // 锚点（可空）
    this.children = [];
    this.playOrder = 0;
  }

  /* 5.7.4：快速查证「根节点是否是包裹层」
     标志：①根只有一个子 ②根的 label 与书名相同或互为前缀 ③根的 label 属于包裹名单
  */
  function shouldUnwrapRoot(root, bookTitle) {
    if (!root || root.children.length !== 1) return false;
    const rootLabel = (root.label || '').trim().toLowerCase();
    const title = (bookTitle || '').trim().toLowerCase();
    if (rootLabel === title || title.indexOf(rootLabel) === 0 || rootLabel.indexOf(title) === 0) return true;
    const wrapperNames = ['封面', '正文', '目录', '内容', '前言', '序言', '导读'];
    return wrapperNames.includes(root.label);
  }

  /* 5.7.4：从 NCX 构建目录树（保留完整层级）*/
  async function readNcxNav(z, navPath, opfPath) {
    let content;
    try { content = await readEntry(z, navPath); }
    catch (e) { return null; }
    
    const doc = textDoc(content, 'application/xml');
    const root = new NavNode('');
    const localName = (n) => String(n.localName || n.tagName || '').toLowerCase();
    
    const walkNP = (np, parentNode) => {
      const navLabel = Array.from(np.childNodes).find(c => localName(c) === 'navlabel');
      const label = navLabel ? navLabel.textContent.trim().replace(/\s+/g, ' ') : np.textContent.trim();
      const cEl = Array.from(np.childNodes).find(c => localName(c) === 'content');
      const src = cEl ? (cEl.getAttribute('src') || '') : '';
      
      if (label && src) {
        const navNode = new NavNode(label, src, '');
        const hashAt = src.indexOf('#');
        if (hashAt >= 0) {
          navNode.href = src.slice(0, hashAt);
          navNode.fragment = src.slice(hashAt + 1);
        }
        parentNode.children.push(navNode);
        
        // 递归子 navPoint
        for (const kid of Array.from(np.childNodes)) {
          if (kid.nodeType === 1 && localName(kid) === 'navpoint') {
            walkNP(kid, navNode);
          }
        }
      }
    };
    
    // 只从最外层 navPoint 起递归
    for (const np of doc.querySelectorAll('navPoint')) {
      let p = np.parentNode, nested = false;
      while (p && p.nodeType === 1) {
        if (localName(p) === 'navpoint') { nested = true; break; }
        p = p.parentNode;
      }
      if (!nested) walkNP(np, root);
    }
    
    return root;
  }

  /* 5.7.4：从 EPUB3 nav 构建目录树（保留完整层级）*/
  async function readEpub3Nav(z, navPath, opfPath) {
    let content;
    try { content = await readEntry(z, navPath); }
    catch (e) { return null; }
    
    const doc = textDoc(content, 'text/html');
    const root = new NavNode('');
    const localName = (n) => String(n.localName || n.tagName || '').toLowerCase();
    
    const walkOl = (ol, parentNode) => {
      for (const li of ol.children) {
        if (localName(li) !== 'li') continue;
        const kids = Array.from(li.children);
        const a = kids.find(n => localName(n) === 'a' || localName(n) === 'span');
        const label = a ? (a.textContent || '').trim().replace(/\s+/g, ' ') : '';
        const hrefRaw = a ? (a.getAttribute('href') || '') : '';
        const sub = kids.find(n => localName(n) === 'ol');
        
        if (label && hrefRaw) {
          const navNode = new NavNode(label, hrefRaw, '');
          const hashAt = hrefRaw.indexOf('#');
          if (hashAt >= 0) {
            navNode.href = hrefRaw.slice(0, hashAt);
            navNode.fragment = hrefRaw.slice(hashAt + 1);
          }
          parentNode.children.push(navNode);
        }
        
        if (sub) walkOl(sub, navNode || parentNode);
      }
    };
    
    // 找到 toc 那一份 nav
    const navs = Array.from(doc.querySelectorAll('nav'));
    const navRoot = navs.find(n => /(^|\s)toc(\s|$)/.test(n.getAttribute('epub:type') || n.getAttribute('type') || ''))
      || navs.find(n => n.querySelector('ol'))
      || doc.body;
    
    if (navRoot) {
      for (const ol of navRoot.querySelectorAll('ol')) {
        let p = ol.parentNode, nested = false;
        while (p && p.nodeType === 1) {
          if (localName(p) === 'ol') { nested = true; break; }
          p = p.parentNode;
        }
        if (!nested) walkOl(ol, root);
      }
    }
    
    return root;
  }

  /* 5.7.4：把目录树的相对路径转成 spine 路径，并相对于 opfPath 解析 */
  function resolveNavTree(root, opfPath, navPath) {
    const walk = (node) => {
      if (node.href) {
        const navFileDir = navPath.split('/').slice(0, -1).join('/');
        const relativeTo = navFileDir ? navFileDir + '/' : '';
        node.href = resolve(opfPath, relativeTo + node.href);
      }
      for (const child of node.children) walk(child);
    };
    walk(root);
  }

  /* 5.7.4：线性块流。遍历所有 spine 文档，把每份 xhtml 切成块（段落级文本单元），
     记录每块内的所有锚点（id 与 a[name]），用于后续按锚点切割。
  */
  async function buildBlockStream(z, spine, opfPath) {
    const blocks = [];      // {path, index, text, anchorSet}
    const pathToBlocks = {}; // path → [blockIndex, ...]，用于快速查同一文件内的块
    
    for (const href of spine) {
      const path = resolve(opfPath, href);
      let html = '';
      try { html = await readEntry(z, path); }
      catch (e) { continue; }
      
      const doc = textDoc(cleanHTML(html), 'text/html');
      doc.querySelectorAll('img, svg, video, audio, canvas, iframe, script, style').forEach(n => n.remove());
      const root = doc.body || doc.documentElement;
      if (!root) continue;
      
      // 先收集所有 id/name 锚点
      const anchors = new Map();  // id/name → 元素节点
      for (const el of root.querySelectorAll('[id], a[name]')) {
        const id = el.getAttribute('id') || el.getAttribute('name');
        if (id && !anchors.has(id)) anchors.set(id, el);
      }
      
      // 按块级元素边界切分文本
      pathToBlocks[path] = [];
      const blockIndices = [];
      const walk = (node, depth) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === 3) {
            // 文本节点
            const t = child.textContent.replace(/\s+/g, ' ').trim();
            if (t) {
              const block = {
                path, index: blocks.length,
                text: t,
                anchorSet: new Set(),
                depth
              };
              blocks.push(block);
              blockIndices.push(block.index);
            }
          } else if (child.nodeType === 1) {
            const tag = (child.localName || child.tagName || '').toLowerCase();
            const isBlock = ['div','p','li','h1','h2','h3','h4','h5','h6','blockquote','section','article','tr','table','ul','ol','header','footer','nav'].includes(tag);
            
            // 检查这个元素或其内容是否包含锚点
            if (anchors.has(child.getAttribute('id') || child.getAttribute('name'))) {
              const id = child.getAttribute('id') || child.getAttribute('name');
              const blockIdx = blockIndices[blockIndices.length - 1];
              if (blockIdx !== undefined) {
                blocks[blockIdx].anchorSet.add(id);
              }
            }
            for (const [id, el] of anchors.entries()) {
              if (child.contains(el) && child !== el) {
                const blockIdx = blockIndices[blockIndices.length - 1];
                if (blockIdx !== undefined) {
                  blocks[blockIdx].anchorSet.add(id);
                }
              }
            }
            
            walk(child, isBlock ? depth + 1 : depth);
          }
        }
      };
      walk(root, 0);
      
      pathToBlocks[path] = blockIndices;
    }
    
    return { blocks, pathToBlocks };
  }

  /* 5.7.4：从目录树生成切点（Cut）列表
     规则：按目录树的 DFS 顺序，为每个 NavNode 查找对应的块位置
  */
  function generateCuts(navRoot, blocks, pathToBlocks) {
    const cuts = [];  // {navNode, blockPos, depth}
    const anchorToBlock = new Map();  // fragment → blockIndex
    
    for (const block of blocks) {
      for (const anchor of block.anchorSet) {
        if (!anchorToBlock.has(anchor)) {
          anchorToBlock.set(anchor, block.index);
        }
      }
    }
    
    const walk = (node, depth) => {
      if (node.label) {
        let blockPos = null;
        
        // 优先按锚点查
        if (node.fragment) {
          blockPos = anchorToBlock.get(node.fragment);
        }
        
        // 锚点不中，尝试文件的第一个块
        if (blockPos === undefined && node.href && pathToBlocks[node.href]) {
          const fileBlocks = pathToBlocks[node.href];
          if (fileBlocks.length > 0) blockPos = blocks[fileBlocks[0]].index;
        }
        
        if (blockPos !== undefined) {
          cuts.push({ navNode: node, blockPos, depth });
        }
      }
      
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    
    walk(navRoot, 0);
    cuts.sort((a, b) => a.blockPos - b.blockPos);
    
    return cuts;
  }

  /* 5.7.4：从切点生成最终章节（Chapter）
     规则：Cut[i] 到 Cut[i+1] 之间的块为一个章节
  */
  function buildChapters(cuts, blocks) {
    const chapters = [];
    
    for (let i = 0; i < cuts.length; i++) {
      const startBlock = cuts[i].blockPos;
      const endBlock = (i + 1 < cuts.length) ? cuts[i + 1].blockPos : blocks.length;
      
      if (startBlock < endBlock) {
        const text = blocks.slice(startBlock, endBlock).map(b => b.text).join('\n');
        const chapter = {
          title: cuts[i].navNode.label,
          text: text.trim(),
          depth: cuts[i].depth
        };
        
        if (text.trim()) {
          chapters.push(chapter);
        }
      }
    }
    
    return chapters;
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
      if (/[。！？!?；;：:…。」』""]$/.test(current)) out.push(current), current = raw;
      else current += raw;
    }
    if (current) out.push(current);
    return out.map(s => s.trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
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
    
    /* 5.7.4：新流程 — 读目录树、块流、生切点、输出章节 */
    let navRoot = null;
    
    // 寻找目录文件候选
    const cands = [];
    for (const id of Object.keys(manifest)) {
      const href = manifest[id];
      const p = (manifestProps && manifestProps[id]) || {};
      const declaredNav = /\bnav\b/.test(p.props || '');
      const declaredNcx = /ncx/.test(p.mime || '') || /\.ncx$/i.test(href);
      const byName = /(toc|nav|ncx|contents)/i.test(href) && /\.(ncx|x?html?|xhtm)$/i.test(href);
      if (declaredNav || declaredNcx || byName) {
        cands.push({ href, isNcx: declaredNcx || /\.ncx$/i.test(href) });
      }
    }
    
    for (const cand of cands) {
      const href = cand.href;
      const navPath = resolve(opfPath, href);
      const root = cand.isNcx ? await readNcxNav(z, navPath, opfPath) : await readEpub3Nav(z, navPath, opfPath);
      if (root && root.children.length > 0) {
        resolveNavTree(root, opfPath, navPath);
        navRoot = root;
        break;
      }
    }
    
    // 如果根层是包裹层，自动剥离
    if (navRoot && shouldUnwrapRoot(navRoot, title)) {
      navRoot = navRoot.children[0];
      navRoot.label = navRoot.label || title;
    }
    
    // 构建块流
    const { blocks, pathToBlocks } = await buildBlockStream(z, spine, opfPath);
    
    // 生成切点和章节
    let chapters = [];
    if (navRoot && blocks.length > 0) {
      const cuts = generateCuts(navRoot, blocks, pathToBlocks);
      if (cuts.length > 0) {
        chapters = buildChapters(cuts, blocks);
      }
    }
    
    // 如果没有有效目录，退回到对 spine 文档逐个转换
    if (!chapters.length) {
      for (const href of spine) {
        const path = resolve(opfPath, href);
        let html = '';
        try { html = await readEntry(z, path); }
        catch (e) { continue; }
        const text = xhtmlToText(html);
        if (text.trim()) {
          chapters.push({ title: ('第 ' + (chapters.length + 1) + ' 节'), text });
        }
      }
    }
    
    if (!chapters.length) throw new Error('没有解析出正文');
    
    // 封面处理（保持不变）
    let coverDataUrl = '';
    const coverId = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
    const coverHref = (coverId && manifest[coverId]) || opf.querySelector('manifest > item[properties~="cover-image"]')?.getAttribute('href');
    if (coverHref) {
      try {
        const blob = await readEntryBlob(z, resolve(opfPath, coverHref));
        if (blob.size <= 400 * 1024 && blob.type.startsWith('image/')) {
          coverDataUrl = await new Promise((res) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => res('');
            r.readAsDataURL(blob);
          });
        }
      } catch (e) {}
    }
    
    return { title, author, coverDataUrl, chapters };
  }

  return { parse, supported: () => typeof DecompressionStream !== 'undefined' };
})();
