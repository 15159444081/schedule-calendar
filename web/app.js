'use strict';

/* ============ 基础工具 ============ */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const WK_ORDER = ['一', '二', '三', '四', '五', '六', '日'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mondayOf(d) {
  const x = new Date(d);
  const off = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - off);
  x.setHours(0, 0, 0, 0);
  return x;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(w)}`;
}
function isoWeekToMonday(iso) {
  const [y, w] = iso.split('-W').map(Number);
  const mondayW1 = mondayOf(new Date(y, 0, 4));
  return addDays(mondayW1, (w - 1) * 7);
}
const shortIso = (iso) => iso.slice(5);           // 2026-W43 -> W43
const H0 = 6, H1 = 24, PX = 44;                   // 时间轴：6:00 - 24:00，每小时 44px
const toTop = (t) => {
  const [h, m] = t.split(':').map(Number);
  return Math.max(0, (h + m / 60 - H0) * PX);
};
const toHeight = (s, e) => {
  const [sh, sm] = s.split(':').map(Number), [eh, em] = e.split(':').map(Number);
  return Math.max(20, ((eh + em / 60) - (sh + sm / 60)) * PX - 3);
};

const TAG_COLORS = ['#2d5f8b', '#4a7c59', '#8b5e34', '#6b4f8b', '#8b4a5e', '#3f7a7a'];
const tagColor = (tags) => {
  if (!tags || !tags.length) return null;
  let h = 0;
  for (const c of tags.join('')) h = (h * 31 + c.charCodeAt(0)) % 997;
  return TAG_COLORS[h % TAG_COLORS.length];
};

/* ============ 状态 ============ */
const state = {
  view: 'month',
  cursor: new Date(),
  days: {},
  months: {},
  weeks: {},
  today: ymd(new Date()),
  editing: null,
  loading: false,
};

const status = (t) => { $('#status').textContent = t || ''; };

/* ============ 数据 ============ */
function rangeFor() {
  const c = state.cursor;
  if (state.view === 'month') {
    const start = mondayOf(new Date(c.getFullYear(), c.getMonth(), 1));
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
    let end = addDays(mondayOf(last), 6);
    return { from: ymd(start), to: ymd(end) };
  }
  if (state.view === 'week') {
    const start = mondayOf(c);
    return { from: ymd(start), to: ymd(addDays(start, 6)) };
  }
  const start = mondayOf(c);
  return { from: ymd(start), to: ymd(addDays(start, 6)) };
}

async function load(silent) {
  if (state.loading) return;
  state.loading = true;
  if (!silent) status('读取中…');
  try {
    const { from, to } = rangeFor();
    const r = await fetch(`/api/range?from=${from}&to=${to}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    state.days = j.days;
    state.months = j.months;
    state.weeks = j.weeks;
    state.today = j.today;
    render();
    status('已同步 ' + new Date().toTimeString().slice(0, 5));
  } catch (e) {
    status('连接失败');
    $('#main').innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">
      读不到数据服务。<br>确认 server.py 还在运行，然后刷新页面。</div>`;
  } finally {
    state.loading = false;
  }
}

async function saveDay(date) {
  const d = state.days[date] || { date, events: [], todos: [] };
  d.date = date;
  try {
    const r = await fetch('/api/day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, events: d.events, todos: d.todos }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save failed');
    state.days[date] = j.day;
    status('已保存');
    render();
  } catch (e) {
    status('保存失败');
    alert('保存失败：' + e.message);
  }
}

/* ============ 渲染入口 ============ */
function planBar(groups) {
  const parts = [];
  for (const [label, items] of groups) {
    if (!items || !items.length) continue;
    parts.push(`<span class="k">${esc(label)}</span><span class="grp">${items.map((g) =>
      `<span class="g ${g.done ? 'done' : ''}">· ${esc(g.text)}</span>`).join('')}</span>`);
  }
  return parts.length ? `<div class="goals">${parts.join('')}</div>` : '';
}

function render() {
  document.querySelectorAll('#view-switch button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === state.view);
  });
  if (state.view === 'month') renderMonth();
  else if (state.view === 'week') renderWeek();
  else renderDay();
}

/* ============ 月视图 ============ */
function renderMonth() {
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
  $('#title').textContent = `${y} 年 ${m + 1} 月`;

  const first = new Date(y, m, 1);
  let cur = mondayOf(first);
  const last = new Date(y, m + 1, 0);
  const cells = [];
  while (cur <= last) { cells.push(new Date(cur)); cur = addDays(cur, 1); }
  while (cells.length % 7 !== 0) { cells.push(new Date(cur)); cur = addDays(cur, 1); }

  const mk = `${y}-${pad(m + 1)}`;
  const monthPlan = state.months[mk];
  const goals = planBar([
    ['本月目标', monthPlan && monthPlan.goals],
    ['关键节点', monthPlan && monthPlan.milestones],
  ]);

  const head = `<div class="weekday-row">${WK_ORDER.map((w) => `<div>周${w}</div>`).join('')}</div>`;

  const body = cells.map((d) => {
    const ds = ymd(d);
    const out = d.getMonth() !== m;
    const isToday = ds === state.today;
    const isMon = d.getDay() === 1;
    const day = state.days[ds] || { events: [], todos: [] };
    const evs = (day.events || []).slice(0, 3).map((e) => {
      const c = tagColor(e.tags);
      const time = e.allday ? '全天' : e.start;
      return `<div class="ev" style="${c ? `border-left:2px solid ${c};padding-left:5px` : ''}">
        <time>${esc(time)}</time><span class="t">${esc(e.title)}</span></div>`;
    }).join('');
    const more = (day.events || []).length > 3
      ? `<div class="more">+${day.events.length - 3}</div>` : '';
    const open = (day.todos || []).filter((t) => !t.done).length;
    const dots = open ? `<div class="dots">${'<i class="dot warn"></i>'.repeat(Math.min(open, 4))}</div>` : '';
    return `<div class="cell ${out ? 'out' : ''} ${isToday ? 'today' : ''}" data-date="${ds}">
      <div class="cell-head">
        <span class="dnum">${d.getDate()}</span>
        ${isMon ? `<span class="wnum" data-week="${isoWeek(d)}" title="${isoWeek(d)} 这一周">${parseInt(isoWeek(d).slice(-2), 10)}周</span>` : ''}
      </div>
      ${evs}${more}${dots}
    </div>`;
  }).join('');

  $('#main').innerHTML = goals + head + `<div class="grid">${body}</div>`;
}

/* ============ 周视图 ============ */
function renderWeek() {
  const start = mondayOf(state.cursor);
  const iso = isoWeek(start);
  const weekNum = parseInt(iso.slice(-2), 10);
  const endDay = addDays(start, 6);
  const sameYear = start.getFullYear() === endDay.getFullYear();
  const range = sameYear
    ? `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日 – ${endDay.getMonth() + 1} 月 ${endDay.getDate()} 日`
    : `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()} – ${endDay.getFullYear()}/${endDay.getMonth() + 1}/${endDay.getDate()}`;
  $('#title').textContent = `第 ${weekNum} 周 · ${range}`;

  const plan = state.weeks[iso];
  const goals = planBar([['本周重点', plan && plan.goals]]);

  const hours = [];
  for (let h = H0; h < H1; h++) hours.push(`<div>${pad(h)}:00</div>`);

  const heads = [];
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const ds = ymd(d);
    const isToday = ds === state.today;
    heads.push(`<div class="wcol-head ${isToday ? 'today' : ''}" data-date="${ds}">
      <span>周${WK[d.getDay()]}</span><b>${d.getDate()}</b></div>`);

    const day = state.days[ds] || { events: [] };
    const blocks = (day.events || []).map((e, idx) => {
      const c = tagColor(e.tags);
      if (e.allday) return '';
      const top = toTop(e.start), h = toHeight(e.start, e.end);
      return `<div class="evblock" style="top:${top}px;height:${h}px;${c ? `border-left-color:${c}` : ''}"
        data-date="${ds}" data-idx="${idx}">
        <div class="et">${esc(e.title)}</div>
        <div class="eh">${esc(e.start)}–${esc(e.end)}</div></div>`;
    }).join('');
    const allday = (day.events || []).filter((e) => e.allday)
      .map((e) => `<div style="font-size:10.5px;padding:1px 5px;color:var(--accent)">● ${esc(e.title)}</div>`).join('');
    cols.push(`<div class="day-col ${isToday ? 'today' : ''}" data-date="${ds}" style="height:${(H1 - H0) * PX}px">
      ${allday}${blocks}</div>`);
  }

  $('#main').innerHTML = goals + `<div class="week-scroll">
    <div class="week-grid">
      <div class="wcol-head" style="border-left:0"></div>
      ${heads.join('')}
      <div class="time-col">${hours.join('')}</div>
      ${cols.join('')}
    </div></div>`;
}

/* ============ 日视图 ============ */
function renderDay() {
  const ds = ymd(state.cursor);
  const d = state.cursor;
  $('#title').textContent = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WK[d.getDay()]} · 第 ${parseInt(isoWeek(d).slice(-2), 10)} 周`;

  const day = state.days[ds] || { date: ds, events: [], todos: [] };
  const iso = isoWeek(d);
  const ym = ds.slice(0, 7);
  const plan = state.weeks[iso];
  const monthPlan = state.months[ym];

  const hours = [];
  for (let h = H0; h < H1; h++) hours.push(`<div>${pad(h)}:00</div>`);

  const blocks = (day.events || []).map((e, idx) => {
    const c = tagColor(e.tags);
    if (e.allday) return '';
    return `<div class="evblock" style="top:${toTop(e.start)}px;height:${toHeight(e.start, e.end)}px;left:6px;right:6px;${c ? `border-left-color:${c}` : ''}"
      data-date="${ds}" data-idx="${idx}">
      <div class="et">${esc(e.title)}</div><div class="eh">${esc(e.start)}–${esc(e.end)}</div></div>`;
  }).join('');

  const allday = (day.events || []).filter((e) => e.allday)
    .map((e, i) => `<div class="todo" data-toggle-allday="${i}"><span class="box">◆</span>
      <span class="txt">${esc(e.title)}</span></div>`).join('');

  const todos = (day.todos || []).map((t, i) =>
    `<div class="todo ${t.done ? 'done' : ''}" data-todo="${i}">
      <span class="box">${t.done ? '✓' : ''}</span><span class="txt">${esc(t.text)}</span></div>`).join('')
    || '<div class="side-note">还没有待办。点这里新增 ↓</div>';

  const weekGoals = plan && plan.goals.length
    ? plan.goals.map((g) => `<div class="todo ${g.done ? 'done' : ''}"><span class="box"></span>
        <span class="txt">${esc(g.text)}</span></div>`).join('')
    : '<div class="side-note">本周还没有重点</div>';

  const monthGoals = monthPlan && monthPlan.goals.length
    ? monthPlan.goals.map((g) => `<div class="todo ${g.done ? 'done' : ''}"><span class="box"></span>
        <span class="txt">${esc(g.text)}</span></div>`).join('')
    : '<div class="side-note">本月还没有目标</div>';

  $('#main').innerHTML = `<div class="day-wrap">
    <div class="day-main">
      <div class="week-grid" style="grid-template-columns:54px 1fr;min-width:0">
        <div class="wcol-head" style="border-left:0">时间</div>
        <div class="wcol-head">${ds} 周${WK[d.getDay()]}</div>
        <div class="time-col">${hours.join('')}</div>
        <div class="day-col" data-date="${ds}" style="height:${(H1 - H0) * PX}px">${blocks}</div>
      </div>
    </div>
    <div class="day-side">
      <div class="side-sec"><h3>全天</h3>${allday || '<div class="side-note">—</div>'}</div>
      <div class="side-sec"><h3>待办</h3>${todos}</div>
      <div class="side-sec"><h3>本周重点</h3>${weekGoals}</div>
      <div class="side-sec"><h3>本月目标</h3>${monthGoals}</div>
    </div>
  </div>`;
}

/* ============ 弹窗 ============ */
function openEditor(date, ev, idx) {
  state.editing = { date, idx: idx ?? -1, ev: ev || null };
  $('#modal-title').textContent = ev ? '编辑日程' : '新建日程';
  $('#ev-title').value = ev ? ev.title : '';
  $('#ev-start').value = ev ? (ev.start || '09:00') : '09:00';
  $('#ev-end').value = ev ? (ev.end || '10:00') : '10:00';
  $('#ev-tags').value = ev ? (ev.tags || []).join(' ') : '';
  $('#ev-allday').checked = !!(ev && ev.allday);
  $('#btn-del').hidden = !ev;
  $('#modal').hidden = false;
  setTimeout(() => $('#ev-title').focus(), 30);
}

function closeEditor() {
  $('#modal').hidden = true;
  state.editing = null;
}

async function submitEditor() {
  const ed = state.editing;
  if (!ed) return;
  const title = $('#ev-title').value.trim();
  if (!title) { $('#ev-title').focus(); return; }
  const date = ed.date;
  const day = state.days[date] || (state.days[date] = { date, events: [], todos: [] });
  const allday = $('#ev-allday').checked;
  const item = {
    title,
    start: allday ? '' : ($('#ev-start').value || '09:00'),
    end: allday ? '' : ($('#ev-end').value || '10:00'),
    tags: $('#ev-tags').value.split(/[\s,，]+/).filter(Boolean),
    allday,
  };
  if (ed.idx >= 0) day.events[ed.idx] = item;
  else day.events.push(item);
  day.events.sort((a, b) => (a.allday ? -1 : a.start).localeCompare(b.allday ? '-1' : b.start));
  closeEditor();
  await saveDay(date);
}

async function deleteEvent() {
  const ed = state.editing;
  if (!ed || ed.idx < 0) return;
  const day = state.days[ed.date];
  if (!day) return;
  day.events.splice(ed.idx, 1);
  closeEditor();
  await saveDay(ed.date);
}

/* ============ 搜索 ============ */
let searchTimer = null;

function initSearch() {
  const inp = $('#search');
  const box = $('#results');
  inp.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = inp.value.trim();
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    searchTimer = setTimeout(() => doSearch(q), 280);
  });
  inp.addEventListener('focus', () => {
    if (box.innerHTML && inp.value.trim()) box.hidden = false;
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { box.hidden = true; inp.blur(); }
    else if (e.key === 'Enter') {
      const first = box.querySelector('.r');
      if (first) first.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.searchbox')) box.hidden = true;
  });
}

function weekRangeText(iso) {
  const mon = isoWeekToMonday(iso);
  const sun = addDays(mon, 6);
  return `${mon.getMonth() + 1}/${mon.getDate()}–${sun.getMonth() + 1}/${sun.getDate()}`;
}

async function doSearch(q) {
  const box = $('#results');
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
    const j = await r.json();
    if (!j.results || !j.results.length) {
      box.innerHTML = '<div class="empty">没找到</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = j.results.map((it) => {
      const yr = it.id.slice(0, 4);
      const label = it.kind === 'day' ? it.id
        : it.kind === 'week'
          ? `${yr} 第 ${parseInt(it.id.slice(-2), 10)} 周 · ${weekRangeText(it.id)}`
          : `${yr} 年 ${parseInt(it.id.slice(5), 10)} 月`;
      const sub = (it.hits || []).join(' · ');
      return `<div class="r" data-kind="${it.kind}" data-id="${it.id}">
        <div class="rid">${esc(label)}</div>${sub ? `<div class="rh">${esc(sub)}</div>` : ''}</div>`;
    }).join('');
    box.hidden = false;
    box.querySelectorAll('.r').forEach((el) => {
      el.onclick = () => jumpTo(el.dataset.kind, el.dataset.id);
    });
  } catch (e) {
    box.innerHTML = '<div class="empty">搜索失败</div>';
    box.hidden = false;
  }
}

async function showPhone() {
  try {
    const j = await (await fetch('/api/ping', { cache: 'no-store' })).json();
    $('#phone-url').textContent = `http://${j.lan}:${j.port}`;
    $('#phone-note').textContent =
      '首次访问要用用户名和密码（在程序目录 auth.json 里）。手机和电脑必须连同一个 WiFi。';
    $('#phone-panel').hidden = false;
  } catch (e) {
    alert('读不到服务地址，确认服务还在跑');
  }
}

function jumpTo(kind, id) {
  $('#results').hidden = true;
  $('#search').value = '';
  if (kind === 'day') {
    state.view = 'day';
    state.cursor = parseYmd(id);
  } else if (kind === 'week') {
    state.view = 'week';
    state.cursor = isoWeekToMonday(id);
  } else {
    state.view = 'month';
    const [y, m] = id.split('-').map(Number);
    state.cursor = new Date(y, m - 1, 1);
  }
  load();
}

/* ============ 交互绑定 ============ */
function bindStatic() {
  $('#btn-prev').onclick = () => {
    if (state.view === 'month') state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1);
    else if (state.view === 'week') state.cursor = addDays(state.cursor, -7);
    else state.cursor = addDays(state.cursor, -1);
    load();
  };
  $('#btn-next').onclick = () => {
    if (state.view === 'month') state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1);
    else if (state.view === 'week') state.cursor = addDays(state.cursor, 7);
    else state.cursor = addDays(state.cursor, 1);
    load();
  };
  $('#btn-today').onclick = () => { state.cursor = new Date(); load(); };
  document.querySelectorAll('#view-switch button').forEach((b) => {
    b.onclick = () => { state.view = b.dataset.view; load(); };
  });
  $('#btn-close').onclick = closeEditor;
  $('#btn-cancel').onclick = closeEditor;
  $('#btn-save').onclick = submitEditor;
  $('#btn-del').onclick = deleteEvent;
  $('#btn-phone').onclick = showPhone;
  $('#btn-phone-close').onclick = () => { $('#phone-panel').hidden = true; };
  $('#phone-panel').onclick = (e) => { if (e.target.id === 'phone-panel') $('#phone-panel').hidden = true; };
  $('#btn-copy').onclick = async () => {
    const url = $('#phone-url').textContent;
    try {
      await navigator.clipboard.writeText(url);
      $('#btn-copy').textContent = '已复制';
      setTimeout(() => { $('#btn-copy').textContent = '复制地址'; }, 1500);
    } catch (e) {
      const r = document.createRange();
      r.selectNodeContents($('#phone-url'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('copy');
    }
  };
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeEditor(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if (e.key === 'Enter' && !$('#modal').hidden) submitEditor();
  });
}

function bindMain() {
  $('#main').addEventListener('click', (e) => {
    const wn = e.target.closest('.wnum');
    if (wn) {
      e.stopPropagation();
      state.view = 'week';
      state.cursor = parseYmd(wn.closest('.cell').dataset.date);
      load();
      return;
    }
    const block = e.target.closest('.evblock');
    if (block) {
      e.stopPropagation();
      const date = block.dataset.date;
      const idx = Number(block.dataset.idx);
      openEditor(date, state.days[date].events[idx], idx);
      return;
    }
    const whead = e.target.closest('.wcol-head[data-date]');
    if (whead) {
      state.view = 'day';
      state.cursor = parseYmd(whead.dataset.date);
      load();
      return;
    }
    const todo = e.target.closest('[data-todo]');
    if (todo) {
      const ds = ymd(state.cursor);
      const day = state.days[ds];
      const i = Number(todo.dataset.todo);
      if (day && day.todos[i]) { day.todos[i].done = !day.todos[i].done; saveDay(ds); }
      return;
    }
    const cell = e.target.closest('.cell');
    if (cell) {
      state.view = 'day';
      state.cursor = parseYmd(cell.dataset.date);
      load();
      return;
    }
    const col = e.target.closest('.day-col[data-date]');
    if (col) {
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const h = Math.floor(y / PX) + H0;
      const m = Math.floor(((y % PX) / PX) * 4) * 15;
      const start = `${pad(Math.min(h, 23))}:${pad(m)}`;
      const end = `${pad(Math.min(h + 1, 23))}:${pad(m)}`;
      openEditor(col.dataset.date, { title: '', start, end, tags: [], allday: false }, -1);
    }
  });
}

/* ============ 启动 ============ */
bindStatic();
bindMain();
initSearch();
load();
setInterval(() => { if ($('#modal').hidden && !document.hidden) load(true); }, 30000);
