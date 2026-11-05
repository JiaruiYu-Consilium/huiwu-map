// 灰雾秘典地图的页面逻辑。身份，读写和同步都在 sync.js 里。
document.documentElement.classList.add('js');
const INK_MS = 20000;
const $ = id => document.getElementById(id);
const pageEl = $('page');
const trayEl = $('tray');
const uid = () => [...crypto.getRandomValues(new Uint8Array(6))].map(x => x.toString(16).padStart(2, '0')).join('');
const V = { sel: null, peek: null, editNote: false, draftTag: '', draftName: '', noteDraft: '', copied: false };
const APP = { role: 'loading', bookId: null, online: true };
const isPlayer = () => APP.role !== 'mc';

/* ---------- 数据 ---------- */
const mkName = (text, regular = false, note = '') => ({ id: uid(), kind: 'name', text, regular, note, acted: false, attached: [] });
const mkProg = (text, cap) => ({ id: uid(), kind: 'prog', text, cap, ticks: Array(cap).fill(false) });
const mkPage = () => ({ id: uid(), tray: [], items: [] });
const level = t => Math.max(...t.boxes);
const label = t => (t.boxes ? `${t.text}-${level(t)}` : t.text);

function tagFrom(p) {
  const tag = { id: uid(), text: p.text, boxes: null };
  if (p.kind === 'status') tag.boxes = [p.level];
  if (p.kind === 'loc') tag.loc = true;
  return tag;
}

function placeRegulars(page, roster) {
  roster.filter(r => r.kind === 'name' && r.regular).forEach((r, i) => {
    page.items.push({ id: uid(), kind: 'name', ref: r.id, x: 6 + i * 15, y: 82, born: 0 });
  });
}

function blankBook() {
  return { title: '新笔记本', pageIdx: 0, round: 1, spot: null, roster: [], pages: [mkPage()], del: { pub: null, priv: null, page: null } };
}

let S = blankBook();

function save() {
  if (window.HW_push) window.HW_push();
}
function commit(fn) {
  fn();
  save();
  render();
}

// 新的一轮开始：红点回到页脚，所有名字的已行动记号清除。
function clearActed() {
  S.spot = null;
  S.roster.forEach(x => { if (x.kind === 'name') x.acted = false; });
}

const shownIdx = () => (V.peek === null ? S.pageIdx : V.peek);
const cur = () => S.pages[shownIdx()];
const readOnly = () => shownIdx() !== S.pageIdx || !APP.online;
const entry = id => S.roster.find(r => r.id === id);
const onPage = (id, page = cur()) => page.items.some(i => i.ref === id);

/* ---------- 输入解析 ---------- */
function clean(t) {
  return t
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•·]\s+|\d+\s*[.、)）]\s*)/, '')
    .replace(/^[^：:#]{1,10}[：:]\s*/, '')
    .replace(/[「」『』“”"‘’《》]/g, '')
    .replace(/[。．.！!？?]+$/, '')
    .trim();
}
function classify(t) {
  let m = t.match(/^#+\s*(.+)$/);
  if (m) return { kind: 'loc', text: m[1], raw: m[1] };
  m = t.match(/^(.+?)\s*[（(]\s*(\d+)\s*[）)]$/);
  if (m) return { kind: 'prog', text: m[1], cap: +m[2], raw: t };
  m = t.match(/^(.+?)\s*[-－–—]\s*(\d+)$/);
  if (m) return { kind: 'status', text: m[1], level: +m[2], raw: t };
  return { kind: 'tag', text: t, raw: t };
}
function parseInput(raw) {
  const ticks = [...raw.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  const parts = ticks.length
    ? ticks
    : raw.replace(/（[^（）]*[^\d\s（）][^（）]*）|\([^()]*[^\d\s()][^()]*\)/g, '').split(/[,，、;；\n]+/);
  return parts.map(clean).filter(Boolean).map(classify);
}
function ensureProg(text, cap, roster = S.roster) {
  let r = roster.find(x => x.kind === 'prog' && x.text === text);
  if (!r) { r = mkProg(text, cap); roster.push(r); }
  return r;
}
function ensureNoteProgs(note, roster = S.roster) {
  [...(note || '').matchAll(/`([^`]+)`/g)].map(m => classify(m[1])).forEach(p => {
    if (p.kind === 'prog') ensureProg(p.text, p.cap, roster);
  });
}

function addTags(parsed) {
  parsed.forEach(p => {
    if (p.kind === 'prog') ensureProg(p.text, p.cap);
    else cur().tray.push(tagFrom(p));
  });
}
function addNames(parsed) {
  parsed.forEach(p => {
    if (p.kind === 'prog') { ensureProg(p.text, p.cap); return; }
    if (!S.roster.some(r => r.kind === 'name' && r.text === p.raw)) S.roster.push(mkName(p.raw));
  });
}

/* ---------- 规则：状态的叠加和减轻 ---------- */
function stack(boxes, lvl) {
  let n = lvl;
  while (boxes.includes(n)) n += 1;
  boxes.push(n);
  boxes.sort((a, b) => a - b);
}
function attach(owner, tag) {
  owner.attached = owner.attached || [];
  if (tag.boxes) {
    const same = owner.attached.find(a => a.boxes && a.text === tag.text);
    if (same) { stack(same.boxes, level(tag)); same.born = Date.now(); return; }
  }
  tag.born = Date.now();
  owner.attached.push(tag);
}
const hasKids = t => Boolean(t.attached && t.attached.length);
function findKid(owner, tid) {
  for (const a of owner.attached || []) {
    if (a.id === tid) return { tag: a, owner };
    const k = findKid(a, tid);
    if (k) return k;
  }
  return null;
}
function findTag(tid) {
  for (const it of cur().items) {
    if (it.kind !== 'tag') continue;
    if (it.tag.id === tid) return { tag: it.tag, item: it };
    const k = findKid(it.tag, tid);
    if (k) return k;
  }
  for (const r of S.roster) {
    if (r.kind !== 'name') continue;
    const k = findKid(r, tid);
    if (k) return k;
  }
  return null;
}
const countKids = t => (t.attached || []).reduce((n, a) => n + 1 + countKids(a), 0);

const ownerById = id => entry(id) || (findTag(id) || {}).tag;

/* ---------- 删除和还原 ---------- */
// 隐藏页上删除的内容不能放进公开的那一格，否则玩家会看到被删的文字。
const delSlot = () => (cur().hidden ? 'priv' : 'pub');
function removeFound(found) {
  if (found.item) {
    S.del[delSlot()] = { type: 'item', label: label(found.tag), pageId: cur().id, item: found.item };
    cur().items = cur().items.filter(i => i !== found.item);
  } else {
    S.del[delSlot()] = { type: 'att', label: label(found.tag), nid: found.owner.id, tag: found.tag };
    found.owner.attached = found.owner.attached.filter(a => a !== found.tag);
  }
}
function deleteItem(iid) {
  const it = cur().items.find(i => i.id === iid);
  if (!it) return;
  const text = it.kind === 'tag' ? label(it.tag) : it.kind === 'loc' ? it.text : (entry(it.ref) || {}).text || '';
  S.del[delSlot()] = { type: 'item', label: text, pageId: cur().id, item: it };
  cur().items = cur().items.filter(i => i !== it);
  if (it.kind === 'name' && S.spot === it.ref && !cur().hidden) S.spot = null;
}
function deleteRoster(rid) {
  const r = entry(rid);
  if (!r) return;
  const placements = [];
  S.pages.forEach(p => p.items.forEach(i => { if (i.ref === rid) placements.push({ pageId: p.id, item: i }); }));
  S.pages.forEach(p => { p.items = p.items.filter(i => i.ref !== rid); });
  S.roster = S.roster.filter(x => x !== r);
  S.del.priv = { type: 'roster', label: r.text, entry: r, placements };
  if (V.sel === rid) V.sel = null;
  if (S.spot === rid) S.spot = null;
}
function restore(which) {
  const d = S.del[which];
  if (!d) return;
  const pageById = id => S.pages.find(p => p.id === id) || S.pages[S.pageIdx];
  if (d.type === 'item') pageById(d.pageId).items.push(d.item);
  if (d.type === 'att') {
    const n = ownerById(d.nid);
    if (n) (n.attached = n.attached || []).push(d.tag);
    else cur().items.push({ id: uid(), kind: 'tag', tag: d.tag, x: 40, y: 40, born: Date.now() });
  }
  if (d.type === 'tray') pageById(d.pageId).tray.push(d.tag);
  if (d.type === 'roster') {
    S.roster.push(d.entry);
    d.placements.forEach(pl => { const pg = S.pages.find(p => p.id === pl.pageId); if (pg) pg.items.push(pl.item); });
  }
  S.del[which] = null;
}
function deletePage() {
  if (S.pages.length < 2 || isLastShown(S.pages[S.pageIdx])) return;
  const i = S.pageIdx;
  const table = publicPageId();
  const [page] = S.pages.splice(i, 1);
  S.del.page = { label: `第 ${i + 1} 页`, page, idx: i };
  if (page.hidden) {
    S.pageIdx = S.pages.findIndex(p => p.id === table);
  } else {
    S.pageIdx = Math.max(0, i - 1);
    S.spot = null;
  }
}
function restorePage() {
  const d = S.del.page;
  if (!d) return;
  S.pages.splice(d.idx, 0, d.page);
  S.pageIdx = d.idx;
  S.del.page = null;
}

/* ---------- 隐藏页 ---------- */
// 隐藏页只存在私人区域，玩家读不到。叙述者在隐藏页上准备时，全桌留在最后一个公开的页。至少留一页公开。
const shownPages = () => S.pages.filter(p => !p.hidden);
const isLastShown = p => !p.hidden && shownPages().length < 2;
function publicPageId() {
  const here = S.pages[S.pageIdx];
  if (here && !here.hidden) return here.id;
  const shown = shownPages();
  if (shown.some(p => p.id === S.pubPage)) return S.pubPage;
  const before = S.pages.slice(0, S.pageIdx).reverse().find(p => !p.hidden);
  return (before || shown[0] || {}).id;
}
function toggleHidden() {
  const p = S.pages[S.pageIdx];
  if (p.hidden) {
    delete p.hidden;
  } else {
    if (isLastShown(p)) return;
    p.hidden = true;
    if (S.del.pub && S.del.pub.pageId === p.id) {
      S.del.priv = S.del.pub;
      S.del.pub = null;
    }
  }
  S.spot = null;
}

/* ---------- 渲染工具 ---------- */
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(cls, act, text, attrs = {}) {
  const b = h('button', cls, text);
  b.type = 'button';
  b.dataset.act = act;
  Object.entries(attrs).forEach(([k, v]) => { b.setAttribute(k, v); });
  return b;
}
function inkify(e, born) {
  const age = Date.now() - (born || 0);
  if (born && age < INK_MS) {
    e.classList.add('fresh');
    e.style.setProperty('--age', `${-age / 1000}s`);
  }
}
function statusPop(tag) {
  const pop = h('span', 'pop');
  const n = Math.max(6, level(tag) + 1);
  for (let i = 1; i <= n; i += 1) {
    pop.appendChild(btn('bx', 'st-box', '', { 'data-lvl': i, 'aria-pressed': String(tag.boxes.includes(i)), 'aria-label': `第 ${i} 格` }));
  }
  pop.appendChild(btn('less', 'st-less', '−', { 'aria-label': '减轻 1 级' }));
  return pop;
}
function progBoxes(host, r) {
  r.ticks.forEach((on, i) => {
    host.appendChild(btn('bx', 'prog-box', '', { 'data-rid': r.id, 'data-i': i, 'aria-pressed': String(on), 'aria-label': `第 ${i + 1} 格` }));
  });
  host.classList.toggle('full', r.ticks.every(Boolean));
}

/* ---------- 颜料 ---------- */
// 范围是涂在标签上的一层颜料，跟着标签移动。坐标用 300 乘 200 的纸面单位，所以每块屏幕看到的形状相同。
const PAINTS = [['red', '暗红'], ['grey', '墨灰'], ['blue', '靛青'], ['ochre', '赭黄'], ['moss', '苔绿'], ['violet', '暗紫']];
const BRUSHES = [[14, '细'], [26, '中'], [44, '粗']];
// 三份噪声共用，每份的四个通道各管一件事，这样算得快。n1 管大形状，软硬边的分布和底色浓淡；n2 管边缘细节和深边粗细；n3 管偏色和积色。
// 笔画是半透明的，重叠处自然更浓。水干时颜料往边上走，所以大片颜料的中间变淡，窄的笔画仍然浓。
const noiseMask = (from, row, result) => `<feColorMatrix in="${from}" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${row}" result="${result}"/>`;
const WET_SHAPE = `<feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="3" seed="4" result="n1"/>
<feDisplacementMap in="SourceGraphic" in2="n1" scale="20" xChannelSelector="R" yChannelSelector="G" result="d1"/>
<feTurbulence type="fractalNoise" baseFrequency="0.1" numOctaves="3" seed="7" result="n2"/>
<feDisplacementMap in="d1" in2="n2" scale="4.5" xChannelSelector="R" yChannelSelector="G" result="d"/>`;
const filterOpen = (id, [x, y, w, h]) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}" color-interpolation-filters="sRGB">`;
function wetFilter(id, box) {
  return `${filterOpen(id, box)}${WET_SHAPE}
<feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="13" result="n3"/>
<feGaussianBlur in="d" stdDeviation="0.35" result="b"/>
<feComponentTransfer in="b" result="crisp"><feFuncA type="table" tableValues="0 0.6 1 1 1 1 1 1 1 1"/></feComponentTransfer>
<feMorphology in="crisp" operator="erode" radius="0.45" result="ie"/>
<feGaussianBlur in="ie" stdDeviation="1.1" result="is"/>
<feComposite in="crisp" in2="is" operator="out" result="rim0"/>
${noiseMask('n2', '0 0 4 0 -1.2', 'mr')}
<feComposite in="rim0" in2="mr" operator="in" result="rim"/>
<feGaussianBlur in="d" stdDeviation="4.5" result="fb"/>
<feComponentTransfer in="fb" result="bleed"><feFuncA type="table" tableValues="0 0.3 0.62 0.86 1 1 1 1 1 1"/></feComponentTransfer>
${noiseMask('n1', '0 0 6 0 -2.7', 'mf')}
<feComposite in="crisp" in2="mf" operator="in" result="hard"/>
<feComposite in="bleed" in2="mf" operator="out" result="soft"/>
<feMerge result="cover"><feMergeNode in="soft"/><feMergeNode in="hard"/></feMerge>
<feGaussianBlur in="d" stdDeviation="3.5" result="ov"/>
<feComponentTransfer in="ov" result="dens"><feFuncA type="table" tableValues="0 0.5 0.62 0.72 0.8 0.86 0.92 1"/></feComponentTransfer>
<feGaussianBlur in="crisp" stdDeviation="10" result="far"/>
<feComponentTransfer in="far" result="mid"><feFuncA type="table" tableValues="1 1 1 1 1 1 0.92 0.78 0.6 0.42 0.26"/></feComponentTransfer>
${noiseMask('n1', '0 0 0 2.5 -0.42', 'mc')}
<feComposite in="cover" in2="dens" operator="in" result="x"/>
<feComposite in="x" in2="mid" operator="in" result="x2"/>
<feComposite in="x2" in2="mc" operator="in" result="body"/>
<feColorMatrix in="x" type="hueRotate" values="16" result="warm"/>
${noiseMask('n3', '4 0 0 0 -1.95', 'mh')}
<feComposite in="warm" in2="mh" operator="in" result="warmPool"/>
<feColorMatrix in="x" type="matrix" values=".76 0 0 0 0  0 .68 0 0 0  0 0 .74 0 0  0 0 0 1 0" result="deep"/>
${noiseMask('n3', '0 4 0 0 -1.9', 'mp')}
<feComposite in="deep" in2="mp" operator="in" result="deepPool"/>
<feMerge><feMergeNode in="body"/><feMergeNode in="warmPool"/><feMergeNode in="deepPool"/><feMergeNode in="rim"/></feMerge>
</filter>`;
}
// 滤镜只算颜料覆盖的范围。边距要盖住笔宽的一半，形状的偏移和软边的化开。
function areaBox(strokes, off) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  strokes.forEach(st => st.p.forEach(([x, y]) => {
    const r = st.w / 2 + 30;
    x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
  }));
  return [x0 + off, y0 + off, x1 - x0, y1 - y0].map(n => +n.toFixed(1));
}
function strokeD(p) {
  if (p.length === 1) return `M${p[0][0]} ${p[0][1]}l0.01 0`;
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i += 1) {
    const mx = (p[i][0] + p[i + 1][0]) / 2;
    const my = (p[i][1] + p[i + 1][1]) / 2;
    d += `Q${p[i][0]} ${p[i][1]} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = p[p.length - 1];
  return `${d}L${last[0]} ${last[1]}`;
}
const areaPos = it => `translate(${it.x}%, ${it.y}%)`;
// 噪声在坐标原点不连续，所以滤镜放在远离原点的坐标里算，再整组移回来。每条标签的偏移不同，形状才不会雷同。
const areaOff = tag => 800 + ([...tag.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 300);
function areaSvg(tag, filter, fid, paths) {
  const off = areaOff(tag);
  const box = document.createElement('div');
  box.innerHTML = `<svg class="area paint-${tag.area.c || 'red'}" viewBox="0 0 300 200" preserveAspectRatio="none">${filter}<g transform="translate(${-off} ${-off})"><g filter="url(#${fid})"><g transform="translate(${off} ${off})">${paths}</g></g></g></svg>`;
  return box.firstChild;
}
// 每片颜料是一个独立的图层。滤镜只在颜料本身改变时重算一次，移动标签和刷新页面都不必再算。
function syncPaint(p) {
  let layer = pageEl.querySelector(':scope > .paint');
  if (!layer) {
    layer = h('div', 'paint');
    layer.setAttribute('aria-hidden', 'true');
    pageEl.prepend(layer);
  }
  const shown = new Set();
  p.items.filter(it => it.kind === 'tag' && it.tag.area && it.tag.area.s && it.tag.area.s.length).forEach(it => {
    const key = JSON.stringify(it.tag.area);
    const old = layer.querySelector(`.area[data-tid="${it.tag.id}"]`);
    let el = old;
    if (!old || old.dataset.key !== key) {
      const fid = `wet-${it.tag.id}`;
      el = areaSvg(it.tag, wetFilter(fid, areaBox(it.tag.area.s, areaOff(it.tag))), fid, it.tag.area.s.map(st => `<path d="${strokeD(st.p)}" stroke-width="${st.w}"/>`).join(''));
      el.dataset.tid = it.tag.id;
      el.dataset.key = key;
      if (old) old.replaceWith(el); else layer.appendChild(el);
    }
    el.style.transform = areaPos(it);
    shown.add(it.tag.id);
  });
  layer.querySelectorAll('.area[data-tid]').forEach(el => { if (!shown.has(el.dataset.tid)) el.remove(); });
}
// 涂的时候只算正在画的这一笔，并且只算形状。抬笔以后才算完整的水彩质感。
function wetStrokeShow(f, st) {
  const off = areaOff(f.tag);
  const box = areaBox([st], off);
  let el = pageEl.querySelector('.area.wet');
  if (!el) {
    el = areaSvg(f.tag, `${filterOpen('wet-now', box)}${WET_SHAPE}<feGaussianBlur in="d" stdDeviation="0.5"/></filter>`, 'wet-now', `<path stroke-width="${st.w}"/>`);
    el.classList.add('wet');
    el.style.transform = areaPos(f.item);
    pageEl.querySelector(':scope > .paint').appendChild(el);
  }
  const flt = el.querySelector('filter');
  ['x', 'y', 'width', 'height'].forEach((k, i) => flt.setAttribute(k, box[i]));
  el.querySelector('path').setAttribute('d', strokeD(st.p));
}
function wetStrokeEnd() {
  const el = pageEl.querySelector('.area.wet');
  if (el) el.remove();
}
// 调大小时结束刚上纸的暗红提示，否则前 20 秒看不出这一档的颜色。
function resize(tid, step) {
  const f = findTag(tid);
  if (!f) return;
  f.tag.sz = Math.max(1, Math.min(4, (f.tag.sz || 1) + step));
  if (f.item) f.item.born = 0;
}
function paintBarEl() {
  const bar = h('div', 'paintbar');
  bar.appendChild(h('span', 'pb-who', `涂「${V.paint.text}」的范围`));
  const colors = h('span', 'pb-group');
  PAINTS.forEach(([c, name]) => colors.appendChild(btn(`sw paint-${c}`, 'p-color', '', { 'data-c': c, 'aria-label': name, title: name, 'aria-pressed': String(V.paint.c === c) })));
  bar.appendChild(colors);
  const sizes = h('span', 'pb-group');
  BRUSHES.forEach(([w, name]) => sizes.appendChild(btn('pb-txt', 'p-width', name, { 'data-w': w, 'aria-pressed': String(V.paint.w === w) })));
  bar.appendChild(sizes);
  bar.appendChild(btn('pb-txt', 'p-undo', '退一笔'));
  bar.appendChild(btn('pb-txt', 'p-clear', '清除'));
  bar.appendChild(btn('pb-txt pb-done', 'p-done', '涂好了'));
  return bar;
}
function paintTag() {
  const f = V.paint && findTag(V.paint.tid);
  return f && f.item ? f : null;
}
function endPaint() {
  V.paint = null;
  document.body.classList.remove('painting');
  render();
}

/* ---------- 纸面 ---------- */
function kidsEl(tag) {
  const kids = h('span', 'kids');
  tag.attached.forEach(t => kids.appendChild(attEl(t)));
  return kids;
}
function attEl(t) {
  const a = h('span', `tg att${t.boxes ? ' lv' : ''}`);
  a.dataset.tid = t.id;
  const tl = h('span', 'tl', label(t));
  if (!readOnly()) {
    if (t.boxes) tl.appendChild(statusPop(t));
    tl.appendChild(btn('x', 'del-att', '×', { 'aria-label': `删除 ${label(t)}` }));
    if (!t.boxes) tl.appendChild(btn('add', 'add-kid', '+', { 'aria-label': `给 ${t.text} 挂一条标签` }));
  }
  inkify(tl, t.born);
  a.appendChild(tl);
  if (hasKids(t)) a.appendChild(kidsEl(t));
  return a;
}
function toolsEl(it) {
  const t = it.tag;
  const box = h('span', 'tools');
  box.appendChild(btn('', 'del-item', '×', { 'data-iid': it.id, 'aria-label': `删除 ${label(t)}` }));
  if (!t.boxes) box.appendChild(btn('', 'add-kid', '+', { 'aria-label': `给 ${t.text} 挂一条标签` }));
  box.appendChild(btn('', 'paint', '涂', { 'aria-label': `给 ${t.text} 涂范围` }));
  box.appendChild(btn('', 'sz-dn', '小', { 'aria-label': '字小一档' }));
  box.appendChild(btn('', 'sz-up', '大', { 'aria-label': '字大一档' }));
  box.appendChild(btn('', 'tgl-vert', '竖', { 'aria-label': '竖排', 'aria-pressed': String(Boolean(t.vert)) }));
  box.appendChild(btn('rotor', 'noop', '转', { 'aria-label': '按住拖动旋转' }));
  return box;
}
function itemEl(it) {
  let e;
  if (it.kind === 'tag') {
    const t = it.tag;
    e = h('div', `it tg${t.boxes ? ' lv' : ''}${t.sz > 1 ? ` sz${t.sz}` : ''}${t.vert ? ' vert' : ''}${V.toolsFor === t.id ? ' tools-on' : ''}`);
    e.dataset.tid = t.id;
    if (t.rot) e.style.setProperty('--rot', `${t.rot}deg`);
    const tl = h('span', 'tl', label(t));
    if (!readOnly()) {
      if (t.boxes) tl.appendChild(statusPop(t));
      tl.appendChild(toolsEl(it));
    }
    inkify(tl, it.born);
    e.appendChild(tl);
    if (hasKids(t)) e.appendChild(kidsEl(t));
  } else if (it.kind === 'loc') {
    e = h('div', 'it loc', it.text);
    inkify(e, it.born);
  } else if (it.kind === 'name') {
    const r = entry(it.ref);
    e = h('div', `it name${r.acted ? ' acted' : ''}${V.sel === r.id && !isPlayer() ? ' sel' : ''}`);
    e.dataset.nid = r.id;
    const nm = h('span', 'nm', r.text);
    if (!readOnly()) nm.appendChild(btn('x', 'del-item', '×', { 'data-iid': it.id, 'aria-label': `从这一页移除 ${r.text}` }));
    e.appendChild(nm);
    inkify(nm, it.born);
    r.attached.forEach(t => e.appendChild(attEl(t)));
    if (S.spot === r.id && !cur().hidden) e.appendChild(h('span', 'dot'));
  } else {
    const r = entry(it.ref);
    e = h('div', 'it prog', r.text + `（${r.cap}）`);
    progBoxes(e, r);
    inkify(e, it.born);
  }
  e.dataset.iid = it.id;
  e.style.setProperty('--x', it.x);
  e.style.setProperty('--y', it.y);
  if (!readOnly() && (it.kind === 'loc' || it.kind === 'prog')) {
    e.appendChild(btn('x', 'del-item', '×', { 'data-iid': it.id, 'aria-label': '删除' }));
  }
  return e;
}

function renderPage() {
  const p = cur();
  if (!p) return;
  [...pageEl.children].forEach(c => { if (!c.classList.contains('paint')) c.remove(); });
  syncPaint(p);
  if (!p.items.some(i => i.kind === 'loc') && !readOnly()) {
    pageEl.appendChild(btn('ph', 'new-loc', '写下地点'));
  }
  p.items.filter(it => !it.ref || entry(it.ref)).forEach(it => pageEl.appendChild(itemEl(it)));

  const foot = h('div', 'foot');
  const ttl = h('span', 'ttl', S.title);
  if (!isPlayer()) ttl.dataset.act = 'edit-title';
  foot.appendChild(ttl);
  const pager = h('span', 'pager');
  pager.appendChild(btn('', 'prev', '‹', { 'aria-label': '上一页' }));
  pager.appendChild(h('span', '', `${shownIdx() + 1} / ${S.pages.length}`));
  pager.appendChild(btn('', 'next-page', '›', { 'aria-label': '下一页' }));
  foot.appendChild(pager);
  if (!isPlayer() && cur().hidden) {
    const n = h('span', 'hid', '玩家看不到这一页，');
    n.appendChild(btn('', 'toggle-hidden', '放出来'));
    foot.appendChild(n);
  }
  if (!APP.online) {
    foot.appendChild(h('span', 'off', '已断线，恢复以前不能修改'));
  } else if (readOnly()) {
    const pk = h('span', 'peek', '这是旧页，只能看');
    pk.appendChild(btn('', 'back-cur', '回到当前页'));
    foot.appendChild(pk);
  } else if (S.del.pub) {
    const n = h('span', 'notice', `已删除 ${S.del.pub.label}，`);
    n.appendChild(btn('', 'restore-pub', '还原'));
    foot.appendChild(n);
  }
  foot.appendChild(h('span', 'sp'));
  const round = h('span', 'round');
  if (!(S.spot && onPage(S.spot)) && !isPlayer() && !cur().hidden) round.appendChild(h('span', 'dot'));
  round.appendChild(h('span', '', `第 ${S.round} 轮`));
  if (!isPlayer() && !readOnly()) round.appendChild(btn('reset', 'reset-round', '归零', { 'aria-label': '把轮数归零' }));
  foot.appendChild(round);
  pageEl.appendChild(foot);
  if (V.paint) pageEl.appendChild(paintBarEl());

  const pr = pageEl.getBoundingClientRect();
  pageEl.querySelectorAll('.it').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.right > pr.right) e.style.left = `${((pr.width - r.width) / pr.width) * 100}%`;
    if (r.bottom > pr.bottom) e.style.top = `${((pr.height - r.height) / pr.height) * 100}%`;
  });
}

/* ---------- 备用栏 ---------- */
function fieldEl(key, ph, label2) {
  const t = h('textarea', 'field');
  t.rows = 1;
  t.placeholder = ph;
  t.setAttribute('aria-label', label2);
  t.dataset.field = key;
  t.value = key === 'tag' ? V.draftTag : V.draftName;
  t.disabled = !APP.online;
  return t;
}
function noteLine(line) {
  const p = h('p');
  line.split(/(`[^`]+`)/).forEach(part => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const text = part.slice(1, -1);
      const parsed = classify(text);
      const c = h('span', `chip${parsed.kind === 'status' ? ' lv' : ''}${parsed.kind === 'prog' ? ' pr' : ''}`, text);
      c.dataset.text = text;
      if (parsed.kind === 'prog') {
        const r = S.roster.find(x => x.kind === 'prog' && x.text === parsed.text);
        if (r) progBoxes(c, r);
      }
      p.appendChild(c);
    } else if (part.trim()) {
      p.appendChild(document.createTextNode(part));
    } else if (part) {
      p.appendChild(h('span', 'gap'));
    }
  });
  return p;
}
function noteEl() {
  const r = V.sel ? entry(V.sel) : null;
  const box = h('section', 'note');
  box.appendChild(h('h2', '', '备注'));
  if (!r) {
    box.appendChild(h('p', 'empty', '点纸上或者「这一本」里的名字，这里显示这个名字的备注。'));
    return box;
  }
  const hd = h('div', 'hd');
  hd.appendChild(h('span', 'who', r.text));
  hd.appendChild(btn('tog', 'tgl-regular', '常驻', { 'aria-pressed': String(r.regular) }));
  hd.appendChild(btn('tog', 'tgl-acted', '已行动', { 'aria-pressed': String(r.acted) }));
  box.appendChild(hd);
  if (V.editNote) {
    const ta = h('textarea');
    ta.value = V.noteDraft;
    ta.dataset.field = 'note';
    ta.setAttribute('aria-label', `${r.text} 的备注`);
    box.appendChild(ta);
    return box;
  }
  const body = h('div', 'body');
  body.dataset.act = 'edit-note';
  if (r.note.trim()) r.note.split('\n').filter(l => l.trim()).forEach(l => body.appendChild(noteLine(l)));
  else body.appendChild(h('p', 'blank', '点这里写上限，威胁，后果和秘密。用反引号包住的文字可以拖到纸上。'));
  box.appendChild(body);
  return box;
}
function growAll() {
  trayEl.querySelectorAll('textarea').forEach(t => {
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  });
}
function renderTray() {
  const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null;
  const oldScroll = trayEl.querySelector('.tray-scroll');
  const top = oldScroll ? oldScroll.scrollTop : 0;
  trayEl.innerHTML = '';
  const scroll = h('div', 'tray-scroll');
  const p = S.pages[S.pageIdx];

  const secTag = h('section');
  secTag.appendChild(h('h2', '', '这一页的标签'));
  secTag.appendChild(fieldEl('tag', '写标签，可以粘贴一串', '新标签'));
  const pool = h('ul', 'pool');
  p.tray.forEach(t => {
    const li = h('li');
    const e = h('span', `tg${t.boxes ? ' lv' : ''}${t.loc ? ' bigloc' : ''}`, label(t));
    e.dataset.tid = t.id;
    if (hasKids(t)) e.appendChild(h('span', 'cnt', `（含 ${countKids(t)} 条）`));
    e.appendChild(btn('x', 'del-tray', '×', { 'aria-label': `删除 ${label(t)}` }));
    li.appendChild(e);
    pool.appendChild(li);
  });
  if (p.tray.length) secTag.appendChild(pool);
  else secTag.appendChild(h('p', 'empty', '逗号，顿号和换行都算分隔，#书房 是地点。'));
  scroll.appendChild(secTag);

  const secRo = h('section');
  secRo.appendChild(h('h2', '', '这一本'));
  secRo.appendChild(fieldEl('name', '写名字，或者 霜化（5）', '新名字'));
  const ro = h('ul', 'roster');
  S.roster.filter(r => r.kind === 'name').forEach(r => {
    const li = h('li', `ro${onPage(r.id, p) ? ' on' : ''}${V.sel === r.id ? ' picked' : ''}`);
    li.dataset.rid = r.id;
    li.appendChild(h('span', 'rn', r.text));
    li.appendChild(btn('x', 'del-roster', '×', { 'aria-label': `删除 ${r.text}` }));
    ro.appendChild(li);
  });
  secRo.appendChild(ro);
  const prs = h('ul', 'progs');
  S.roster.filter(r => r.kind === 'prog').forEach(r => {
    const li = h('li', `ro pr${onPage(r.id, p) ? ' on' : ''}`);
    li.dataset.rid = r.id;
    const sp = h('span');
    sp.appendChild(h('span', 'lbl', `${r.text}（${r.cap}）`));
    progBoxes(sp, r);
    li.appendChild(sp);
    li.appendChild(btn('x', 'del-roster', '×', { 'aria-label': `删除 ${r.text}` }));
    prs.appendChild(li);
  });
  secRo.appendChild(prs);
  scroll.appendChild(secRo);

  scroll.appendChild(noteEl());
  trayEl.appendChild(scroll);

  const ctl = h('section', 'ctl');
  if (S.del.priv) {
    const n = h('p', 'tray-notice', `已删除 ${S.del.priv.label}，`);
    n.appendChild(btn('', 'restore-priv', '还原'));
    ctl.appendChild(n);
  }
  if (S.del.page) {
    const n = h('p', 'tray-notice', `已删除 ${S.del.page.label}，`);
    n.appendChild(btn('', 'restore-page', '还原'));
    ctl.appendChild(n);
  }
  const row = h('div', 'row');
  row.appendChild(btn('btn', 'next-round', '下一轮'));
  row.appendChild(btn('btn', 'new-page', '新建一页'));
  ctl.appendChild(row);
  const here = S.pages[S.pageIdx];
  const pageRow = h('div', 'less-row');
  pageRow.appendChild(btn('', 'new-hidden-page', '新建隐藏页'));
  if (here.hidden) pageRow.appendChild(btn('', 'toggle-hidden', '放出这一页'));
  else if (!isLastShown(here)) pageRow.appendChild(btn('', 'toggle-hidden', '隐藏这一页'));
  if (S.pages.length > 1 && !isLastShown(here)) pageRow.appendChild(btn('', 'del-page', '删除这一页'));
  ctl.appendChild(pageRow);
  const less = h('div', 'less-row');
  less.appendChild(btn('', 'copy-link', V.copied ? '已复制' : '复制玩家链接'));
  less.appendChild(btn('', 'view-player', '玩家的画面'));
  less.appendChild(btn('', 'export', '导出'));
  less.appendChild(btn('', 'import', '导入'));
  less.appendChild(btn('', 'go-shelf', '书架'));
  ctl.appendChild(less);
  trayEl.appendChild(ctl);

  growAll();
  scroll.scrollTop = top;
  if (active) {
    const t = trayEl.querySelector(`[data-field="${active}"]`);
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }
}

function render() {
  document.body.classList.toggle('is-player', isPlayer());
  document.body.classList.toggle('is-mc', !isPlayer());
  document.body.classList.toggle('is-off', !APP.online);
  renderPage();
  if (!isPlayer()) renderTray();
}

/* ---------- 就地写字 ---------- */
function inlineEditor({ x, y, value = '', onCommit, like = null }) {
  const old = pageEl.querySelector('.inl');
  if (old) old.blur();
  const inp = h('input', 'inl');
  inp.value = value;
  inp.style.left = `${x}%`;
  inp.style.top = `${y}%`;
  inp.setAttribute('aria-label', '写标签');
  let ls = 0;
  if (like) {
    const cs = getComputedStyle(like);
    inp.style.fontSize = cs.fontSize;
    inp.style.fontFamily = cs.fontFamily;
    inp.style.fontWeight = cs.fontWeight;
    inp.style.letterSpacing = cs.letterSpacing;
    inp.style.lineHeight = cs.lineHeight;
    inp.style.color = cs.color;
    ls = parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize) || 0;
    like.style.visibility = 'hidden';
  }
  const fit = () => { inp.style.width = `${(Math.max(4, [...inp.value].length) + 1) * (1.05 + ls)}em`; };
  fit();
  let done = false;
  const finish = ok => {
    if (done) return;
    done = true;
    const v = inp.value;
    inp.remove();
    if (like) like.style.visibility = '';
    if (ok && v.trim()) commit(() => onCommit(v));
  };
  inp.addEventListener('input', fit);
  inp.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  inp.addEventListener('paste', e => {
    const text = e.clipboardData.getData('text');
    if (/\n/.test(text)) { e.preventDefault(); inp.value += text.replace(/\n+/g, '，'); fit(); }
  });
  inp.addEventListener('blur', () => finish(true));
  pageEl.appendChild(inp);
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}
function pagePct(cx, cy) {
  const r = pageEl.getBoundingClientRect();
  return { x: ((cx - r.left) / r.width) * 100, y: ((cy - r.top) / r.height) * 100 };
}
function placeParsed(list, x, y) {
  list.forEach((p, i) => {
    const yy = y + i * 3.6;
    const born = Date.now();
    if (p.kind === 'prog') {
      const r = ensureProg(p.text, p.cap);
      if (!onPage(r.id)) cur().items.push({ id: uid(), kind: 'prog', ref: r.id, x, y: yy, born });
    } else if (p.kind === 'loc') {
      cur().items.push({ id: uid(), kind: 'loc', text: p.text, x, y: yy, born });
    } else {
      cur().items.push({ id: uid(), kind: 'tag', tag: tagFrom(p), x, y: yy, born });
    }
  });
}

pageEl.addEventListener('dblclick', ev => {
  if (readOnly()) return;
  const t = ev.target;
  if (t.closest('button') || t.closest('.foot') || t.closest('.prog') || t.closest('.pop')) return;
  const att = t.closest('.tg.att');
  const nameE = t.closest('.name');
  const tagE = t.closest('.it.tg');
  const locE = t.closest('.it.loc');
  const pr = pageEl.getBoundingClientRect();
  const at = (e, edge = 'top') => {
    const r = e.getBoundingClientRect();
    return { x: ((r.left - pr.left) / pr.width) * 100, y: ((r[edge] - pr.top) / pr.height) * 100 };
  };
  if (att) {
    const f = findTag(att.dataset.tid);
    const tl = att.querySelector('.tl');
    inlineEditor({ ...at(tl), value: label(f.tag), like: tl, onCommit: v => retext(f.tag, v) });
  } else if (nameE) {
    const n = entry(nameE.dataset.nid);
    inlineEditor({ ...at(nameE, 'bottom'), onCommit: v => attachParsed(n, v) });
  } else if (tagE) {
    const f = findTag(tagE.dataset.tid);
    const tl = tagE.querySelector('.tl');
    inlineEditor({ ...at(tl), value: label(f.tag), like: tl, onCommit: v => retext(f.tag, v) });
  } else if (locE) {
    const it = cur().items.find(i => i.id === locE.dataset.iid);
    inlineEditor({ x: it.x, y: it.y, value: it.text, like: locE, onCommit: v => { it.text = v.trim(); } });
  } else {
    const { x, y } = pagePct(ev.clientX, ev.clientY);
    inlineEditor({ x, y, onCommit: v => placeParsed(parseInput(v), x, y) });
  }
});
function attachParsed(owner, v) {
  parseInput(v).forEach(p => { if (p.kind !== 'prog' && p.kind !== 'loc') attach(owner, tagFrom(p)); });
}
function retext(tag, v) {
  const p = classify(clean(v));
  tag.text = p.text;
  if (p.kind === 'status') tag.boxes = [p.level];
  else if (p.kind === 'tag') tag.boxes = null;
}

/* ---------- 点击 ---------- */
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const r = V.sel ? entry(V.sel) : null;
  const go = {
    'prev': () => stepPage(-1),
    'next-page': () => stepPage(1),
    'back-cur': () => { V.peek = null; render(); },
    'new-loc': () => inlineEditor({ x: 5, y: 7, like: b, onCommit: v => placeParsed(parseInput(v).map(p => ({ ...p, kind: 'loc', text: p.raw })), 5, 7) }),
    'del-item': () => commit(() => deleteItem(b.dataset.iid)),
    'noop': () => {},
    'sz-up': () => commit(() => resize(b.closest('.it.tg').dataset.tid, 1)),
    'sz-dn': () => commit(() => resize(b.closest('.it.tg').dataset.tid, -1)),
    'tgl-vert': () => commit(() => { const t = findTag(b.closest('.it.tg').dataset.tid).tag; t.vert = !t.vert; if (t.vert) t.rot = 0; }),
    'paint': () => {
      const t = findTag(b.closest('.it.tg').dataset.tid).tag;
      V.paint = { tid: t.id, text: t.text, c: (t.area && t.area.c) || V.lastPaint || 'red', w: V.lastBrush || 26 };
      document.body.classList.add('painting');
      renderPage();
    },
    'p-color': () => {
      V.paint.c = b.dataset.c;
      V.lastPaint = b.dataset.c;
      const f = paintTag();
      if (f && f.tag.area) commit(() => { f.tag.area.c = b.dataset.c; });
      else renderPage();
    },
    'p-width': () => { V.paint.w = +b.dataset.w; V.lastBrush = V.paint.w; renderPage(); },
    'p-undo': () => {
      const f = paintTag();
      if (f && f.tag.area && f.tag.area.s) commit(() => { f.tag.area.s.pop(); if (!f.tag.area.s.length) delete f.tag.area; });
    },
    'p-clear': () => {
      const f = paintTag();
      if (f && f.tag.area) commit(() => { delete f.tag.area; });
    },
    'p-done': endPaint,
    'add-kid': () => {
      const tagE = b.closest('.tg');
      const pr = pageEl.getBoundingClientRect();
      const r = tagE.getBoundingClientRect();
      const owner = findTag(tagE.dataset.tid).tag;
      inlineEditor({ x: ((r.left - pr.left) / pr.width) * 100 + 1, y: ((r.bottom - pr.top) / pr.height) * 100, onCommit: v => attachParsed(owner, v) });
    },
    'del-page': () => commit(deletePage),
    'restore-page': () => commit(restorePage),
    'del-att': () => commit(() => removeFound(findTag(b.closest('.tg').dataset.tid))),
    'del-tray': () => commit(() => {
      const pg = S.pages[S.pageIdx];
      const tag = pg.tray.find(t => t.id === b.closest('.tg').dataset.tid);
      pg.tray = pg.tray.filter(t => t !== tag);
      S.del.priv = { type: 'tray', label: label(tag), pageId: pg.id, tag };
    }),
    'del-roster': () => commit(() => deleteRoster(b.closest('.ro').dataset.rid)),
    'restore-pub': () => commit(() => restore('pub')),
    'restore-priv': () => commit(() => restore('priv')),
    'st-box': () => commit(() => {
      const f = findTag(b.closest('.tg').dataset.tid);
      const n = +b.dataset.lvl;
      f.tag.boxes = f.tag.boxes.includes(n) ? f.tag.boxes.filter(x => x !== n) : [...f.tag.boxes, n].sort((x, y) => x - y);
      if (!f.tag.boxes.length) { f.tag.boxes = [n]; removeFound(f); }
    }),
    'st-less': () => commit(() => {
      const f = findTag(b.closest('.tg').dataset.tid);
      const left = f.tag.boxes.map(x => x - 1).filter(x => x >= 1);
      if (left.length) f.tag.boxes = left;
      else removeFound(f);
    }),
    'prog-box': () => commit(() => {
      const pr = entry(b.dataset.rid);
      pr.ticks[+b.dataset.i] = !pr.ticks[+b.dataset.i];
    }),
    'next-round': () => commit(() => {
      S.round += 1;
      clearActed();
    }),
    'new-page': () => commit(() => {
      const pg = mkPage();
      placeRegulars(pg, S.roster);
      S.pages.push(pg);
      S.pageIdx = S.pages.length - 1;
      S.spot = null;
    }),
    'new-hidden-page': () => commit(() => {
      const pg = { ...mkPage(), hidden: true };
      placeRegulars(pg, S.roster);
      S.pages.push(pg);
      S.pageIdx = S.pages.length - 1;
    }),
    'toggle-hidden': () => commit(toggleHidden),
    'tgl-regular': () => commit(() => { r.regular = !r.regular; }),
    'reset-round': () => commit(() => {
      S.round = 0;
      clearActed();
    }),
    'tgl-acted': () => commit(() => { r.acted = !r.acted; }),
    'edit-note': () => {
      if (ev.target.closest('.chip')) return;
      V.editNote = true;
      V.noteDraft = r.note;
      renderTray();
      const ta = trayEl.querySelector('[data-field="note"]');
      if (ta) ta.focus();
    },
    'view-player': () => { window.open(`${location.pathname}?b=${APP.bookId}&as=player`, '_blank'); },
    'copy-link': () => {
      navigator.clipboard.writeText(`${location.origin}${location.pathname}?b=${APP.bookId}`).then(() => {
        V.copied = true;
        renderTray();
        setTimeout(() => { V.copied = false; if (!isPlayer()) renderTray(); }, 2000);
      });
    },
    'go-shelf': () => { location.href = location.pathname; },
    'edit-title': () => {
      if (readOnly()) return;
      inlineEditor({ x: 5, y: 94.4, value: S.title, like: b, onCommit: v => { S.title = v.trim(); } });
    },
    'export': exportBook,
    'import': () => $('file').click(),
  };
  const always = ['prev', 'next-page', 'back-cur', 'go-shelf', 'copy-link', 'view-player', 'export'];
  if (!APP.online && !always.includes(act)) return;
  if (go[act]) go[act]();
});
function stepPage(d) {
  const n = shownIdx() + d;
  if (n < 0 || n >= S.pages.length) return;
  if (isPlayer() || !APP.online) {
    V.peek = n === S.pageIdx ? null : n;
    render();
  } else {
    commit(() => {
      const table = publicPageId();
      S.pageIdx = n;
      // 全桌真的翻到别的页时才收回红点，叙述者进出隐藏页不影响玩家。
      if (!S.pages[n].hidden && S.pages[n].id !== table) S.spot = null;
    });
  }
}
document.addEventListener('keydown', ev => {
  if (V.paint && (ev.key === 'Escape' || ev.key === 'Enter')) { endPaint(); return; }
  if (!isPlayer() || (ev.target.closest && ev.target.closest('input,textarea'))) return;
  if (ev.key === 'ArrowLeft') stepPage(-1);
  if (ev.key === 'ArrowRight') stepPage(1);
});

/* ---------- 备用栏的输入 ---------- */
trayEl.addEventListener('input', ev => {
  const key = ev.target.dataset.field;
  if (key === 'tag') V.draftTag = ev.target.value;
  if (key === 'name') V.draftName = ev.target.value;
  if (key === 'note') {
    V.noteDraft = ev.target.value;
    const r = entry(V.sel);
    if (r) { r.note = V.noteDraft; save(); }
  }
  growAll();
});
function submitField(key, text) {
  const parsed = parseInput(text);
  if (!parsed.length) return;
  if (key === 'tag') V.draftTag = '';
  if (key === 'name') V.draftName = '';
  commit(() => (key === 'tag' ? addTags(parsed) : addNames(parsed)));
}
trayEl.addEventListener('keydown', ev => {
  const key = ev.target.dataset.field;
  if (key !== 'tag' && key !== 'name') return;
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    submitField(key, ev.target.value);
  }
});
trayEl.addEventListener('paste', ev => {
  const key = ev.target.dataset.field;
  if (key !== 'tag' && key !== 'name') return;
  const text = ev.clipboardData.getData('text');
  if (parseInput(text).length > 1) {
    ev.preventDefault();
    submitField(key, text);
  }
});
trayEl.addEventListener('focusout', ev => {
  if (ev.target.dataset.field !== 'note') return;
  const r = entry(V.sel);
  V.editNote = false;
  commit(() => { if (r) ensureNoteProgs(r.note); });
});

/* ---------- 拖放 ---------- */
let D = null;
function point(ev) { return { cx: ev.clientX, cy: ev.clientY }; }
function inside(el, cx, cy) {
  if (!el || el.offsetParent === null) return false;
  const r = el.getBoundingClientRect();
  return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
}
function nameAt(cx, cy, skip) {
  return [...pageEl.querySelectorAll('.name')].find(n => {
    if (n.dataset.nid === skip) return false;
    const r = n.getBoundingClientRect();
    return cx >= r.left - 8 && cx <= r.right + 8 && cy >= r.top - 6 && cy <= r.bottom + 6;
  });
}
// 能挂标签的对象：名字和所有没有等级的普通标签。先看指针是否正对某条标签，再看外层的整组范围。
function ownerAt(cx, cy, skipEl = null) {
  const skip = el => skipEl && (el === skipEl || skipEl.contains(el));
  const near = (el, pad = 6) => {
    const r = el.getBoundingClientRect();
    return cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - 4 && cy <= r.bottom + 4;
  };
  const lines = [...pageEl.querySelectorAll('.tg:not(.lv)')].reverse();
  const line = lines.find(t => !skip(t) && near(t.querySelector('.tl')));
  if (line) return line;
  return [...pageEl.querySelectorAll('.name, .it.tg:not(.lv)')].find(n => !skip(n) && near(n, 8));
}
const ownerOf = el => (el.dataset.nid ? entry(el.dataset.nid) : findTag(el.dataset.tid).tag);
const ownerKey = el => el.dataset.nid || el.dataset.tid;
function statusAt(cx, cy, skipTid) {
  return [...pageEl.querySelectorAll('.tg.lv')].find(t => t.dataset.tid !== skipTid && inside(t.querySelector('.tl'), cx, cy));
}
function ghost(cls, text) {
  const g = h('div', `ghost ${cls}`, text);
  document.body.appendChild(g);
  return g;
}

const BRUSH_STEP = 2.2;
function pageUnits(cx, cy) {
  const r = pageEl.getBoundingClientRect();
  return [((cx - r.left) / r.width) * 300, ((cy - r.top) / r.height) * 200];
}
document.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || readOnly()) return;
  const t = ev.target;
  if (V.paint) {
    if (t.closest('.paintbar') || !inside(pageEl, ev.clientX, ev.clientY)) return;
    const f = paintTag();
    if (!f) { endPaint(); return; }
    const [ux, uy] = pageUnits(ev.clientX, ev.clientY);
    const pt = [+(ux - f.item.x * 3).toFixed(1), +(uy - f.item.y * 2).toFixed(1)];
    f.tag.area = f.tag.area || { c: V.paint.c, s: [] };
    f.tag.area.c = V.paint.c;
    f.tag.area.s.push({ w: V.paint.w, p: [pt] });
    D = { type: 'brush', tag: f.tag, item: f.item, moved: true, sx: ev.clientX, sy: ev.clientY };
    wetStrokeShow(f, f.tag.area.s[f.tag.area.s.length - 1]);
    ev.preventDefault();
    return;
  }
  const rotor = t.closest('.rotor');
  if (rotor) {
    const el = rotor.closest('.it.tg');
    const tl = el.querySelector('.tl');
    const r = tl.getBoundingClientRect();
    D = { type: 'rot', tid: el.dataset.tid, el, px: el.getBoundingClientRect().left, py: r.top + r.height / 2, moved: false, sx: ev.clientX, sy: ev.clientY, rot: 0 };
    return;
  }
  const dot = t.closest('.dot');
  if (dot) {
    if (!isPlayer()) D = { type: 'dot', sx: ev.clientX, sy: ev.clientY, moved: false };
    return;
  }
  if (t.closest('button,input,textarea,.pop')) return;
  const base = { sx: ev.clientX, sy: ev.clientY, moved: false };
  const att = t.closest('.tg.att');
  const it = t.closest('.it');
  const pool = t.closest('.pool .tg');
  const ro = t.closest('.ro');
  const chip = t.closest('.chip');
  if (att) {
    D = { ...base, type: 'att', tid: att.dataset.tid, srcEl: att, text: att.querySelector('.tl').firstChild.textContent, lv: att.classList.contains('lv') };
  } else if (it) {
    const r = it.getBoundingClientRect();
    D = { ...base, type: 'item', iid: it.dataset.iid, el: it, ox: ev.clientX - r.left, oy: ev.clientY - r.top };
  } else if (pool) {
    D = { ...base, type: 'tray', tid: pool.dataset.tid, text: pool.firstChild.textContent, lv: pool.classList.contains('lv') };
  } else if (ro) {
    const e = entry(ro.dataset.rid);
    D = { ...base, type: 'roster', rid: ro.dataset.rid, text: e.text, kind: e.kind };
  } else if (chip) {
    D = { ...base, type: 'chip', text: chip.dataset.text, lv: chip.classList.contains('lv') };
  }
});

function setTarget(cx, cy) {
  pageEl.querySelectorAll('.target').forEach(e => e.classList.remove('target'));
  trayEl.classList.toggle('over', !isPlayer() && (D.type === 'item' || D.type === 'att') && inside(trayEl, cx, cy));
  if (D.type === 'dot') {
    const n = nameAt(cx, cy);
    if (n) n.classList.add('target');
    return;
  }
  const taggish = D.type === 'att' || D.type === 'tray' || D.type === 'chip' || (D.type === 'item' && D.el.classList.contains('tg'));
  if (!taggish) return;
  const selfTid = D.tid || (D.el && D.el.dataset.tid);
  const s = statusAt(cx, cy, selfTid);
  if (s && (D.lv || (D.el && D.el.classList.contains('lv')))) { s.classList.add('target'); return; }
  const n = ownerAt(cx, cy, D.el || D.srcEl || null);
  if (n) n.classList.add('target');
}

document.addEventListener('pointermove', ev => {
  if (!D) return;
  const { cx, cy } = point(ev);
  if (D.type === 'brush') {
    const [ux, uy] = pageUnits(cx, cy);
    const pt = [+(ux - D.item.x * 3).toFixed(1), +(uy - D.item.y * 2).toFixed(1)];
    const st = D.tag.area.s[D.tag.area.s.length - 1];
    const last = st.p[st.p.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= BRUSH_STEP) {
      st.p.push(pt);
      if (!D.raf) D.raf = requestAnimationFrame(() => { if (D) { D.raf = 0; wetStrokeShow(D, st); } });
    }
    return;
  }
  if (D.type === 'rot') {
    D.moved = true;
    const deg = (Math.atan2(cy - D.py, cx - D.px) * 180) / Math.PI;
    D.rot = Math.max(-45, Math.min(45, Math.round(deg / 15) * 15));
    D.el.style.setProperty('--rot', `${D.rot}deg`);
    return;
  }
  if (!D.moved) {
    if (Math.abs(cx - D.sx) + Math.abs(cy - D.sy) < 4) return;
    D.moved = true;
    document.body.classList.add('dragging');
    if (D.type === 'item') {
      D.el.classList.add('moving');
    } else if (D.type === 'dot') {
      D.ghost = ghost('gd', '');
      const real = (S.spot && pageEl.querySelector(`.name[data-nid="${S.spot}"] .dot`)) || pageEl.querySelector('.foot .dot');
      if (real) real.style.visibility = 'hidden';
    } else {
      D.ghost = ghost(`${D.lv ? 'lv' : ''}${D.type === 'roster' && D.kind === 'name' ? ' gn' : ''}`, D.text);
      if (D.type === 'att') {
        if (D.srcEl) D.srcEl.style.visibility = 'hidden';
      }
    }
  }
  if (D.type === 'item') {
    const { x, y } = pagePct(cx - D.ox, cy - D.oy);
    D.el.style.setProperty('--x', x);
    D.el.style.setProperty('--y', y);
    D.el.style.left = '';
    D.el.style.top = '';
    if (D.el.dataset.tid) {
      const ar = pageEl.querySelector(`.area[data-tid="${D.el.dataset.tid}"]`);
      if (ar) ar.style.transform = areaPos({ x, y });
    }
  } else {
    D.ghost.style.left = `${cx + 8}px`;
    D.ghost.style.top = `${cy + 6}px`;
  }
  setTarget(cx, cy);
});

function clampXY(x, y) {
  return { x: Math.min(97, Math.max(0, x)), y: Math.min(95, Math.max(0, y)) };
}
function dropTag(tag, cx, cy, ox = 0, oy = 0, skipEl = null) {
  // 一条标签落下时：落在备用栏就收回，落在状态上就合并，落在名字上就附着，否则留在纸上。
  if (!isPlayer() && inside(trayEl, cx, cy)) {
    S.pages[S.pageIdx].tray.push(tag);
    return true;
  }
  if (!inside(pageEl, cx, cy)) return false;
  if (tag.boxes && !tag.loc && !tag.area) {
    const s = statusAt(cx, cy, tag.id);
    if (s) {
      const f = findTag(s.dataset.tid);
      if (f) { stack(f.tag.boxes, level(tag)); return true; }
    }
  }
  const n = tag.loc || tag.area ? null : ownerAt(cx, cy, skipEl);
  if (n) { attach(ownerOf(n), tag); return true; }
  const { x, y } = clampXY(...Object.values(pagePct(cx - ox, cy - oy)));
  if (tag.loc) cur().items.push({ id: uid(), kind: 'loc', text: tag.text, x, y, born: Date.now() });
  else cur().items.push({ id: uid(), kind: 'tag', tag, x, y, born: Date.now() });
  return true;
}

document.addEventListener('pointerup', ev => {
  if (!D) return;
  const d = D;
  D = null;
  const { cx, cy } = point(ev);
  if (d.type === 'brush') {
    wetStrokeEnd();
    commit(() => {});
    return;
  }
  if (d.type === 'rot') {
    if (d.moved) commit(() => { const f = findTag(d.tid); if (f) f.tag.rot = d.rot; });
    return;
  }
  document.body.classList.remove('dragging');
  trayEl.classList.remove('over');
  pageEl.querySelectorAll('.target').forEach(e => e.classList.remove('target'));
  if (d.ghost) d.ghost.remove();

  if (!d.moved) {
    if (isPlayer()) return;
    const id = d.type === 'item' && d.el.classList.contains('name') ? d.el.dataset.nid : d.type === 'roster' && d.kind === 'name' ? d.rid : null;
    if (id) {
      V.sel = id;
      V.editNote = false;
      pageEl.querySelectorAll('.name').forEach(n => n.classList.toggle('sel', n.dataset.nid === id));
      renderTray();
    }
    return;
  }

  commit(() => {
    const p = cur();
    if (d.type === 'dot') {
      const n = nameAt(cx, cy);
      if (!n) return;
      const prev = S.spot && entry(S.spot);
      if (prev && prev.id !== n.dataset.nid) prev.acted = true;
      S.spot = n.dataset.nid;
      entry(S.spot).acted = false;
    } else if (d.type === 'item') {
      const it = p.items.find(i => i.id === d.iid);
      if (!it) return;
      if (it.kind === 'tag') {
        const others = () => { p.items = p.items.filter(i => i !== it); };
        const n = it.tag.area ? null : ownerAt(cx, cy, d.el);
        const s = it.tag.boxes && !it.tag.area ? statusAt(cx, cy, it.tag.id) : null;
        if (!isPlayer() && inside(trayEl, cx, cy)) { others(); S.pages[S.pageIdx].tray.push(it.tag); return; }
        if (s) { const f = findTag(s.dataset.tid); if (f) { others(); stack(f.tag.boxes, level(it.tag)); return; } }
        if (n) { const o = ownerOf(n); others(); attach(o, it.tag); return; }
      } else if (!isPlayer() && inside(trayEl, cx, cy)) {
        p.items = p.items.filter(i => i !== it);
        if (it.kind === 'loc') S.pages[S.pageIdx].tray.push({ id: uid(), text: it.text, boxes: null, loc: true });
        if (it.kind === 'name' && S.spot === it.ref) S.spot = null;
        return;
      }
      const pos = clampXY(...Object.values(pagePct(cx - d.ox, cy - d.oy)));
      it.x = pos.x;
      it.y = pos.y;
    } else if (d.type === 'att') {
      const f = findTag(d.tid);
      if (!f) return;
      const over = ownerAt(cx, cy, d.srcEl);
      if (over && ownerKey(over) === f.owner.id) return;
      f.owner.attached = f.owner.attached.filter(a => a !== f.tag);
      if (!dropTag(f.tag, cx, cy, 0, 0, d.srcEl)) f.owner.attached.push(f.tag);
    } else if (d.type === 'tray') {
      const pg = S.pages[S.pageIdx];
      const tag = pg.tray.find(t => t.id === d.tid);
      if (!tag || !inside(pageEl, cx, cy)) return;
      pg.tray = pg.tray.filter(t => t !== tag);
      if (!dropTag(tag, cx, cy)) pg.tray.push(tag);
    } else if (d.type === 'roster') {
      if (!inside(pageEl, cx, cy) || onPage(d.rid)) return;
      const { x, y } = clampXY(...Object.values(pagePct(cx, cy)));
      p.items.push({ id: uid(), kind: d.kind, ref: d.rid, x, y, born: Date.now() });
    } else if (d.type === 'chip') {
      if (!inside(pageEl, cx, cy)) return;
      const parsed = classify(clean(d.text));
      if (parsed.kind === 'prog') {
        const r = ensureProg(parsed.text, parsed.cap);
        if (!onPage(r.id)) {
          const { x, y } = clampXY(...Object.values(pagePct(cx, cy)));
          p.items.push({ id: uid(), kind: 'prog', ref: r.id, x, y, born: Date.now() });
        }
      } else {
        dropTag(tagFrom(parsed), cx, cy);
      }
    }
  });
});

/* ---------- 导入导出 ---------- */
function exportBook() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = h('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.title}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
// 带 add 的文件只往当前笔记本里加东西，原有内容不动。同名的名字只补上备注，文件里的页一律先隐藏。
function pageItemFrom(i) {
  const base = { id: uid(), kind: i.kind, x: i.x, y: i.y, born: 0 };
  if (i.kind === 'loc') return { ...base, text: i.text };
  if (i.kind === 'prog') return { ...base, ref: ensureProg(i.text, i.cap).id };
  return { ...base, tag: { id: uid(), boxes: null, ...i.tag } };
}
function addFromFile(data) {
  data.roster.forEach(r => {
    if (r.kind === 'prog') { ensureProg(r.text, r.cap); return; }
    const note = r.note || '';
    let n = S.roster.find(x => x.kind === 'name' && x.text === r.text);
    if (!n) {
      n = mkName(r.text, Boolean(r.regular), note);
      S.roster.push(n);
    } else if (!n.note.includes(note)) {
      n.note = n.note.trim() ? `${n.note}\n${note}` : note;
    }
    ensureNoteProgs(note);
    V.sel = n.id;
  });
  (data.pages || []).forEach(p => {
    const pg = { ...mkPage(), hidden: true };
    pg.tray = (p.tray || []).map(t => tagFrom(classify(t)));
    pg.items = (p.items || []).map(pageItemFrom);
    placeRegulars(pg, S.roster);
    S.pages.push(pg);
    S.pageIdx = S.pages.length - 1;
  });
}
$('file').addEventListener('change', ev => {
  const f = ev.target.files[0];
  if (!f) return;
  f.text().then(text => {
    const data = JSON.parse(text);
    if (data.add && data.roster) {
      const extra = data.pages && data.pages.length ? '新的一页是隐藏的，玩家看不到。' : '';
      if (window.confirm(`把「${data.title || '这份内容'}」加进这个笔记本？${extra}现在的内容不会变。`)) commit(() => addFromFile(data));
      return;
    }
    if (!data.pages || !data.roster) throw new Error('bad file');
    if (window.confirm(`导入「${data.title || '笔记本'}」？这个笔记本现在的内容会替换掉。`)) {
      V.sel = null;
      commit(() => {
        S = { title: S.title, pageIdx: 0, round: 1, spot: null, del: { pub: null, priv: null, page: null }, ...data };
        S.del = { pub: null, priv: null, page: null, ...(data.del || {}) };
        S.roster.forEach(r => { if (r.kind === 'name') r.attached = r.attached || []; });
        S.pages.forEach(p => { p.tray = p.tray || []; p.items = p.items || []; });
      });
    }
  }).catch(() => window.alert('这个文件读不出来，请确认是导出的笔记本文件。'));
  ev.target.value = '';
});

// 工具条不跟随 :hover：鼠标移开以后再留一会儿，点按钮重绘页面时同样不消失。
let toolsTimer = null;
function showTools(tid) {
  if (V.toolsFor === tid) return;
  V.toolsFor = tid;
  pageEl.querySelectorAll('.it.tg').forEach(e => e.classList.toggle('tools-on', e.dataset.tid === tid));
}
document.addEventListener('pointermove', ev => {
  if (D || V.paint) return;
  const e = ev.target.closest && ev.target.closest('.it.tg');
  if (e) {
    clearTimeout(toolsTimer);
    toolsTimer = null;
    showTools(e.dataset.tid);
  } else if (V.toolsFor && !toolsTimer) {
    toolsTimer = setTimeout(() => { toolsTimer = null; showTools(null); }, 1200);
  }
});

let wheelSum = 0;
pageEl.addEventListener('wheel', ev => {
  const e = ev.target.closest('.it.tg');
  if (!e || readOnly() || V.paint) return;
  ev.preventDefault();
  wheelSum += ev.deltaY;
  if (Math.abs(wheelSum) < 60) return;
  const step = wheelSum < 0 ? 1 : -1;
  wheelSum = 0;
  commit(() => resize(e.dataset.tid, step));
}, { passive: false });

window.addEventListener('resize', () => { if (!D) renderPage(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { renderPage(); });
