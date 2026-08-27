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
  stale: false,
  previewOffline: false,
  defaults: { labor: [], equipment: [] },
  laborSame: null, laborChanges: [],
  equipSame: null, equipChanges: [],
  readyMix: null,
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
    <button class="later" disabled>천공현황 / 도면 · 준비중</button>
    <button id="goCost">비용 · 증빙</button>
    <button class="later" disabled>특이사항 · 준비중</button>
    <button class="later" disabled>오늘 보고서 · 준비중</button>
    <button class="later" disabled>카카오톡 공유 · 준비중</button>
    <div class="spacer"></div>
    <button class="ghost" id="switchSite">다른 현장 / 로그아웃</button>`;

  $('#goInput').onclick = openInput;
  $('#goCost').onclick = openCost;
  $('#switchSite').onclick = () => {
    if (state.sites.length > 1) { renderSitePicker(); } else { logout(); renderLogin(); }
  };
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

/** §21/§22 '아니오' 일 때만 나온다. 바뀐 것만 적는다. */
function renderDefaultEditor(kind) {
  const isLabor = kind === 'labor';
  const box = $(isLabor ? '#laborDetail' : '#equipDetail');
  if (!box) return;
  const list = isLabor ? state.defaults.labor : state.defaults.equipment;
  const changes = isLabor ? state.laborChanges : state.equipChanges;
  const keyOf = (x) => (isLabor ? x.role_name : x.equipment_name);
  const valOf = (x) => (isLabor ? x.headcount : x.quantity);
  const changed = new Map(changes.map((c) => [keyOf(c), isLabor ? c.headcount : c.quantity]));

  if (list.length === 0) {
    box.innerHTML = '<p class="muted" style="font-size:17px">기본설정이 없습니다. 본사에 등록을 요청하십시오.</p>';
    return;
  }
  box.innerHTML = `
    <p class="muted" style="font-size:17px;margin-top:12px">바뀐 것만 적으십시오.</p>
    <div class="rowlist">
      ${list.map((x) => `
        <div class="row"><span class="no">${keyOf(x)}</span>
          <input inputmode="decimal" data-key="${keyOf(x)}"
                 placeholder="${valOf(x)}" value="${changed.get(keyOf(x)) ?? ''}"></div>`).join('')}
    </div>`;
  box.querySelectorAll('input[data-key]').forEach((i) => {
    i.onchange = () => {
      const key = i.dataset.key;
      const v = i.value.trim();
      const arr = isLabor ? state.laborChanges : state.equipChanges;
      const idx = arr.findIndex((c) => keyOf(c) === key);
      if (v === '') { if (idx >= 0) arr.splice(idx, 1); return; }
      const entry = isLabor ? { role_name: key, headcount: v } : { equipment_name: key, quantity: v };
      if (idx >= 0) arr[idx] = entry; else arr.push(entry);
    };
  });
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
    .map(([hole_no, actual_depth_total]) => ({ hole_no, actual_depth_total }));
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
    state.pending = await pendingCount();
    await openMain();
    await flushQueue();
  } catch (e) { renderLogin(e.message); }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
