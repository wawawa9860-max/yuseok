/*
 * RF CIP 현장 모바일 앱 — Master Prompt §18, §19, §20, §15, §16, §47, §52
 *
 * 목표: 하루 입력을 6번의 터치로 끝낸다.
 *   [오늘 작업 입력] → 시작번호 → 종료번호 → [예] → [없음] → [입력완료]
 *
 * 예외가 있을 때만 화면이 늘어난다 (§1-6 정상상태보다 예외상태만 입력).
 */

import { isInRange, nextPick } from './pick.js';
import { enqueue, flush, newRequestId, pendingCount } from './queue.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const state = {
  pending: 0,
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
  shortfallReasons: [],
  stale: false,
  previewOffline: false,
  defaults: { labor: [], equipment: [] },
  laborSame: null, laborChanges: [],
  equipSame: null, equipChanges: [],
  readyMix: null,
  events: null,        // §31 특이사항
  eventTypes: [],
  newEvent: null,
  progress: null,      // §36 공정률
  payments: null,      // §37 기성
  register: null,      // §34 천공조서
  registerStatus: '',
  report: null,        // §33 작업일보
  cost: null,          // §27 비용 입력 중인 내용
  costTypes: [],
  recentCosts: [],
  evidenceRate: null,
};

/* ------------------------------------------------------------------ 통신 */
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    // 통신 자체가 안 된 경우. 재전송하면 되는 상황이다.
    const err = new Error('통신이 되지 않습니다.');
    err.offline = true;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { logout(); throw new Error('다시 로그인해 주십시오.'); }
    if (res.status >= 500) {
      const err = new Error(body.message || '서버 오류입니다.');
      err.offline = true;     // 서버 일시 장애도 재전송 대상
      throw err;
    }
    const err = new Error(body.message || '오류가 발생했습니다.');
    err.permanent = true;     // 검증 실패 등은 다시 보내도 소용없다
    throw err;
  }
  return body;
}

/** 사진 업로드는 multipart 라 Content-Type 을 브라우저가 정하게 둔다. */
async function apiUpload(path, file, filename) {
  const form = new FormData();
  form.append('file', file, filename);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      body: form,
    });
  } catch {
    const err = new Error('통신이 되지 않습니다.');
    err.offline = true;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status >= 500) {
      const err = new Error(body.message || '서버 오류입니다.');
      err.offline = true;
      throw err;
    }
    const err = new Error(body.message || '사진을 올리지 못했습니다.');
    err.permanent = true;
    throw err;
  }
  return body;
}

/* ------------------------------------------------- 오프라인 대비 캐시 */
/**
 * 큐만으로는 부족하다. 통신이 끊긴 채로 앱을 열면
 * 천공번호 목록조차 못 받아 입력 화면에 들어갈 수 없다.
 * 마지막으로 성공한 조회 결과를 기기에 남겨 두고, 통신이 안 되면 그것으로 화면을 연다.
 */
const cacheKey = (name) => `rfcip.cache.${name}.${state.siteId}`;

function cacheSave(name, data) {
  try {
    localStorage.setItem(cacheKey(name), JSON.stringify({ at: Date.now(), data }));
  } catch { /* 저장공간이 없으면 캐시 없이 동작한다 */ }
}

function cacheLoad(name) {
  try {
    const raw = localStorage.getItem(cacheKey(name));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** 통신이 되면 서버에서, 안 되면 마지막 캐시에서 가져온다. */
async function fetchWithCache(name, path) {
  try {
    const data = await api(path);
    cacheSave(name, data);
    return { data, stale: false };
  } catch (e) {
    const hit = cacheLoad(name);
    if (e.offline && hit) return { data: hit.data, stale: true, at: hit.at };
    throw e;
  }
}

/* -------------------------------------------------------- 오프라인 큐 */
/** 큐에 쌓인 항목을 서버로 보낸다. */
async function sendQueued(item, done) {
  if (item.kind === 'event-file') {
    const eventId = item.event_id || done?.get(item.after)?.event?.id;
    if (!eventId) {
      const err = new Error('특이사항 저장을 기다립니다.');
      err.offline = true;
      throw err;
    }
    return apiUpload(`/events/${eventId}/files`, item.file, item.filename);
  }
  // 영수증 사진은 비용이 먼저 저장돼야 붙일 수 있다.
  if (item.kind === 'evidence') {
    // 비용이 이미 저장돼 있으면 그 id 를, 아니면 방금 보낸 비용의 응답에서 찾는다.
    const costId = item.cost_id || done?.get(item.after)?.cost?.id;
    if (!costId) {
      // 앞의 비용이 이번에 안 보내졌다면 사진도 미룬다 (다음 기회에 같이 보낸다).
      const err = new Error('비용 저장을 기다립니다.');
      err.offline = true;
      throw err;
    }
    return apiUpload(`/cost/costs/${costId}/evidence`, item.file, item.filename);
  }
  return api(item.path, {
    method: 'POST',
    headers: { 'X-Client-Request-Id': item.request_id },
    body: JSON.stringify(item.payload),
  });
}

// 통신이 돌아오는 순간 online 이벤트와 화면 진입이 겹쳐 두 번 보내려 할 수 있다.
// 서버도 같은 요청 ID 를 줄 세우지만, 굳이 두 번 보낼 이유는 없다.
let flushing = false;

async function flushQueue({ silent = true } = {}) {
  if (!navigator.onLine || flushing) return;
  const before = await pendingCount();
  if (before === 0) return;
  flushing = true;
  try {
    const r = await flush(sendQueued);
    state.pending = await pendingCount();
    if (r.sent > 0 && !silent) toast(`저장 대기 ${r.sent}건을 보냈습니다.`);
    if (r.sent > 0) await openMain();
  } finally { flushing = false; }
}

window.addEventListener('online', () => flushQueue({ silent: false }));

function toast(message, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function logout() {
  localStorage.removeItem('rfcip.token');
  localStorage.removeItem('rfcip.me');
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
  const { data: t, stale } = await fetchWithCache('today', `/field/sites/${state.siteId}/today`);
  state.today = t;
  state.stale = stale;
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
      ${state.pending > 0 ? `<div class="notice warn">저장 대기 ${state.pending}건 · 통신되면 자동으로 보냅니다.</div>` : ''}
      ${state.stale ? '<div class="notice warn">통신이 안 되어 마지막으로 받은 내용을 보여줍니다. 입력은 가능합니다.</div>' : ''}
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
    <button id="goRegister">천공조서 / 천공일지</button>
    <button id="goCost">비용 · 증빙</button>
    <button id="goProgress">공정률 / 기성</button>
    <button id="goEvents">특이사항</button>
    <button id="goReport">오늘 보고서</button>
    <button class="later" disabled>카카오톡 공유 · 준비중</button>
    <div class="spacer"></div>
    <button class="ghost" id="switchSite">다른 현장 / 로그아웃</button>`;

  $('#goInput').onclick = async () => {
    try { await openInput(); }
    catch (e) {
      // 버튼을 눌렀는데 아무 일도 안 일어나는 것이 제일 나쁘다. 이유를 말해준다.
      toast(e.offline
        ? '통신이 안 되고 이 현장 자료를 받아둔 적도 없습니다. 통신되는 곳에서 한 번만 열어 주십시오.'
        : e.message, 4500);
    }
  };
  $('#goCost').onclick = openCost;
  $('#goRegister').onclick = () => openRegister();
  $('#goProgress').onclick = openProgress;
  $('#goEvents').onclick = openEvents;
  // openReport(date) 라서 그대로 넘기면 클릭 이벤트가 날짜 자리에 들어간다
  $('#goReport').onclick = () => openReport();
  $('#switchSite').onclick = () => {
    if (state.sites.length > 1) { renderSitePicker(); } else { logout(); renderLogin(); }
  };

  // 통신이 될 때 입력화면 자료를 미리 받아 둔다.
  // 현장에 들어가서 통신이 끊긴 뒤에 열어도 입력할 수 있어야 한다.
  if (navigator.onLine && !state.stale) void warmCache();
}

/** 입력화면이 필요로 하는 자료를 미리 받아 캐시에 넣는다. 실패해도 조용히 넘어간다. */
async function warmCache() {
  await Promise.allSettled([
    fetchWithCache('holes', `/sites/${state.siteId}/holes?status=NOT_STARTED&limit=1000`),
    fetchWithCache('defaults', `/field/sites/${state.siteId}/defaults`),
    fetchWithCache('costTypes', '/cost/cost-types'),
    fetchWithCache('groundNoteOptions', `/field/sites/${state.siteId}/ground-note-options`),
  ]);
}

/* ------------------------------------------- §19 오늘 천공 입력 (번호 고르기) */
async function openInput() {
  // 천공번호 목록은 공용 조회 API 를 쓴다 (/api/sites/:id/holes)
  const [list, defaults] = await Promise.all([
    fetchWithCache('holes', `/sites/${state.siteId}/holes?status=NOT_STARTED&limit=1000`),
    fetchWithCache('defaults', `/field/sites/${state.siteId}/defaults`)
      .catch(() => ({ data: { labor: [], equipment: [] }, stale: false })),
  ]);
  state.notStarted = list.data.holes;
  state.defaults = defaults.data;
  state.stale = list.stale;
  state.laborSame = null; state.laborChanges = [];
  state.equipSame = null; state.equipChanges = [];
  state.readyMix = null;
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
    state.previewOffline = false;
  } catch (e) {
    if (!e.offline) { toast(e.message); return; }
    // 통신이 안 되면 기기에서 계산해 보여준다.
    // 서버가 다시 계산하므로 이 값은 화면 표시용이다.
    state.preview = localPreview(from, to);
    state.previewOffline = true;
  }
  renderInput();
}

/** 오프라인 미리보기 — 서버와 같은 규칙으로 기기에서 계산한다 (§46). */
function localPreview(from, to) {
  const nos = state.notStarted.map((h) => h.hole_no);
  const a = nos.indexOf(from); const b = nos.indexOf(to);
  const picked = state.notStarted.slice(Math.min(a, b), Math.max(a, b) + 1);
  const length = picked.reduce((sum, h) => sum + Number(h.design_depth_total ?? 0), 0);
  return {
    today_hole_count: picked.length,
    today_hole_numbers: picked.map((h) => h.hole_no),
    today_planned_length: Number(length.toFixed(3)),
    layer_summary: [],
    cumulative_hole_count: (state.today.progress?.completed_holes ?? 0) + picked.length,
    remaining_hole_count: (state.today.progress?.remaining_holes ?? 0) - picked.length,
    progress_rate_after: null,
    issues: [{
      code: 'OFFLINE_PREVIEW', severity: 'WARN',
      message: '통신이 안 되어 기기에서 계산했습니다. 지층별 수량은 저장 후 서버가 확정합니다.',
    }],
    can_save: picked.length > 0,
  };
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
        ${s.progress_rate_after === null ? ''
          : `<tr><td class="muted">공정률</td><td class="num">${num(s.progress_rate_after)} %</td></tr>`}
      </table>
      ${s.issues.map((i) => `<div class="notice ${i.severity === 'ERROR' ? 'error' : 'warn'}">${i.message}</div>`).join('')}
    </div>

    <div class="card">
      <div class="question">계획심도까지 뚫었습니까?</div>
      <div class="choice">
        <button id="depthYes" aria-pressed="${state.depthSame === true}">다 뚫었다</button>
        <button id="depthNo"  aria-pressed="${state.depthSame === false}">못 간 공 있다</button>
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

    <div class="card">
      <div class="question">금일 레미콘 반입량</div>
      <div class="rowlist">
        <div class="row">
          <input id="rmQty" inputmode="decimal" placeholder="m³ (없으면 비워두십시오)"
                 value="${state.readyMix?.quantity_m3 ?? ''}">
        </div>
      </div>
      <div class="question" style="margin-top:16px">공급지연이 있었습니까?</div>
      <div class="choice">
        <button id="rmNoDelay" aria-pressed="${state.readyMix?.has_delay === false}">없음</button>
        <button id="rmDelay"   aria-pressed="${state.readyMix?.has_delay === true}">있음</button>
      </div>
      <div id="rmDelayDetail"></div>
    </div>

    <div class="card">
      <div class="question">오늘 인원은 기본설정과 동일합니까?</div>
      <div class="choice">
        <button id="laborYes" aria-pressed="${state.laborSame !== false}">예</button>
        <button id="laborNo"  aria-pressed="${state.laborSame === false}">아니오</button>
      </div>
      <div id="laborDetail"></div>

      <div class="question" style="margin-top:16px">오늘 장비는 기본설정과 동일합니까?</div>
      <div class="choice">
        <button id="equipYes" aria-pressed="${state.equipSame !== false}">예</button>
        <button id="equipNo"  aria-pressed="${state.equipSame === false}">아니오</button>
      </div>
      <div id="equipDetail"></div>
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

  // 레미콘 (§23)
  $('#rmQty').onchange = (ev) => {
    const v = ev.target.value.trim();
    if (v === '') { state.readyMix = null; return; }
    state.readyMix = { ...(state.readyMix ?? { has_delay: false }), quantity_m3: v };
  };
  $('#rmNoDelay').onclick = () => {
    state.readyMix = { ...(state.readyMix ?? { quantity_m3: '0' }), has_delay: false };
    delete state.readyMix.delay_minutes; delete state.readyMix.delay_reason;
    renderSummary();
  };
  $('#rmDelay').onclick = () => {
    state.readyMix = { ...(state.readyMix ?? { quantity_m3: '0' }), has_delay: true };
    renderSummary();
  };

  // 인원·장비 (§21, §22) — 기본은 '동일'. 바꿀 때만 누른다.
  $('#laborYes').onclick = () => { state.laborSame = true; state.laborChanges = []; renderSummary(); };
  $('#laborNo').onclick  = () => { state.laborSame = false; renderSummary(); };
  $('#equipYes').onclick = () => { state.equipSame = true; state.equipChanges = []; renderSummary(); };
  $('#equipNo').onclick  = () => { state.equipSame = false; renderSummary(); };

  if (state.depthSame === false) renderDepthInputs();
  if (state.groundSame === false) renderGroundOptions();
  if (state.readyMix?.has_delay) renderDelayOptions();
  if (state.laborSame === false) renderDefaultEditor('labor');
  if (state.equipSame === false) renderDefaultEditor('equip');
}

/** §23 공급지연 — '있음' 일 때만 나온다 */
function renderDelayOptions() {
  const box = $('#rmDelayDetail');
  if (!box) return;
  const mins = [30, 60, 90, 120];
  const reasons = ['레미콘공장', '원도급', '검측', '현장조건', '기타'];
  box.innerHTML = `
    <p class="muted" style="font-size:17px;margin-top:12px">지연시간</p>
    <div class="picker" style="max-height:none">
      ${mins.map((m) => `<button data-min="${m}"
        aria-pressed="${state.readyMix?.delay_minutes === m}">${m}분</button>`).join('')}
    </div>
    <p class="muted" style="font-size:17px;margin-top:12px">사유</p>
    <div class="picker" style="max-height:none">
      ${reasons.map((r) => `<button data-reason="${r}"
        aria-pressed="${state.readyMix?.delay_reason === r}">${r}</button>`).join('')}
    </div>`;
  box.querySelectorAll('button[data-min]').forEach((b) => {
    b.onclick = () => { state.readyMix.delay_minutes = Number(b.dataset.min); renderSummary(); };
  });
  box.querySelectorAll('button[data-reason]').forEach((b) => {
    b.onclick = () => { state.readyMix.delay_reason = b.dataset.reason; renderSummary(); };
  });
}

/*
 * §21/§22 '아니오' 일 때만 나온다. 바뀐 것만 적는다.
 *
 * 공수(출력일보) / 가동일수(장비가동일보) 를 여기서 받는다.
 * 현금으로 지급하지 않아도 1일 / 0.5일 은 반드시 남아야 하고,
 * 투입비는 본사가 이 값에 단가를 곱해서 계산한다 (§25, §26).
 *
 * 기본은 [1일] 이 눌려 있다. 반일이거나 안 나온 날만 손댄다 (§1-6).
 */
const DAY_CHOICES = [
  { v: '1', label: '1일' },
  { v: '0.5', label: '반일' },
  { v: '0', label: '안나옴' },
];

function renderDefaultEditor(kind) {
  const isLabor = kind === 'labor';
  const box = $(isLabor ? '#laborDetail' : '#equipDetail');
  if (!box) return;
  const list = isLabor ? state.defaults.labor : state.defaults.equipment;
  const arr = isLabor ? state.laborChanges : state.equipChanges;
  const keyOf = (x) => (isLabor ? x.role_name : x.equipment_name);
  const countOf = (x) => (isLabor ? x.headcount : x.quantity);
  const defDays = (x) => (isLabor ? x.default_work_days : x.default_operating_days) ?? '1';
  const daysField = isLabor ? 'work_days' : 'operating_days';
  const countField = isLabor ? 'headcount' : 'quantity';
  const reasonField = isLabor ? 'absence_reason' : 'idle_reason';
  const entryFor = (key) => arr.find((c) => keyOf(c) === key);

  if (list.length === 0) {
    box.innerHTML = '<p class="muted" style="font-size:17px">기본설정이 없습니다. 본사에 등록을 요청하십시오.</p>';
    return;
  }

  // 화면에 보이는 값 = 적어둔 값이 있으면 그것, 없으면 기본값
  const shownDays = (x) => entryFor(keyOf(x))?.[daysField] ?? String(Number(defDays(x)));

  box.innerHTML = `
    <p class="muted" style="font-size:17px;margin-top:12px">
      바뀐 것만 손대십시오. ${isLabor ? '출력일보' : '장비가동일보'}에 그대로 들어갑니다.</p>
    <div class="daylist">
      ${list.map((x) => {
        const key = keyOf(x);
        const e = entryFor(key);
        const days = shownDays(x);
        return `
        <div class="dayrow">
          <div class="dayhead">
            <span class="no">${key}</span>
            <input class="cnt" inputmode="decimal" data-count="${key}"
                   placeholder="${countOf(x)}" value="${e?.[countField] ?? ''}"
                   aria-label="${isLabor ? '인원' : '대수'}">
          </div>
          <div class="daypick">
            ${DAY_CHOICES.map((c) => `<button data-days="${c.v}" data-key="${key}"
               aria-pressed="${Number(days) === Number(c.v)}">${c.label}</button>`).join('')}
          </div>
          ${Number(days) !== 1 ? `
          <input class="reason" data-reason="${key}" value="${e?.[reasonField] ?? ''}"
                 placeholder="사유 (정산 근거로 남습니다)">` : ''}
        </div>`;
      }).join('')}
    </div>`;

  /** 변경행을 만들거나 지운다. 기본과 같아지면 행 자체를 없앤다 (§1-6). */
  const upsert = (key, patch) => {
    const idx = arr.findIndex((c) => keyOf(c) === key);
    const base = idx >= 0 ? arr[idx] : (isLabor ? { role_name: key } : { equipment_name: key });
    const next = { ...base, ...patch };
    for (const f of [countField, daysField, reasonField]) {
      if (next[f] === '' || next[f] === undefined || next[f] === null) delete next[f];
    }
    const keys = Object.keys(next).filter((k) => k !== 'role_name' && k !== 'equipment_name');
    if (keys.length === 0) { if (idx >= 0) arr.splice(idx, 1); return; }
    if (idx >= 0) arr[idx] = next; else arr.push(next);
  };

  box.querySelectorAll('input[data-count]').forEach((i) => {
    i.onchange = () => upsert(i.dataset.count, { [countField]: i.value.trim() });
  });
  box.querySelectorAll('button[data-days]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.key;
      const x = list.find((y) => keyOf(y) === key);
      // 기본값과 같은 것을 고르면 그 항목은 '변경 없음' 으로 되돌린다
      const same = Number(b.dataset.days) === Number(defDays(x));
      upsert(key, { [daysField]: same ? '' : b.dataset.days,
                    ...(Number(b.dataset.days) === 1 ? { [reasonField]: '' } : {}) });
      renderDefaultEditor(kind);
    };
  });
  box.querySelectorAll('input[data-reason]').forEach((i) => {
    i.onchange = () => upsert(i.dataset.reason, { [reasonField]: i.value.trim() });
  });
}

/*
 * '못 간 공 있다' 를 골랐을 때만 나온다 (§16, 사용자 확인 2026-08-27).
 *
 * 계획심도는 천공조서에 이미 있다. 현장은 숫자를 다시 적지 않는다.
 * 못 간 공만 고르고, 어디까지 갔는지와 왜인지를 남긴다.
 * 실제심도를 안 받으면 그 공이 계획심도까지 간 것으로 잡혀 수량이 부풀려진다.
 */
function renderDepthInputs() {
  const s = state.preview;
  const box = $('#depthDetail');
  if (!box) return;
  const picked = state.depthExceptions;

  box.innerHTML = `
    <p class="muted" style="font-size:17px;margin-top:12px">
      계획심도까지 못 간 공만 누르십시오. 누르지 않은 공은 계획심도까지 간 것으로 봅니다.</p>
    <div class="picker" style="max-height:none">
      ${s.today_hole_numbers.map((no) => `<button data-short="${no}"
        aria-pressed="${!!picked[no]}">${no}${picked[no]?.actual_depth_total
          ? `<br><small>${picked[no].actual_depth_total}m</small>` : ''}</button>`).join('')}
    </div>
    <div id="shortDetail"></div>`;

  box.querySelectorAll('button[data-short]').forEach((b) => {
    b.onclick = () => {
      const no = b.dataset.short;
      if (picked[no]) delete picked[no];
      else picked[no] = { actual_depth_total: '', shortfall_reason: '' };
      renderDepthInputs();
      updateSubmitLabel();
    };
  });
  renderShortfallDetail();
}

/** 고른 공마다 '어디까지' 와 '왜' 를 받는다. */
async function renderShortfallDetail() {
  const box = $('#shortDetail');
  if (!box) return;
  const nos = Object.keys(state.depthExceptions);
  if (nos.length === 0) { box.innerHTML = ''; return; }

  if (state.shortfallReasons.length === 0) {
    try {
      const r = await fetchWithCache('shortfallReasons', '/field/shortfall-reasons');
      state.shortfallReasons = r.data.reasons;
    } catch { state.shortfallReasons = ['기타']; }
  }

  box.innerHTML = nos.map((no) => {
    const e = state.depthExceptions[no];
    return `
    <div class="dayrow" style="margin-top:12px">
      <div class="dayhead">
        <span class="no">${no}</span>
        <input class="cnt" inputmode="decimal" data-depth="${no}"
               placeholder="m" value="${e.actual_depth_total}" aria-label="실제심도">
      </div>
      <p class="muted" style="font-size:17px;margin:8px 0 0">왜 못 갔습니까?</p>
      <div class="picker" style="max-height:none;margin-top:6px">
        ${state.shortfallReasons.map((r) => `<button data-reason-for="${no}" data-reason="${r}"
          aria-pressed="${e.shortfall_reason === r}">${r}</button>`).join('')}
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('input[data-depth]').forEach((i) => {
    i.onchange = () => {
      state.depthExceptions[i.dataset.depth].actual_depth_total = i.value.trim();
      updateSubmitLabel();
    };
  });
  box.querySelectorAll('button[data-reason-for]').forEach((b) => {
    b.onclick = () => {
      state.depthExceptions[b.dataset.reasonFor].shortfall_reason = b.dataset.reason;
      renderShortfallDetail();
      updateSubmitLabel();
    };
  });
}

/** 못 간 공이 있으면 버튼에 몇 공인지 보여준다. */
function updateSubmitLabel() {
  const btn = $('#submit');
  if (!btn) return;
  const n = Object.keys(state.depthExceptions).length;
  btn.textContent = `입력완료${n ? ` (계획심도 미달 ${n}공)` : ''}`;
}

/** 있음을 골랐을 때만 나온다 (§15). 선택지는 현장 지층종류에서 만든다. */
async function renderGroundOptions() {
  if (state.noteOptions.length === 0) {
    try {
      const r = await fetchWithCache(
        'groundNoteOptions', `/field/sites/${state.siteId}/ground-note-options`);
      state.noteOptions = r.data.options;
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

/* ------------------------------------------------ §31 특이사항 (PHASE 11) */
/*
 * ERP 가 아니다. 유형 하나 고르고, 필요하면 번호를 누르고, 사진을 찍는다.
 *
 * 레미콘 지연·장비대기·계획심도 미달·지반 특이사항은 일일입력이 이미 받았다.
 * 여기서 다시 묻지 않는다 (§1-2). 아래 목록이 그것들을 모아서 함께 보여준다.
 */
async function openEvents() {
  let data, types;
  try {
    const [a, b] = await Promise.all([
      fetchWithCache('events', `/events/sites/${state.siteId}/events`),
      fetchWithCache('eventTypes', '/events/event-types'),
    ]);
    data = a.data; types = b.data.event_types; state.stale = a.stale;
  } catch (e) { toast(e.message); return; }
  state.events = data;
  state.eventTypes = types;
  state.newEvent = null;
  renderEvents();
}

function renderEvents() {
  const d = state.events;
  const auto = d.from_daily_input;
  const autoRows = [
    ...auto.depth_shortfall.map((x) => ({
      date: x.work_date, label: `계획심도 미달 · ${x.hole_no}`,
      detail: `${num(x.actual_depth)}/${num(x.design_depth)}m · ${x.reason}` })),
    ...auto.ready_mix_delay.map((x) => ({
      date: x.work_date, label: '레미콘 지연',
      detail: `${x.delay_minutes}분 · ${x.delay_reason ?? ''}` })),
    ...auto.equipment_idle.map((x) => ({
      date: x.work_date, label: `장비 ${Number(x.operating_days) === 0 ? '대기' : '반일'} · ${x.equipment_name}`,
      detail: x.idle_reason ?? '' })),
    ...auto.ground_notes.map((x) => ({
      date: x.work_date, label: `지반 · ${x.note_type}`,
      detail: `${x.memo ?? ''} ${x.hole_numbers.join(', ')}`.trim() })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  app.innerHTML = `
    <header class="site">
      <h1>특이사항</h1>
      <div class="date">${state.today.site.site_name}</div>
    </header>

    ${state.stale ? '<div class="notice warn">통신이 안 되어 마지막으로 받은 내용을 보여줍니다.</div>' : ''}

    <div class="card">
      <div class="question">무슨 일이 있었습니까?</div>
      <div class="picker" style="max-height:none">
        ${state.eventTypes.map((t) => `<button data-type="${t}"
          aria-pressed="${state.newEvent?.event_type === t}">${t}</button>`).join('')}
      </div>
    </div>
    <div id="eventDetail"></div>

    ${d.events.length ? `
    <div class="card">
      <h2>등록된 특이사항</h2>
      <table class="summary">
        ${d.events.slice(0, 15).map((e) => `
          <tr><td>${e.event_no}${e.needs_review ? ' <b style="color:var(--warn)">검토</b>' : ''}<br>
                <small class="muted">${String(e.event_date).slice(0, 10)} · ${e.event_type}</small></td>
              <td class="num">${e.title ?? e.memo ?? ''}${e.hole_numbers.length
                ? `<br><small class="muted">${e.hole_numbers.join(', ')}</small>` : ''}
                ${e.files.length ? `<br><small class="muted">첨부 ${e.files.length}건</small>` : ''}
                ${e.status === 'CLOSED' ? '<br><small class="muted">종결</small>' : ''}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    ${autoRows.length ? `
    <div class="card">
      <h2>일일입력에서 모은 특이사항</h2>
      <p class="muted" style="font-size:17px">이미 입력하신 내용입니다. 다시 적을 필요 없습니다.</p>
      <table class="summary">
        ${autoRows.slice(0, 15).map((r) => `
          <tr><td>${r.label}<br><small class="muted">${String(r.date).slice(0, 10)}</small></td>
              <td class="num">${r.detail}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    <button class="ghost" id="back">돌아가기</button>`;

  app.querySelectorAll('button[data-type]').forEach((b) => {
    b.onclick = () => {
      state.newEvent = { event_type: b.dataset.type, hole_nos: [], memo: '', file: null };
      renderEvents();
    };
  });
  $('#back').onclick = openMain;
  if (state.newEvent) renderEventDetail();
}

/** 유형을 고른 다음에만 나온다. */
function renderEventDetail() {
  const box = $('#eventDetail');
  const ev = state.newEvent;
  const holes = (state.today?.today_holes ?? []).map?.((h) => h.hole_no)
    ?? [];

  box.innerHTML = `
    <div class="card">
      <div class="question">${ev.event_type}</div>
      <label class="field"><span class="label">내용 (선택)</span>
        <textarea id="evMemo" rows="2">${ev.memo}</textarea></label>

      <p class="muted" style="font-size:17px">관련 천공번호 (선택 — 오늘 작업분)</p>
      <div class="picker" style="max-height:26vh" id="evHoles"></div>

      <input id="evPhoto" type="file" accept="image/*" capture="environment" hidden>
      <button class="ghost" id="evTakePhoto">${ev.file ? '사진 1장 · 다시 찍기' : '사진 찍기'}</button>

      <label class="field" style="display:flex;align-items:center;gap:12px">
        <input id="evReview" type="checkbox" style="width:28px;height:28px"
               ${ev.needs_review ? 'checked' : ''}>
        <span>설계변경·정산 검토가 필요합니다</span></label>

      <button class="primary" id="evSave">저장</button>
    </div>`;

  // 오늘 작업분 + 미시공 앞쪽 번호를 후보로 보여준다
  (async () => {
    let nos = [];
    try {
      const t = await fetchWithCache('today', `/field/sites/${state.siteId}/today`);
      nos = (t.data.today_holes ?? []).map((h) => h.hole_no);
    } catch { /* 캐시 없음 */ }
    if (nos.length === 0) {
      try {
        const l = await fetchWithCache('holes', `/sites/${state.siteId}/holes?status=NOT_STARTED&limit=1000`);
        nos = l.data.holes.slice(0, 30).map((h) => h.hole_no);
      } catch { /* 통신 불가 */ }
    }
    const el = $('#evHoles');
    if (!el) return;
    el.innerHTML = nos.map((no) => `<button data-hole="${no}"
      aria-pressed="${ev.hole_nos.includes(no)}">${no}</button>`).join('')
      || '<p class="muted" style="font-size:17px">오늘 작업분이 없습니다.</p>';
    el.querySelectorAll('button[data-hole]').forEach((b) => {
      b.onclick = () => {
        const no = b.dataset.hole;
        const i = ev.hole_nos.indexOf(no);
        if (i >= 0) ev.hole_nos.splice(i, 1); else ev.hole_nos.push(no);
        b.setAttribute('aria-pressed', String(i < 0));
      };
    });
  })();

  $('#evMemo').onchange = () => { ev.memo = $('#evMemo').value.trim(); };
  $('#evReview').onchange = () => { ev.needs_review = $('#evReview').checked; };
  $('#evTakePhoto').onclick = () => $('#evPhoto').click();
  $('#evPhoto').onchange = () => { ev.file = $('#evPhoto').files[0] ?? null; renderEventDetail(); };
  $('#evSave').onclick = saveEvent;
}

async function saveEvent() {
  const ev = state.newEvent;
  const btn = $('#evSave');
  btn.disabled = true; btn.textContent = '저장 중…';

  const payload = { event_type: ev.event_type, event_date: state.today.date };
  if (ev.memo) payload.memo = ev.memo;
  if (ev.hole_nos.length) payload.hole_nos = ev.hole_nos;
  if (ev.needs_review) payload.needs_review = true;
  const requestId = newRequestId();

  try {
    const saved = await api(`/events/sites/${state.siteId}/events`, {
      method: 'POST',
      headers: { 'X-Client-Request-Id': requestId },
      body: JSON.stringify(payload),
    });
    if (ev.file) {
      try {
        await apiUpload(`/events/${saved.event.id}/files`, ev.file, ev.file.name || 'photo.jpg');
      } catch (e) {
        if (e.offline) {
          await enqueue({
            id: newRequestId(), request_id: newRequestId(), queued_at: Date.now() + 1,
            kind: 'event-file', event_id: saved.event.id,
            file: ev.file, filename: ev.file.name || 'photo.jpg', label: '특이사항 사진',
          });
          state.pending = await pendingCount();
        } else toast(`사진을 올리지 못했습니다: ${e.message}`, 4000);
      }
    }
    toast(`${saved.event.event_no} 저장했습니다.`);
    await openEvents();
  } catch (e) {
    if (e.offline) {
      await enqueue({
        id: requestId, request_id: requestId, queued_at: Date.now(),
        kind: 'event', path: `/events/sites/${state.siteId}/events`, payload,
        label: `특이사항 ${ev.event_type}`,
      });
      if (ev.file) {
        await enqueue({
          id: newRequestId(), request_id: newRequestId(), queued_at: Date.now() + 1,
          kind: 'event-file', after: requestId,
          file: ev.file, filename: ev.file.name || 'photo.jpg', label: '특이사항 사진',
        });
      }
      state.pending = await pendingCount();
      toast('통신이 안 되어 저장 대기로 넘겼습니다. 통신되면 자동으로 보냅니다.', 4000);
      await openMain();
    } else {
      toast(e.message);
      btn.disabled = false; btn.textContent = '저장';
    }
  }
}

/* ------------------------------------------ §36 공정률 / §37 기성 (PHASE 10) */
/*
 * 현장관리자도 볼 수 있다. 여기 나오는 금액은 전부 '계약금액' 이다.
 * 내부 원가(노무비·장비비·단가)는 서버가 애초에 내려주지 않는다 (§29, §44).
 *
 * §37 "기성가능액 ≠ 실제 제출 기성" 이므로 화면에서도 두 값을 섞지 않는다.
 */
async function openProgress() {
  let p, pay;
  try {
    const [a, b] = await Promise.all([
      fetchWithCache('progress', `/progress/sites/${state.siteId}/progress`),
      fetchWithCache('payments', `/progress/sites/${state.siteId}/payments`),
    ]);
    p = a.data; pay = b.data; state.stale = a.stale || b.stale;
  } catch (e) { toast(e.message); return; }
  state.progress = p; state.payments = pay;
  renderProgress();
}

const won = (v) => `${Number(v ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`;
const PAY_STATUS = {
  DRAFT: '작성중', SUBMITTED: '제출', APPROVED: '승인', REJECTED: '반려',
};
const BASIS_LABEL = {
  CONTRACT_QUANTITY: '계약수량 기준',
  DESIGN_DEPTH: '계약수량이 없어 계획심도로 계산',
  CONTRACT_AMOUNT: '계약금액 기준',
  HOLE_CONTRACT_AMOUNT: '계약이 등록되지 않아 천공 계약금액 합계로 계산',
  NONE: '기준이 되는 값이 없습니다',
};

function renderProgress() {
  const p = state.progress;
  const bar = (rate) => `<div class="bar"><span style="width:${Math.min(100, Number(rate))}%"></span></div>`;

  app.innerHTML = `
    <header class="site">
      <h1>공정률 / 기성</h1>
      <div class="date">${state.today.site.site_name}</div>
    </header>

    ${state.stale ? '<div class="notice warn">통신이 안 되어 마지막으로 받은 내용을 보여줍니다.</div>' : ''}

    <div class="card">
      <h2>물량 공정률</h2>
      <div class="bignum">${num(p.quantity.rate)}<span class="unit">%</span></div>
      ${bar(p.quantity.rate)}
      <table class="summary">
        <tr><td>완료</td><td class="num">${num(p.quantity.completed)} / ${num(p.quantity.total)}</td></tr>
      </table>
      <p class="muted" style="font-size:17px">${BASIS_LABEL[p.quantity.basis] ?? p.quantity.basis}</p>
    </div>

    <div class="card">
      <h2>금액 공정률</h2>
      <div class="bignum">${num(p.amount.rate)}<span class="unit">%</span></div>
      ${bar(p.amount.rate)}
      <table class="summary">
        <tr><td>시공 인정금액</td><td class="num">${won(p.amount.earned_amount)}</td></tr>
        <tr><td>계약금액</td><td class="num">${won(p.amount.contract_amount)}</td></tr>
      </table>
      <p class="muted" style="font-size:17px">${BASIS_LABEL[p.amount.basis] ?? p.amount.basis}</p>
    </div>

    <div class="card">
      <h2>보조지표</h2>
      <table class="summary">
        <tr><td>천공 공수</td><td class="num">${p.hole_count.completed} / ${p.hole_count.total}공 (${num(p.hole_count.rate)}%)</td></tr>
        <tr><td>천공연장</td><td class="num">${num(p.length.completed)} / ${num(p.length.total)} m (${num(p.length.rate)}%)</td></tr>
        <tr><td>투입 공수</td><td class="num">${num(p.man_days)}일</td></tr>
      </table>
    </div>

    ${p.by_ground_type.length ? `
    <div class="card">
      <h2>지층별 천공량</h2>
      <table class="summary">
        ${p.by_ground_type.map((g) => `<tr><td>${g.ground_type_name}</td>
          <td class="num">${num(g.completed_length)} / ${num(g.planned_length)} m (${num(g.rate)}%)</td></tr>`).join('')}
      </table>
      <p class="muted" style="font-size:17px">계획 지층 기준입니다. 지층별 실제 실적은 따로 받지 않습니다.</p>
    </div>` : ''}

    <div class="card">
      <h2>기성</h2>
      ${state.payments.count === 0
        ? '<p class="muted" style="font-size:17px">아직 기성 회차가 없습니다.</p>'
        : `<table class="summary">
            ${state.payments.payments.map((c) => `
              <tr data-pay="${c.id}"><td>${c.sequence_no}회차 · ${PAY_STATUS[c.status]}<br>
                <small class="muted">${c.period_from.slice(0, 10)} ~ ${c.period_to.slice(0, 10)}</small></td>
                <td class="num">${won(c.submitted_amount ?? c.draft_amount)}
                ${c.submitted_amount === null ? '<br><small class="muted">기성가능액</small>' : ''}</td></tr>`).join('')}
            <tr><td><b>누계 (제출·승인분)</b></td>
                <td class="num"><b>${won(state.payments.cumulative_amount)}</b></td></tr>
          </table>`}
      <button class="ghost" id="showDraft">이번달 기성가능액 보기</button>
    </div>
    <div id="draftBox"></div>

    <button class="ghost" id="back">돌아가기</button>`;

  $('#showDraft').onclick = openPaymentDraft;
  app.querySelectorAll('tr[data-pay]').forEach((tr) => {
    tr.onclick = () => openPaymentDetail(tr.dataset.pay);
  });
  $('#back').onclick = openMain;
}

/** §37 기성가능액 — 초안이라는 것을 화면에서도 분명히 한다. */
async function openPaymentDraft() {
  const box = $('#draftBox');
  box.innerHTML = '<div class="card"><p class="muted">계산 중…</p></div>';
  let d;
  try {
    d = await api(`/progress/sites/${state.siteId}/payment-draft`);
  } catch (e) { box.innerHTML = ''; toast(e.message); return; }

  box.innerHTML = `
    <div class="card">
      <h2>기성가능액 (${d.period_from.slice(0, 10)} ~ ${d.period_to.slice(0, 10)})</h2>
      <div class="bignum">${won(d.draft_amount)}</div>
      <div class="notice warn">이것은 <b>초안</b>입니다. 실제 제출 기성은 본사가 확정합니다.</div>
      ${d.issues.map((i) => `<div class="notice warn">${i.message}</div>`).join('')}
      <table class="summary">
        <tr><td>대상 천공</td><td class="num">${d.hole_count}공</td></tr>
        <tr><td>수량</td><td class="num">${num(d.quantity)}</td></tr>
        <tr><td>앞 회차 누계</td><td class="num">${won(d.previous_amount)}</td></tr>
        <tr><td>누계 합계</td><td class="num">${won(d.cumulative_amount)}</td></tr>
      </table>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 회차 상세. 확정된 회차는 그 시점 근거를 그대로 보여준다 (§38). */
async function openPaymentDetail(id) {
  let c;
  try { c = await api(`/progress/payments/${id}`); }
  catch (e) { toast(e.message); return; }

  app.innerHTML = `
    <header class="site"><h1>${c.sequence_no}회차 기성</h1>
      <div class="date">${PAY_STATUS[c.status]} · ${c.period_from.slice(0, 10)} ~ ${c.period_to.slice(0, 10)}</div>
    </header>
    <div class="card">
      <table class="summary">
        <tr><td>기성가능액 (초안)</td><td class="num">${won(c.draft_amount)}</td></tr>
        <tr><td>실제 제출 기성</td><td class="num">${c.submitted_amount === null
          ? '아직 제출 전' : won(c.submitted_amount)}</td></tr>
        ${c.adjust_reason ? `<tr><td>조정 사유</td><td class="num">${c.adjust_reason}</td></tr>` : ''}
        <tr><td>대상 천공</td><td class="num">${c.holes.length}공</td></tr>
        ${c.memo ? `<tr><td>비고</td><td class="num">${c.memo}</td></tr>` : ''}
      </table>
    </div>

    <div class="card">
      <h2>포함된 천공</h2>
      <div class="tablewrap">
        <table class="register">
          <thead><tr><th>PILE NO</th><th>수량</th><th>단가</th><th>금액</th><th>시공일</th></tr></thead>
          <tbody>
            ${c.holes.map((h) => `<tr>
              <th>${h.hole_no}</th>
              <td>${num(h.contract_quantity)}</td>
              <td class="${h.unit_price === null ? 'bad' : ''}">${
                h.unit_price === null ? '단가없음' : num(h.unit_price)}</td>
              <td>${h.unit_price === null ? '-' : num(h.amount)}</td>
              <td>${String(h.construction_date).slice(0, 10)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <button class="ghost" id="backProgress">공정률로</button>`;
  $('#backProgress').onclick = () => renderProgress();
}

/* --------------------------------- 천공조서 / 천공일지 (§34, 사용자 확인) */
/*
 * "천공일지는 천공조서와 거의 동일하다."
 * 그래서 수량산출서 천공조서와 같은 칸으로 낸다.
 *   PILE NO │ 지층별 공당 │ 합계 │ 실제 │ 상태
 * 지층 칸은 현장이 정한 지층으로 만든다. 시스템이 정하지 않는다 (§7).
 *
 * 휴대폰이라 표가 옆으로 길어진다. 가로로만 스크롤되게 하고 세로는 그대로 둔다.
 */
const REG_FILTERS = [
  { v: '', label: '전체' },
  { v: 'COMPLETED', label: '완료' },
  { v: 'NOT_STARTED', label: '미시공' },
];

async function openRegister(status) {
  const st = status ?? state.registerStatus ?? '';
  let data;
  try {
    const got = await fetchWithCache(`register.${st}`,
      `/reports/sites/${state.siteId}/drilling-register?limit=500${st ? `&status=${st}` : ''}`);
    data = got.data; state.stale = got.stale;
  } catch (e) { toast(e.message); return; }
  state.register = data;
  state.registerStatus = st;
  renderRegister();
}

function renderRegister() {
  const d = state.register;
  const gts = d.ground_types;
  const layerOf = (r, code) =>
    (r.layers ?? []).find((l) => l.ground_type_code === code)?.per_hole;

  app.innerHTML = `
    <header class="site">
      <h1>천공조서</h1>
      <div class="date">${state.today.site.site_name} · ${d.total_count}공</div>
    </header>

    ${state.stale ? '<div class="notice warn">통신이 안 되어 마지막으로 받은 내용을 보여줍니다.</div>' : ''}
    ${d.issues.map((i) => `<div class="notice error">${i.message}</div>`).join('')}

    <div class="card">
      <div class="picker" style="max-height:none">
        ${REG_FILTERS.map((f) => `<button data-status="${f.v}"
          aria-pressed="${state.registerStatus === f.v}">${f.label}</button>`).join('')}
      </div>
    </div>

    ${d.totals.map((t) => `
    <div class="card">
      <h2>${t.hole_type_name} 합계</h2>
      <table class="summary">
        <tr><td>공수</td><td class="num">${t.completed_count} / ${t.hole_count}공</td></tr>
        ${t.layers.map((l) =>
          `<tr><td>${l.ground_type_name}</td><td class="num">${num(l.planned_length)} m</td></tr>`).join('')}
        <tr><td>계획 합계</td><td class="num">${num(t.planned_length)} m</td></tr>
        <tr><td>실적 합계</td><td class="num">${num(t.actual_length)} m</td></tr>
      </table>
    </div>`).join('')}

    <div class="card">
      <h2>천공조서</h2>
      <div class="tablewrap">
        <table class="register">
          <thead>
            <tr>
              <th>PILE NO</th>
              ${gts.map((g) => `<th>${g.name}</th>`).join('')}
              <th>합계</th><th>실제</th><th>상태</th>
            </tr>
          </thead>
          <tbody>
            ${d.rows.map((r) => `
            <tr data-hole="${r.hole_no}">
              <th>${r.hole_no}</th>
              ${gts.map((g) => `<td>${layerOf(r, g.code) ? num(layerOf(r, g.code)) : '-'}</td>`).join('')}
              <td class="${r.has_ground_profile && Number(r.layer_sum) !== Number(r.design_depth_total)
                ? 'bad' : ''}">${num(r.design_depth_total)}</td>
              <td>${r.actual_depth_total ? num(r.actual_depth_total) : '-'}</td>
              <td>${r.status === 'COMPLETED' ? '완료'
                : r.status === 'NOT_STARTED' ? '미시공' : r.status}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted" style="font-size:17px">줄을 누르면 그 공의 천공일지가 나옵니다.</p>
      ${d.count < d.total_count
        ? `<p class="muted" style="font-size:17px">${d.count} / ${d.total_count}공 표시</p>` : ''}
    </div>

    <button class="ghost" id="back">돌아가기</button>`;

  app.querySelectorAll('button[data-status]').forEach((b) => {
    b.onclick = () => openRegister(b.dataset.status);
  });
  app.querySelectorAll('tr[data-hole]').forEach((tr) => {
    tr.onclick = () => openHoleLog(tr.dataset.hole, 'register');
  });
  $('#back').onclick = openMain;
}

/* ------------------------------------------- §33 작업일보 (PHASE 9) */
/*
 * 현장관리자가 따로 쓰는 것이 없다. 이미 받아 둔 값을 모아 보여줄 뿐이다 (§1-7).
 * 유일하게 손댈 수 있는 것이 익일계획인데, 그것도 내일 화면의 기본값이 되므로
 * 결국 내일 입력을 줄여 준다 (§1-5).
 *
 * 금액은 없다. 서버가 애초에 내려주지 않는다 (§29).
 */
async function openReport(date) {
  const d = date ?? state.today.date;
  let r;
  try {
    const got = await fetchWithCache(`report.${d}`, `/reports/sites/${state.siteId}/daily-report?date=${d}`);
    r = got.data; state.stale = got.stale;
  } catch (e) { toast(e.message); return; }
  state.report = r;
  renderReport();
}

function renderReport() {
  const r = state.report;
  const row = (label, value) => value == null || value === ''
    ? '' : `<tr><td>${label}</td><td class="num">${value}</td></tr>`;

  app.innerHTML = `
    <header class="site">
      <h1>작업일보</h1>
      <div class="date">${dateLabel(r.work_date)} · ${r.site.site_name}</div>
    </header>

    ${state.stale ? '<div class="notice warn">통신이 안 되어 마지막으로 받은 내용을 보여줍니다.</div>' : ''}
    ${r.status === 'NONE' ? '<div class="notice warn">이 날은 입력된 작업이 없습니다.</div>' : ''}

    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">금일 천공</div>
          <div class="value">${r.today.hole_count}<span class="unit">공</span></div></div>
        <div class="stat"><div class="label">금일 연장</div>
          <div class="value">${num(r.today.length)}<span class="unit">m</span></div></div>
        <div class="stat"><div class="label">금일 공수</div>
          <div class="value">${num(r.today_man_days)}<span class="unit">일</span></div></div>
      </div>
      <table class="summary">
        ${row('작업구간', r.sections)}
        ${row('작업내용', r.work_summary)}
        ${row('누계 천공', `${r.cumulative.hole_count} / ${r.cumulative.total_hole_count}공`)}
        ${row('누계 공수', `${num(r.cumulative_man_days)}일`)}
      </table>
    </div>

    ${r.hole_numbers.length ? `
    <div class="card">
      <h2>금일 천공번호</h2>
      <div class="picker" style="max-height:none">
        ${r.hole_numbers.map((h) => `<button class="${h.depth_same_as_plan ? '' : 'in-range'}"
          data-hole="${h.hole_no}">${h.hole_no}${h.depth_same_as_plan ? ''
            : `<br><small>${num(h.actual_depth_total)}m</small>`}</button>`).join('')}
      </div>
      <p class="muted" style="font-size:17px">번호를 누르면 천공일지가 나옵니다.</p>
    </div>` : ''}

    ${r.layer_summary.length ? `
    <div class="card">
      <h2>지층별 계획 천공연장</h2>
      <table class="summary">
        ${r.layer_summary.map((l) =>
          `<tr><td>${l.ground_type_name}</td><td class="num">${num(l.planned_length)} m</td></tr>`).join('')}
      </table>
    </div>` : ''}

    ${r.ready_mix ? `
    <div class="card">
      <h2>레미콘</h2>
      <table class="summary">
        ${row('반입량', `${num(r.ready_mix.quantity_m3)} m³`)}
        ${r.ready_mix.has_delay
          ? row('공급지연', `${r.ready_mix.delay_minutes}분 · ${r.ready_mix.delay_reason ?? ''}`)
          : ''}
      </table>
    </div>` : ''}

    ${r.labor.length ? `
    <div class="card">
      <h2>인원 (출력일보)</h2>
      <table class="summary">
        ${r.labor.map((l) => `<tr><td>${l.role_name}${l.absence_reason
            ? `<br><small class="muted">${l.absence_reason}</small>` : ''}</td>
          <td class="num">${num(l.headcount)}명 × ${num(l.work_days)}일 = ${num(l.man_days)}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    ${r.equipment.length ? `
    <div class="card">
      <h2>장비 (가동일보)</h2>
      <table class="summary">
        ${r.equipment.map((e) => `<tr><td>${e.equipment_name}${e.idle_reason
            ? `<br><small class="muted">${e.idle_reason}</small>` : ''}</td>
          <td class="num">${Number(e.operating_days) === 0 ? '미가동'
            : `${num(e.unit_days)}일`}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    ${r.special_notes.length ? `
    <div class="card">
      <h2>특이사항</h2>
      <table class="summary">
        ${r.special_notes.map((n) => `<tr><td>${n.note_type}${n.memo
            ? `<br><small class="muted">${n.memo}</small>` : ''}</td>
          <td class="num">${n.hole_numbers.join(', ')}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    <div class="card">
      <h2>익일계획</h2>
      <label class="field"><span class="label">비워두면 다음 미시공 번호를 씁니다</span>
        <textarea id="nextPlan" rows="2">${r.next_day_plan ?? ''}</textarea></label>
      ${!r.next_day_plan && r.next_day_suggestion.length ? `
        <button class="ghost" id="useSuggestion">${r.next_day_suggestion[0]} ~ ${r.next_day_suggestion[r.next_day_suggestion.length - 1]} 로 적기</button>` : ''}
      ${r.status !== 'NONE' ? '<button class="primary" id="savePlan">익일계획 저장</button>' : ''}
    </div>

    <button class="ghost" id="back">돌아가기</button>`;

  app.querySelectorAll('button[data-hole]').forEach((b) => {
    b.onclick = () => openHoleLog(b.dataset.hole);
  });
  $('#useSuggestion') && ($('#useSuggestion').onclick = () => {
    const s = r.next_day_suggestion;
    $('#nextPlan').value = `${s[0]} ~ ${s[s.length - 1]} 천공`;
  });
  $('#savePlan') && ($('#savePlan').onclick = async () => {
    try {
      await api(`/reports/sites/${state.siteId}/daily-report/next-day-plan`, {
        method: 'PUT',
        body: JSON.stringify({ work_date: r.work_date, next_day_plan: $('#nextPlan').value.trim() }),
      });
      toast('익일계획을 저장했습니다.');
      await openReport(r.work_date);
    } catch (e) { toast(e.message); }
  });
  $('#back').onclick = openMain;
}

/** §34 천공일지 */
async function openHoleLog(holeNo, from = 'report') {
  let h;
  try {
    h = await api(`/reports/sites/${state.siteId}/holes/${encodeURIComponent(holeNo)}/log`);
  } catch (e) { toast(e.message); return; }

  const row = (label, value) => value == null || value === ''
    ? '' : `<tr><td>${label}</td><td class="num">${value}</td></tr>`;
  app.innerHTML = `
    <header class="site"><h1>천공일지</h1><div class="date">${h.hole_no}</div></header>
    <div class="card">
      <table class="summary">
        ${row('구간', h.section)}
        ${row('종류', h.hole_type)}
        ${row('계획심도', h.design_depth_total ? `${num(h.design_depth_total)} m` : null)}
        ${row('실제심도', h.actual_depth_total ? `${num(h.actual_depth_total)} m` : '미시공')}
        ${h.depth_diff && Number(h.depth_diff) !== 0
          ? row('계획 대비', `${Number(h.depth_diff) > 0 ? '+' : ''}${num(h.depth_diff)} m`) : ''}
        ${row('시공일', h.construction_date ? dateLabel(h.construction_date) : null)}
        ${row('도면', h.drawing.drawing_ref)}
      </table>
    </div>

    ${h.layers.length ? `
    <div class="card">
      <h2>지층별 공당 (천공조서)</h2>
      <table class="summary">
        ${h.layers.map((l) =>
          `<tr><td>${l.ground_type_name}</td><td class="num">${num(l.per_hole)} m</td></tr>`).join('')}
        <tr><td><b>지층 합계</b></td><td class="num">${num(h.layer_sum)} m</td></tr>
      </table>
      ${h.layer_sum_matches ? '' :
        `<div class="notice error">지층 합계(${num(h.layer_sum)}m)가 계획심도(${num(h.design_depth_total)}m)와 다릅니다. 조서를 확인해 주십시오.</div>`}
    </div>` : ''}

    ${h.ready_mix ? `
    <div class="card"><h2>레미콘</h2>
      <table class="summary">${row('반입량', `${num(h.ready_mix.quantity_m3)} m³`)}</table>
    </div>` : ''}

    ${h.special_notes.length ? `
    <div class="card"><h2>특이사항</h2>
      <table class="summary">
        ${h.special_notes.map((n) => `<tr><td>${n.note_type}</td>
          <td class="num">${n.memo ?? ''}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    <button class="ghost" id="backReport">${from === 'register' ? '천공조서로' : '작업일보로'}</button>`;
  $('#backReport').onclick = () => (from === 'register' ? renderRegister() : renderReport());
}

/* ------------------------------------------------ §27 비용 · 증빙 (PHASE 8) */
/*
 * 현장관리자가 하는 일은 두 가지뿐이다.
 *   1) 오늘 쓴 돈을 고르고 금액을 적는다
 *   2) 영수증 사진을 찍는다
 * 원가 합계·손익은 이 화면에 없다. 서버가 애초에 내려주지 않는다 (§29).
 *
 * 노무비·장비비는 본사 단가로 자동계산된다. 여기서 다시 묻지 않는다 (§1-2 중복입력 금지).
 */
const FIELD_COST_TYPES = ['C03', 'C04', 'C05', 'C06'];

async function openCost() {
  try {
    const [types, recent, rate] = await Promise.all([
      fetchWithCache('costTypes', '/cost/cost-types'),
      fetchWithCache('recentCosts', `/cost/sites/${state.siteId}/costs?limit=20`),
      api(`/cost/sites/${state.siteId}/evidence-rate`).catch(() => null),
    ]);
    state.costTypes = types.data.cost_types.filter((t) => FIELD_COST_TYPES.includes(t.code));
    state.recentCosts = recent.data.costs;
    state.evidenceRate = rate;
    state.stale = types.stale || recent.stale;
  } catch (e) { toast(e.message); return; }
  state.cost = null;
  renderCost();
}

function renderCost() {
  const r = state.evidenceRate;
  app.innerHTML = `
    <header class="site">
      <h1>비용 · 증빙</h1>
      <div class="date">${dateLabel(state.today.date)}</div>
    </header>

    ${r ? `
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">이번달 증빙</div>
          <div class="value">${num(r.evidence_rate)}<span class="unit">%</span></div></div>
        <div class="stat"><div class="label">증빙대기</div>
          <div class="value">${r.pending_count}<span class="unit">건</span></div></div>
      </div>
    </div>` : ''}
    ${state.stale ? '<div class="notice warn">통신이 안 되어 마지막으로 받은 내용을 보여줍니다.</div>' : ''}

    <div class="card">
      <div class="question">무엇에 쓴 돈입니까?</div>
      <div class="picker" style="max-height:none">
        ${state.costTypes.map((t) => `<button data-code="${t.code}"
          aria-pressed="${state.cost?.cost_type === t.code}">${t.name_ko}</button>`).join('')}
      </div>
      <p class="muted" style="font-size:17px">노무비·장비비는 본사가 단가로 계산합니다. 적지 않아도 됩니다.</p>
    </div>

    <div id="costDetail"></div>

    ${state.recentCosts.length ? `
    <div class="card">
      <h2>최근 입력</h2>
      <table class="summary">
        ${state.recentCosts.slice(0, 8).map((c) => `
          <tr><td>${c.cost_date.slice(5, 10)} ${c.cost_type_name}</td>
              <td class="num">${num(c.amount)}원</td>
              <td class="num">${c.evidence_status === 'VERIFIED' ? '증빙완료'
                : c.evidence_status === 'HEAD_OFFICE_REVIEW' ? '본사확인' : '증빙대기'}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    <button class="ghost" id="back">돌아가기</button>`;

  app.querySelectorAll('button[data-code]').forEach((b) => {
    b.onclick = () => {
      state.cost = { cost_type: b.dataset.code, amount: '', file: null };
      renderCost();
    };
  });
  $('#back').onclick = openMain;
  if (state.cost) renderCostDetail();
}

/** 항목을 고른 다음에만 나온다. */
function renderCostDetail() {
  const box = $('#costDetail');
  const c = state.cost;
  // §1-5 전일값 재사용 — 같은 항목을 마지막으로 얼마 썼는지 한 번에 넣는다.
  const last = state.recentCosts.find((x) => x.cost_type === c.cost_type);
  const typeName = state.costTypes.find((t) => t.code === c.cost_type)?.name_ko ?? '';

  box.innerHTML = `
    <div class="card">
      <div class="question">${typeName} 얼마입니까?</div>
      ${last ? `<button class="ghost" id="sameAsLast">지난번과 같음 · ${num(last.amount)}원</button>` : ''}
      <label class="field"><span class="label">금액 (원)</span>
        <input id="costAmount" inputmode="numeric" value="${c.amount}"></label>
      <label class="field"><span class="label">거래처 (없으면 비워두십시오)</span>
        <input id="costVendor" value="${c.vendor ?? ''}"></label>

      <div class="question" style="margin-top:16px">영수증 사진</div>
      <input id="costPhoto" type="file" accept="image/*" capture="environment" hidden>
      <button class="ghost" id="takePhoto">${c.file ? `사진 1장 · 다시 찍기` : '사진 찍기'}</button>
      <p class="muted" style="font-size:17px">사진이 없어도 저장됩니다. 나중에 붙이면 증빙완료가 됩니다.</p>

      <button class="primary" id="saveCost">저장</button>
    </div>`;

  $('#sameAsLast') && ($('#sameAsLast').onclick = () => {
    state.cost.amount = String(last.amount).replace(/\.00$/, '');
    state.cost.vendor = last.vendor ?? '';
    renderCostDetail();
  });
  $('#costAmount').onchange = () => { state.cost.amount = $('#costAmount').value.trim(); };
  $('#costVendor').onchange = () => { state.cost.vendor = $('#costVendor').value.trim(); };
  $('#takePhoto').onclick = () => $('#costPhoto').click();
  $('#costPhoto').onchange = () => {
    state.cost.file = $('#costPhoto').files[0] ?? null;
    renderCostDetail();
  };
  $('#saveCost').onclick = saveCost;
}

async function saveCost() {
  const c = state.cost;
  const amount = String(c.amount ?? '').replace(/[,\s원]/g, '');
  if (!/^\d+(\.\d+)?$/.test(amount)) { toast('금액을 적어 주십시오.'); return; }

  const btn = $('#saveCost');
  btn.disabled = true; btn.textContent = '저장 중…';

  const payload = { cost_date: state.today.date, cost_type: c.cost_type, amount };
  if (c.vendor) payload.vendor = c.vendor;
  const requestId = newRequestId();
  const path = `/cost/sites/${state.siteId}/costs`;

  try {
    const saved = await api(path, {
      method: 'POST',
      headers: { 'X-Client-Request-Id': requestId },
      body: JSON.stringify(payload),
    });
    if (c.file) {
      try {
        await apiUpload(`/cost/costs/${saved.cost.id}/evidence`, c.file, c.file.name || 'receipt.jpg');
        toast('저장했습니다. 증빙완료.');
      } catch (e) {
        if (e.offline) {
          await enqueueEvidence(requestId, c.file, saved.cost.id);
          toast('비용은 저장했고 사진은 통신되면 보냅니다.', 4000);
        } else { toast(`비용은 저장했으나 사진을 올리지 못했습니다: ${e.message}`, 4000); }
      }
    } else {
      toast('저장했습니다. 증빙대기.');
    }
    await openCost();
  } catch (e) {
    if (e.offline) {
      await enqueue({
        id: requestId, request_id: requestId, queued_at: Date.now(),
        kind: 'cost', path, payload,
        label: `${payload.cost_date} ${payload.cost_type} ${payload.amount}원`,
      });
      // 사진은 비용이 저장된 뒤에 붙는다. 큐에서 순서를 지킨다.
      if (c.file) await enqueueEvidence(requestId, c.file, null);
      state.pending = await pendingCount();
      toast('통신이 안 되어 저장 대기로 넘겼습니다. 통신되면 자동으로 보냅니다.', 4000);
      await openMain();
    } else {
      toast(e.message);
      btn.disabled = false; btn.textContent = '저장';
    }
  }
}

/** 영수증 사진을 큐에 넣는다. after 는 앞선 비용 저장 요청의 ID 다. */
async function enqueueEvidence(afterRequestId, file, costId) {
  const id = newRequestId();
  await enqueue({
    id, request_id: id, queued_at: Date.now() + 1,
    kind: 'evidence', after: afterRequestId, cost_id: costId,
    file, filename: file.name || 'receipt.jpg',
    label: '영수증 사진',
  });
  state.pending = await pendingCount();
}

/* ------------------------------------------------------------------ 저장 */
async function submitDaily() {
  const btn = $('#submit');
  btn.disabled = true; btn.textContent = '저장 중…';

  // 비어 있는 항목은 아예 보내지 않는다. null 을 보내면 서버가 형식 오류로 본다.
  const payload = {
    work_date: state.today.date,
    from: state.pick.from, to: state.pick.to,
    depth_same_as_plan: state.depthSame,
    labor_same_as_default: state.laborSame !== false,
    equipment_same_as_default: state.equipSame !== false,
    submit: true,
  };
  const exceptions = Object.entries(state.depthExceptions)
    .map(([hole_no, e]) => ({ hole_no, ...e }));
  // 못 갔다고 골라놓고 심도나 사유를 안 적으면 서버가 거부한다. 여기서 먼저 알려준다.
  const incomplete = exceptions.filter((e) => !e.actual_depth_total || !e.shortfall_reason);
  if (incomplete.length) {
    toast(`${incomplete.map((e) => e.hole_no).join(', ')} 의 실제심도와 사유를 적어 주십시오.`, 4000);
    const btn = $('#submit');
    btn.disabled = false; updateSubmitLabel();
    return;
  }
  if (exceptions.length) payload.depth_exceptions = exceptions;
  if (state.groundNotes.length) payload.ground_notes = state.groundNotes;
  if (state.laborChanges.length) payload.labor_changes = state.laborChanges;
  if (state.equipChanges.length) payload.equipment_changes = state.equipChanges;
  if (state.readyMix && state.readyMix.quantity_m3) payload.ready_mix = state.readyMix;
  const requestId = newRequestId();

  try {
    await api(`/field/sites/${state.siteId}/daily-work`, {
      method: 'POST',
      headers: { 'X-Client-Request-Id': requestId },
      body: JSON.stringify(payload),
    });
    toast('입력완료');
    await openMain();
  } catch (e) {
    if (e.offline) {
      // 통신이 안 되면 기기에 쌓아 두고 나중에 보낸다.
      // 같은 요청 ID 를 쓰므로 두 번 저장되지 않는다.
      await enqueue({
        id: requestId, request_id: requestId, queued_at: Date.now(),
        path: `/field/sites/${state.siteId}/daily-work`, payload,
        label: `${state.today.date} ${payload.from}~${payload.to}`,
      });
      state.pending = await pendingCount();
      toast('통신이 안 되어 저장 대기로 넘겼습니다. 통신되면 자동으로 보냅니다.', 4000);
      await openMain();
    } else {
      toast(e.message);
      btn.disabled = false; btn.textContent = '입력완료';
    }
  }
}

/* ------------------------------------------------------------------ 시작 */
async function boot() {
  if (!state.token) return renderLogin();

  // 통신이 끊긴 곳에서 앱을 새로 열어도 쓸 수 있어야 한다.
  // 마지막으로 확인된 내 정보를 남겨 두고, 통신이 안 되면 그것으로 연다.
  let me;
  try {
    me = await api('/auth/me');
    try { localStorage.setItem('rfcip.me', JSON.stringify(me)); } catch { /* 저장공간 없음 */ }
  } catch (e) {
    if (!e.offline) return renderLogin(e.message);
    const saved = localStorage.getItem('rfcip.me');
    if (!saved) {
      return renderLogin('통신이 되지 않습니다. 통신되는 곳에서 한 번만 로그인해 주십시오.');
    }
    me = JSON.parse(saved);
    state.stale = true;
  }

  try {
    state.user = me.user; state.sites = me.sites;
    if (state.sites.length === 0) return renderLogin('배정된 현장이 없습니다.');
    if (!state.siteId || !state.sites.some((s) => s.id === state.siteId)) {
      if (state.sites.length === 1) {
        state.siteId = state.sites[0].id;
        localStorage.setItem('rfcip.siteId', state.siteId);
      } else return renderSitePicker();
    }
    state.pending = await pendingCount();
    await openMain();
    await flushQueue();
  } catch (e) { renderLogin(e.message); }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
