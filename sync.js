// 灰雾秘典地图的身份和同步。
// 公开内容（纸面，出现在纸上的名字和进度）存在 live/<笔记本>，有链接的人都能读写。
// 私人内容（书架，「这一本」的全部内容，备注，每页的预备标签）存在 mc/<账号>，只有叙述者读得到。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import { getDatabase, ref, get, set, update, onValue } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const params = new URLSearchParams(location.search);
const bookId = params.get('b');
const asPlayer = params.get('as') === 'player';
const deskEl = document.querySelector('.desk');
const shelfEl = $('shelf');
let user = null;

/* ---------- 把数据整理成可以比较的样子 ---------- */
// Firebase 不存空数组和空值，返回的键还会重新排序，所以比较以前先统一。
function canon(v) {
  if (Array.isArray(v)) {
    const a = v.map(canon).filter(x => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach(k => {
      const c = canon(v[k]);
      if (c !== undefined) o[k] = c;
    });
    return Object.keys(o).length ? o : undefined;
  }
  return v === null || v === undefined || v === '' ? undefined : v;
}

function publicOf() {
  const shown = S.pages.filter(p => !p.hidden);
  const placed = new Set();
  shown.forEach(p => p.items.forEach(i => { if (i.ref) placed.add(i.ref); }));
  const held = S.del.pub && S.del.pub.item && S.del.pub.item.ref;
  if (held) placed.add(held);
  const names = {};
  const progs = {};
  S.roster.forEach(r => {
    if (APP.role === 'mc' && !placed.has(r.id)) return;
    if (r.kind === 'name') names[r.id] = { id: r.id, kind: 'name', text: r.text, acted: Boolean(r.acted), attached: r.attached };
    else progs[r.id] = { id: r.id, kind: 'prog', text: r.text, cap: r.cap, ticks: r.ticks };
  });
  const pages = {};
  shown.forEach(p => {
    const items = {};
    p.items.forEach(i => { items[i.id] = i; });
    pages[p.id] = { items };
  });
  S.pubPage = publicPageId();
  return {
    state: { title: S.title, round: S.round, spot: S.spot, pageId: S.pubPage, pageIds: shown.map(p => p.id) },
    pages, names, progs, del: S.del.pub,
  };
}

function flatten(pub) {
  const flat = {};
  const put = (k, v) => {
    const c = canon(v);
    if (c !== undefined) flat[k] = JSON.stringify(c);
  };
  if (!pub) return flat;
  put('state', pub.state);
  put('del', pub.del);
  Object.entries(pub.names || {}).forEach(([id, v]) => put(`names/${id}`, v));
  Object.entries(pub.progs || {}).forEach(([id, v]) => put(`progs/${id}`, v));
  Object.entries(pub.pages || {}).forEach(([pid, p]) => {
    Object.entries((p && p.items) || {}).forEach(([iid, it]) => put(`pages/${pid}/items/${iid}`, it));
  });
  return flat;
}

function privateOf() {
  const trays = {};
  S.pages.forEach(p => { trays[p.id] = p.tray; });
  const hiddenPages = S.pages.filter(p => p.hidden).map(p => ({ id: p.id, items: p.items }));
  return canon({ title: S.title, roster: S.roster, trays, delPriv: S.del.priv, delPage: S.del.page, pageOrder: S.pages.map(p => p.id), hiddenPages }) || {};
}

function normalizeRoster(list) {
  (list || []).forEach(r => {
    if (r.kind === 'name') {
      r.attached = r.attached || [];
      r.note = r.note || '';
      r.regular = Boolean(r.regular);
      r.acted = Boolean(r.acted);
    }
  });
  return list || [];
}

/* ---------- 合并远端的内容 ---------- */
// 远端只有公开的页，所以把隐藏页按原来的前后关系插回去。
function withHidden(shown, before) {
  const out = [...shown];
  before.forEach((p, i) => {
    if (p.hidden) out.splice(i > 0 ? out.findIndex(x => x.id === before[i - 1].id) + 1 : 0, 0, p);
  });
  return out;
}
function applyRemote(val) {
  const v = val || {};
  const st = v.state || {};
  if (st.pageIds && st.pageIds.length) {
    const before = S.pages;
    const here = before[S.pageIdx];
    const old = new Map(before.map(p => [p.id, p]));
    const shown = st.pageIds.filter(id => !(old.get(id) && old.get(id).hidden)).map(id => {
      const items = Object.values((v.pages && v.pages[id] && v.pages[id].items) || {});
      items.sort((a, b) => (a.born || 0) - (b.born || 0) || (a.id < b.id ? -1 : 1));
      return { id, tray: (old.get(id) && old.get(id).tray) || [], items };
    });
    S.pages = APP.role === 'mc' ? withHidden(shown, before) : shown;
    S.pubPage = st.pageId;
    // 叙述者留在隐藏页上准备时，不跟着公开的页走。
    const stay = here && here.hidden ? S.pages.indexOf(here) : -1;
    S.pageIdx = stay >= 0 ? stay : Math.max(0, S.pages.findIndex(p => p.id === st.pageId));
  }
  S.pageIdx = Math.max(0, S.pageIdx);
  S.title = st.title || S.title;
  S.round = st.round ?? 1;
  S.spot = st.spot || null;
  S.del.pub = v.del || null;
  const names = v.names || {};
  const progs = v.progs || {};
  if (APP.role === 'mc') {
    S.roster.forEach(r => {
      if (r.kind === 'name' && names[r.id]) {
        r.text = names[r.id].text;
        r.acted = Boolean(names[r.id].acted);
        r.attached = names[r.id].attached || [];
      }
      if (r.kind === 'prog' && progs[r.id]) {
        r.text = progs[r.id].text;
        r.ticks = progs[r.id].ticks || r.ticks;
      }
    });
  } else {
    S.roster = normalizeRoster([...Object.values(names), ...Object.values(progs)]);
    if (V.peek !== null && V.peek >= S.pages.length) V.peek = null;
  }
}

/* ---------- 打开一个笔记本 ---------- */
let lastFlat = {};
let pending = null;
let privTimer = null;
let lastHidden = '';
const hiddenKey = () => S.pages.filter(p => p.hidden).map(p => p.id).join();
const busy = () => Boolean(D) || Boolean(pageEl.querySelector('.inl'));

function pushNow() {
  const flat = flatten(publicOf());
  const upd = {};
  new Set([...Object.keys(flat), ...Object.keys(lastFlat)]).forEach(k => {
    if (flat[k] !== lastFlat[k]) upd[`live/${bookId}/${k}`] = flat[k] === undefined ? null : JSON.parse(flat[k]);
  });
  lastFlat = flat;
  // 隐藏或者放出一页时，公开和私人两边要一起写，中途断线也不会丢掉这一页。
  let privDone = false;
  if (APP.role === 'mc' && user && hiddenKey() !== lastHidden) {
    lastHidden = hiddenKey();
    upd[`mc/${user.uid}/books/${bookId}`] = privateOf();
    clearTimeout(privTimer);
    privTimer = null;
    privDone = true;
  }
  if (Object.keys(upd).length) {
    update(ref(db), upd).catch(e => console.error('写入失败', e.code || e.message));
  }
  if (APP.role === 'mc' && !privDone) schedulePrivate();
}
function schedulePrivate() {
  clearTimeout(privTimer);
  privTimer = setTimeout(flushPrivate, 300);
}
function flushPrivate() {
  clearTimeout(privTimer);
  privTimer = null;
  if (APP.role !== 'mc' || !user) return;
  update(ref(db), {
    [`mc/${user.uid}/books/${bookId}`]: privateOf(),
    [`mc/${user.uid}/shelf/${bookId}/title`]: S.title,
  }).catch(e => console.error('私人内容写入失败', e.code || e.message));
}
window.addEventListener('pagehide', () => { if (privTimer) flushPrivate(); });

function takeRemote(val) {
  applyRemote(val);
  lastFlat = flatten(val || {});
  if (APP.role === 'mc') {
    // 玩家移除名字以后，名字要退回私人区域，所以叙述者这边再比较一次。
    const flat = flatten(publicOf());
    if (Object.keys({ ...flat, ...lastFlat }).some(k => flat[k] !== lastFlat[k])) pushNow();
  }
  render();
}

function showDesk() {
  shelfEl.hidden = true;
  deskEl.hidden = false;
}
function message(text) {
  deskEl.hidden = true;
  shelfEl.hidden = false;
  shelfEl.replaceChildren();
  shelfEl.appendChild(h('h1', 'sh-title', '灰雾秘典'));
  shelfEl.appendChild(h('p', 'sh-note', text));
}

async function openBook(role) {
  APP.role = role;
  APP.bookId = bookId;
  S = blankBook();
  S.pages = [];
  if (role === 'mc') {
    const snap = await get(ref(db, `mc/${user.uid}/books/${bookId}`));
    const priv = snap.val() || {};
    S.title = priv.title || S.title;
    S.roster = normalizeRoster(priv.roster);
    const trays = priv.trays || {};
    const hid = new Map((priv.hiddenPages || []).map(p => [p.id, p]));
    S.pages = (priv.pageOrder || Object.keys(trays)).map(id => (
      hid.has(id) ? { id, hidden: true, tray: trays[id] || [], items: hid.get(id).items || [] } : { id, tray: trays[id] || [], items: [] }
    ));
    S.pageIdx = -1;
    lastHidden = hiddenKey();
    S.del.priv = priv.delPriv || null;
    S.del.page = priv.delPage || null;
  }
  let first = true;
  onValue(ref(db, `live/${bookId}`), snap => {
    const val = snap.val();
    if (first) {
      first = false;
      if (!val && role !== 'mc') {
        message('这个笔记本还是空的，请向叙述者确认链接。');
        return;
      }
      if (!S.pages.length) S.pages = [mkPage()];
      showDesk();
      takeRemote(val);
      return;
    }
    if (busy()) { pending = val; return; }
    pending = null;
    takeRemote(val);
  }, () => {
    message('没有这个笔记本，请向叙述者确认链接。');
  });
  setInterval(() => {
    if (pending !== null && !busy()) {
      const p = pending;
      pending = null;
      takeRemote(p);
    }
  }, 250);
  let seen = false;
  onValue(ref(db, '.info/connected'), snap => {
    if (snap.val()) {
      seen = true;
      if (!APP.online) { APP.online = true; render(); }
    } else if (seen && APP.online) {
      APP.online = false;
      render();
    }
  });
  window.HW_push = pushNow;
  if (role !== 'mc' && !asPlayer) addLoginCorner();
}

function addLoginCorner() {
  const b = h('button', 'back', '叙述者登录');
  b.type = 'button';
  b.addEventListener('click', () => login().then(() => location.reload()).catch(() => {}));
  document.body.appendChild(b);
}

/* ---------- 登录 ---------- */
async function login() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw e;
  }
}

/* ---------- 书架 ---------- */
function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function createBook(title) {
  const id = randomId();
  const page = mkPage();
  await set(ref(db, `books/${id}`), { owner: user.uid, created: Date.now() });
  await update(ref(db), {
    [`mc/${user.uid}/shelf/${id}`]: { title, created: Date.now() },
    [`mc/${user.uid}/books/${id}`]: { title },
  });
  await set(ref(db, `live/${id}/state`), { title, round: 1, pageId: page.id, pageIds: [page.id] });
  location.href = `${location.pathname}?b=${id}`;
}
async function deleteBook(id) {
  await update(ref(db), {
    [`live/${id}/state`]: null,
    [`live/${id}/pages`]: null,
    [`live/${id}/names`]: null,
    [`live/${id}/progs`]: null,
    [`live/${id}/del`]: null,
    [`mc/${user.uid}/books/${id}`]: null,
    [`mc/${user.uid}/shelf/${id}`]: null,
  });
  await set(ref(db, `books/${id}`), null);
}

function showSignIn(note) {
  deskEl.hidden = true;
  shelfEl.hidden = false;
  shelfEl.replaceChildren();
  shelfEl.appendChild(h('h1', 'sh-title', '灰雾秘典'));
  const b = h('button', 'sh-btn', '用 Google 登录');
  b.type = 'button';
  const err = h('p', 'sh-err');
  b.addEventListener('click', () => {
    err.textContent = '';
    login().catch(e => {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') err.textContent = `登录没有成功（${e.code || e.message}）。`;
    });
  });
  shelfEl.appendChild(b);
  shelfEl.appendChild(err);
  shelfEl.appendChild(h('p', 'sh-note', note || '叙述者在这里登录。玩家请打开叙述者发的链接，不用登录。'));
}

async function showShelf() {
  deskEl.hidden = true;
  shelfEl.hidden = false;
  let list;
  try {
    const snap = await get(ref(db, `mc/${user.uid}/shelf`));
    list = snap.val() || {};
  } catch (e) {
    shelfEl.replaceChildren();
    shelfEl.appendChild(h('h1', 'sh-title', '灰雾秘典'));
    shelfEl.appendChild(h('p', 'sh-note', '这个 Google 账号不是叙述者账号。'));
    const out = h('button', 'sh-link', '换一个账号');
    out.type = 'button';
    out.addEventListener('click', () => signOut(auth));
    shelfEl.appendChild(out);
    return;
  }
  shelfEl.replaceChildren();
  shelfEl.appendChild(h('h1', 'sh-title', '灰雾秘典'));
  const ul = h('ul', 'sh-list');
  Object.entries(list)
    .sort((a, b) => (b[1].created || 0) - (a[1].created || 0))
    .forEach(([id, book]) => {
      const li = h('li', 'sh-row');
      const a = h('a', 'sh-name', book.title || '未命名');
      a.href = `${location.pathname}?b=${id}`;
      li.appendChild(a);
      const copy = h('button', 'sh-link', '复制玩家链接');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(`${location.origin}${location.pathname}?b=${id}`).then(() => {
          copy.textContent = '已复制';
          setTimeout(() => { copy.textContent = '复制玩家链接'; }, 2000);
        });
      });
      li.appendChild(copy);
      const del = h('button', 'sh-link', '删除');
      del.type = 'button';
      del.addEventListener('click', () => {
        if (window.confirm(`删除笔记本「${book.title || '未命名'}」？这个操作无法还原。`)) deleteBook(id).then(showShelf);
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
  if (Object.keys(list).length) shelfEl.appendChild(ul);
  const form = h('form', 'sh-new');
  const inp = h('input', 'sh-input');
  inp.placeholder = '写新笔记本的名字，按回车';
  inp.setAttribute('aria-label', '新笔记本的名字');
  form.appendChild(inp);
  const err = h('p', 'sh-err');
  form.appendChild(err);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const title = inp.value.trim();
    if (!title) { err.textContent = '先写下笔记本的名字。'; return; }
    inp.disabled = true;
    createBook(title).catch(e => {
      inp.disabled = false;
      err.textContent = `没有建成（${e.code || e.message}）。`;
    });
  });
  shelfEl.appendChild(form);
  const out = h('button', 'sh-link sh-out', '退出登录');
  out.type = 'button';
  out.addEventListener('click', () => signOut(auth));
  shelfEl.appendChild(out);
}

/* ---------- 开始 ---------- */
let opened = false;
onAuthStateChanged(auth, async u => {
  user = u;
  if (!bookId) {
    if (u) await showShelf();
    else showSignIn();
    return;
  }
  if (opened) return;
  opened = true;
  let role = 'player';
  if (u && !asPlayer) {
    try {
      const own = await get(ref(db, `mc/${u.uid}/shelf/${bookId}`));
      if (own.exists()) role = 'mc';
    } catch (e) { /* 这个账号读不了私人区域，就当玩家 */ }
  }
  openBook(role).catch(e => {
    console.error(e);
    message('打开失败，请刷新页面再试一次。');
  });
});
