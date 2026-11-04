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
function removeFound(found) {
  if (found.item) {
    S.del.pub = { type: 'item', label: label(found.tag), pageId: cur().id, item: found.item };
    cur().items = cur().items.filter(i => i !== found.item);
  } else {
    S.del.pub = { type: 'att', label: label(found.tag), nid: found.owner.id, tag: found.tag };
    found.owner.attached = found.owner.attached.filter(a => a !== found.tag);
  }
}
function deleteItem(iid) {
  const it = cur().items.find(i => i.id === iid);
  if (!it) return;
  const text = it.kind === 'tag' ? label(it.tag) : it.kind === 'loc' ? it.text : (entry(it.ref) || {}).text || '';
  S.del.pub = { type: 'item', label: text, pageId: cur().id, item: it };
  cur().items = cur().items.filter(i => i !== it);
  if (it.kind === 'name' && S.spot === it.ref) S.spot = null;
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
  if (S.pages.length < 2) return;
  const i = S.pageIdx;
  const [page] = S.pages.splice(i, 1);
  S.del.page = { label: `第 ${i + 1} 页`, page, idx: i };
  S.pageIdx = Math.max(0, i - 1);
  S.spot = null;
}
function restorePage() {
  const d = S.del.page;
  if (!d) return;
  S.pages.splice(d.idx, 0, d.page);
  S.pageIdx = d.idx;
  S.del.page = null;
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
function itemEl(it) {
  let e;
  if (it.kind === 'tag') {
    e = h('div', `it tg${it.tag.boxes ? ' lv' : ''}`);
    e.dataset.tid = it.tag.id;
    const tl = h('span', 'tl', label(it.tag));
    if (!readOnly()) {
      if (it.tag.boxes) tl.appendChild(statusPop(it.tag));
      tl.appendChild(btn('x', 'del-item', '×', { 'data-iid': it.id, 'aria-label': '删除' }));
      if (!it.tag.boxes) tl.appendChild(btn('add', 'add-kid', '+', { 'aria-label': `给 ${it.tag.text} 挂一条标签` }));
    }
    inkify(tl, it.born);
    e.appendChild(tl);
    if (hasKids(it.tag)) e.appendChild(kidsEl(it.tag));
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
    if (S.spot === r.id) e.appendChild(h('span', 'dot'));
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
  pageEl.innerHTML = '';
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
  if (!(S.spot && onPage(S.spot)) && !isPlayer()) round.appendChild(h('span', 'dot'));
  round.appendChild(h('span', '', `第 ${S.round} 轮`));
  foot.appendChild(round);
  pageEl.appendChild(foot);

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
  const less = h('div', 'less-row');
  if (S.pages.length > 1) less.appendChild(btn('', 'del-page', '删除这一页'));
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
      S.spot = null;
      S.roster.forEach(x => { if (x.kind === 'name') x.acted = false; });
    }),
    'new-page': () => commit(() => {
      const pg = mkPage();
      placeRegulars(pg, S.roster);
      S.pages.push(pg);
      S.pageIdx = S.pages.length - 1;
      S.spot = null;
    }),
    'tgl-regular': () => commit(() => { r.regular = !r.regular; }),
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
    commit(() => { S.pageIdx = n; S.spot = null; });
  }
}
document.addEventListener('keydown', ev => {
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

document.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || readOnly()) return;
  const t = ev.target;
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
  if (tag.boxes && !tag.loc) {
    const s = statusAt(cx, cy, tag.id);
    if (s) {
      const f = findTag(s.dataset.tid);
      if (f) { stack(f.tag.boxes, level(tag)); return true; }
    }
  }
  const n = tag.loc ? null : ownerAt(cx, cy, skipEl);
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
        const n = ownerAt(cx, cy, d.el);
        const s = it.tag.boxes ? statusAt(cx, cy, it.tag.id) : null;
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
$('file').addEventListener('change', ev => {
  const f = ev.target.files[0];
  if (!f) return;
  f.text().then(text => {
    const data = JSON.parse(text);
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

window.addEventListener('resize', () => { if (!D) renderPage(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { renderPage(); });
