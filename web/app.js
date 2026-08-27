/*
 * RF CIP 현장 모바일 앱 — Master Prompt §18, §19, §20, §15, §16, §47, §52
 *
 * 목표: 하루 입력을 6번의 터치로 끝낸다.
 *   [오늘 작업 입력] → 시작번호 → 종료번호 → [예] → [없음] → [입력완료]
 *
 * 예외가 있을 때만 화면이 늘어난다 (§1-6 정상상태보다 예외상태만 입력).
 */

import { isInRange, nextPick } from './pick.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const state = {
  token: localStorage.getItem('rfcip.token') || null,
  user: null,
  sites: [],
  siteId: localStorage.getItem('rfcip.siteId') || null,
  today: null,
  notStarted: [],
  pick: { from: null, to: null },
  preview: null,
  depthSame: null,
  groundSame: null,
  depthExceptions: {},
  groundNotes: [],
  noteOptions: [],
};

/* ------------------------------------------------------------------ 통신 */
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { logout(); throw new Error('다시 로그인해 주십시오.'); }
    throw new Error(body.message || '오류가 발생했습니다.');
  }
  return body;
}

function toast(message, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function logout() {
  localStorage.removeItem('rfcip.token');
  state.token = null; state.user = null;
}

const num = (v) => Number(v ?? 0).toLocaleString('ko-KR',
  { maximumFractionDigits: 1 });
const today = () => new Date().toISOString().slice(0, 10);
const dateLabel = (d) => {
  const [y, m, dd] = d.split('-');
  const w = ['일','월','화','수','목','금','토'][new Date(d + 'T00:00:00').getDay()];
  return `${Number(m)}월 ${Number(dd)}일 (${w})`;
};

/* ------------------------------------------------------------------ 로그인 */
function renderLogin(message) {
  app.innerHTML = `
    <header class="site"><h1>RF CIP 현장</h1></header>
    <div class="card">
      ${message ? `<div class="notice error">${message}</div>` : ''}
      <label class="field"><span class="label">아이디</span>
        <input id="loginId" autocomplete="username" inputmode="text"></label>
      <label class="field"><span class="label">비밀번호</span>
        <input id="password" type="password" autocomplete="current-password"></label>
      <button class="primary" id="doLogin">로그인</button>
    </div>`;
  $('#doLogin').onclick = async () => {
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login_id: $('#loginId').value.trim(), password: $('#password').value }),
      });
      state.token = r.token; state.user = r.user;
      localStorage.setItem('rfcip.token', r.token);
      await boot();
    } catch (e) { renderLogin(e.message); }
  };
}

/* ------------------------------------------------------------------ 현장선택 */
function renderSitePicker() {
  app.innerHTML = `
    <header class="site"><h1>현장 선택</h1></header>
    <div class="card">
      ${state.sites.map((s) => `<button data-id="${s.id}">${s.site_name}</button>`).join('')}
    </div>`;
  app.querySelectorAll('button[data-id]').forEach((b) => {
    b.onclick = () => {
      state.siteId = b.dataset.id;
      localStorage.setItem('rfcip.siteId', state.siteId);
      openMain();
    };
  });
}

/* ------------------------------------------------------------------ §18 메인 */
async function openMain() {
  const t = await api(`/field/sites/${state.siteId}/today`);
  state.today = t;
  const p = t.progress;
  const submitted = t.daily_work && t.daily_work.status === 'SUBMITTED';

  app.innerHTML = `
    <header class="site">
      <h1>${t.site.site_name}</h1>
      <div class="date">${dateLabel(t.date)}</div>
    </header>

    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">오늘</div>
          <div class="value">${p.today_holes}<span class="unit">공</span></div></div>
        <div class="stat"><div class="label">누계</div>
          <div class="value">${p.completed_holes}<span class="unit">공</span></div></div>
        <div class="stat"><div class="label">공정률</div>
          <div class="value">${num(p.progress_rate)}<span class="unit">%</span></div></div>
      </div>
      ${submitted ? `<div class="notice ok">오늘 입력을 마쳤습니다. (${t.today_holes.length}공)</div>` : ''}
    </div>

    ${t.today_layer_summary.length ? `
    <div class="card">
      <h2>오늘 지층별</h2>
      <table class="summary">
        ${t.today_layer_summary.map((l) =>
          `<tr><td>${l.ground_type_name}</td><td class="num">${num(l.planned_length)} m</td></tr>`).join('')}
      </table>
    </div>` : ''}

    <button class="primary" id="goInput">${submitted ? '오늘 작업 다시 입력' : '오늘 작업 입력'}</button>
    <button class="later" disabled>천공현황 / 도면 · 준비중</button>
    <button class="later" disabled>비용 · 증빙 · 준비중</button>
    <button class="later" disabled>특이사항 · 준비중</button>
    <button class="later" disabled>오늘 보고서 · 준비중</button>
    <button class="later" disabled>카카오톡 공유 · 준비중</button>
    <div class="spacer"></div>
    <button class="ghost" id="switchSite">다른 현장 / 로그아웃</button>`;

  $('#goInput').onclick = openInput;
  $('#switchSite').onclick = () => {
    if (state.sites.length > 1) { renderSitePicker(); } else { logout(); renderLogin(); }
  };
}

/* ------------------------------------------- §19 오늘 천공 입력 (번호 고르기) */
async function openInput() {
  // 천공번호 목록은 공용 조회 API 를 쓴다 (/api/sites/:id/holes)
  const list = await api(`/sites/${state.siteId}/holes?status=NOT_STARTED&limit=1000`);
  state.notStarted = list.holes;
  state.pick = { from: state.today.suggested_start_hole_no, to: null };
  state.preview = null;
  state.depthSame = null; state.groundSame = null;
  state.depthExceptions = {}; state.groundNotes = [];
  renderInput();
}

function renderInput() {
  const picked = state.pick;
  const holeNos = state.notStarted.map((h) => h.hole_no);
  const inRange = (no) => isInRange(picked, holeNos, no);

  app.innerHTML = `
    <header class="site">
      <h1>오늘 작업 입력</h1>
      <div class="date">${dateLabel(state.today.date)}</div>
    </header>

    <div class="card">
      <div class="question">오늘 뚫은 번호를 고르십시오</div>
      <div class="range-line">
        <div class="slot ${picked.from ? 'filled' : ''}">
          <div class="label">시작</div><div class="value">${picked.from ?? '—'}</div></div>
        <div class="slot ${picked.to ? 'filled' : ''}">
          <div class="label">종료</div><div class="value">${picked.to ?? '—'}</div></div>
      </div>
      <div class="picker" id="picker">
        ${state.notStarted.map((h) => `
          <button data-no="${h.hole_no}"
            class="${inRange(h.hole_no) ? 'in-range' : ''}"
            aria-pressed="${h.hole_no === picked.from || h.hole_no === picked.to}"
          >${h.hole_no}</button>`).join('')}
      </div>
      ${state.notStarted.length === 0
        ? '<div class="notice ok">미시공 천공번호가 없습니다.</div>' : ''}
      <button class="ghost" id="reset">다시 고르기</button>
    </div>

    <div id="summary"></div>
    <button class="ghost" id="back">돌아가기</button>`;

  $('#picker')?.querySelectorAll('button[data-no]').forEach((b) => {
    b.onclick = () => pickHole(b.dataset.no);
  });
  $('#reset').onclick = () => { state.pick = { from: null, to: null }; state.preview = null; renderInput(); };
  $('#back').onclick = openMain;

  if (state.preview) renderSummary();
  else if (picked.from && picked.to) loadPreview();
}

function pickHole(no) {
  state.pick = nextPick(state.pick, state.notStarted.map((h) => h.hole_no), no);
  state.preview = null;
  renderInput();
}

async function loadPreview() {
  const { from, to } = state.pick;
  try {
    state.preview = await api(`/field/sites/${state.siteId}/daily-work/preview`, {
      method: 'POST',
      body: JSON.stringify({ work_date: state.today.date, from, to }),
    });
    renderInput();
  } catch (e) { toast(e.message); }
}

/* -------------------------------- §20 자동집계 + §16 실제심도 + §15 특이사항 */
function renderSummary() {
  const s = state.preview;
  const box = $('#summary');
  const exCount = Object.keys(state.depthExceptions).length;

  box.innerHTML = `
    <div class="card">
      <h2>오늘 ${s.today_hole_count}공 · ${num(s.today_planned_length)} m</h2>
      <table class="summary">
        ${s.layer_summary.map((l) =>
          `<tr><td>${l.ground_type_name}</td><td class="num">${num(l.planned_length)} m</td></tr>`).join('')}
        <tr><td class="muted">누계</td><td class="num">${s.cumulative_hole_count}공</td></tr>
        <tr><td class="muted">잔여</td><td class="num">${s.remaining_hole_count}공</td></tr>
        <tr><td class="muted">공정률</td><td class="num">${num(s.progress_rate_after)} %</td></tr>
      </table>
      ${s.issues.map((i) => `<div class="notice ${i.severity === 'ERROR' ? 'error' : 'warn'}">${i.message}</div>`).join('')}
    </div>

    <div class="card">
      <div class="question">계획심도와 동일합니까?</div>
      <div class="choice">
        <button id="depthYes" aria-pressed="${state.depthSame === true}">예</button>
        <button id="depthNo"  aria-pressed="${state.depthSame === false}">아니오</button>
      </div>
      <div id="depthDetail"></div>
    </div>

    <div class="card">
      <div class="question">계획 지반조건과 다른 점이 있었습니까?</div>
      <div class="choice">
        <button id="groundNo"  aria-pressed="${state.groundSame === true}">없음</button>
        <button id="groundYes" aria-pressed="${state.groundSame === false}">있음</button>
      </div>
      <div id="groundDetail"></div>
    </div>

    <button class="primary" id="submit"
      ${(!s.can_save || state.depthSame === null || state.groundSame === null) ? 'disabled' : ''}>
      입력완료${exCount ? ` (심도 예외 ${exCount}공)` : ''}
    </button>`;

  $('#depthYes').onclick = () => { state.depthSame = true; state.depthExceptions = {}; renderSummary(); };
  $('#depthNo').onclick  = () => { state.depthSame = false; renderSummary(); };
  $('#groundNo').onclick  = () => { state.groundSame = true; state.groundNotes = []; renderSummary(); };
  $('#groundYes').onclick = () => { state.groundSame = false; renderGroundOptions(); };
  $('#submit').onclick = submitDaily;

  if (state.depthSame === false) renderDepthInputs();
  if (state.groundSame === false) renderGroundOptions();
}

/** 아니오를 골랐을 때만 나온다. 다른 공은 계획심도를 그대로 쓴다 (§16). */
function renderDepthInputs() {
  const s = state.preview;
  $('#depthDetail').innerHTML = `
    <p class="muted" style="font-size:17px">다른 공만 적으십시오. 비워두면 계획심도를 씁니다.</p>
    <div class="rowlist">
      ${s.today_hole_numbers.map((no) => `
        <div class="row"><span class="no">${no}</span>
          <input inputmode="decimal" data-no="${no}" placeholder="m"
                 value="${state.depthExceptions[no] ?? ''}"></div>`).join('')}
    </div>`;
  $('#depthDetail').querySelectorAll('input[data-no]').forEach((i) => {
    i.onchange = () => {
      const v = i.value.trim();
      if (v === '') delete state.depthExceptions[i.dataset.no];
      else state.depthExceptions[i.dataset.no] = v;
      const btn = $('#submit');
      const n = Object.keys(state.depthExceptions).length;
      btn.textContent = `입력완료${n ? ` (심도 예외 ${n}공)` : ''}`;
    };
  });
}

/** 있음을 골랐을 때만 나온다 (§15). 선택지는 현장 지층종류에서 만든다. */
async function renderGroundOptions() {
  if (state.noteOptions.length === 0) {
    try {
      const r = await api(`/field/sites/${state.siteId}/ground-note-options`);
      state.noteOptions = r.options;
    } catch { state.noteOptions = [{ note_type: '기타', hint: null }]; }
  }
  const chosen = new Set(state.groundNotes.map((n) => n.note_type));
  const box = $('#groundDetail');
  if (!box) return;
  box.innerHTML = `
    <div class="picker" style="max-height:none;margin-top:12px">
      ${state.noteOptions.map((o) => `
        <button data-type="${o.note_type}" aria-pressed="${chosen.has(o.note_type)}"
        >${o.note_type}</button>`).join('')}
    </div>`;
  box.querySelectorAll('button[data-type]').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.type;
      if (chosen.has(t)) state.groundNotes = state.groundNotes.filter((n) => n.note_type !== t);
      else state.groundNotes.push({ note_type: t });
      renderSummary();
    };
  });
}

/* ------------------------------------------------------------------ 저장 */
async function submitDaily() {
  const btn = $('#submit');
  btn.disabled = true; btn.textContent = '저장 중…';
  try {
    const r = await api(`/field/sites/${state.siteId}/daily-work`, {
      method: 'POST',
      body: JSON.stringify({
        work_date: state.today.date,
        from: state.pick.from, to: state.pick.to,
        depth_same_as_plan: state.depthSame,
        depth_exceptions: Object.entries(state.depthExceptions)
          .map(([hole_no, actual_depth_total]) => ({ hole_no, actual_depth_total })),
        ground_notes: state.groundNotes,
        submit: true,
      }),
    });
    toast(`${r.today_hole_count}공 입력완료`);
    await openMain();
  } catch (e) {
    toast(e.message);
    btn.disabled = false; btn.textContent = '입력완료';
  }
}

/* ------------------------------------------------------------------ 시작 */
async function boot() {
  if (!state.token) return renderLogin();
  try {
    const me = await api('/auth/me');
    state.user = me.user; state.sites = me.sites;
    if (state.sites.length === 0) return renderLogin('배정된 현장이 없습니다.');
    if (!state.siteId || !state.sites.some((s) => s.id === state.siteId)) {
      if (state.sites.length === 1) {
        state.siteId = state.sites[0].id;
        localStorage.setItem('rfcip.siteId', state.siteId);
      } else return renderSitePicker();
    }
    await openMain();
  } catch (e) { renderLogin(e.message); }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
