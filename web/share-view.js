/*
 * §41 계약상대방 작업현황 페이지 — 로그인 없음, 토큰만으로 연다.
 * 여기 나오는 것은 share 스키마가 내려주는 것뿐이다. 원가는 구조적으로 없다.
 */
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const num = (v) => Number(v ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 });

const token = location.pathname.split('/').pop();

async function load() {
  let r;
  try { r = await fetch(`/api/share/${token}`); }
  catch {
    app.innerHTML = '<div class="card"><div class="notice error">통신이 되지 않습니다. 잠시 후 다시 열어 주십시오.</div></div>';
    return;
  }
  if (!r.ok) {
    app.innerHTML = `
      <header class="site"><h1>작업현황</h1></header>
      <div class="card"><div class="notice warn">열람할 수 없는 링크입니다.<br>
        기간이 지났거나 회수된 링크일 수 있습니다. 발신처에 문의해 주십시오.</div></div>`;
    return;
  }
  const d = await r.json();
  const date = String(d.report_date).slice(0, 10).replace(/-/g, '.');

  app.innerHTML = `
    <header class="site">
      <h1>${d.site.site_name}</h1>
      <div class="date">RF CIP 작업현황 · ${date}</div>
    </header>

    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">금일</div>
          <div class="value">${d.today?.hole_count ?? 0}<span class="unit">공</span></div></div>
        <div class="stat"><div class="label">금일 연장</div>
          <div class="value">${num(d.today?.length)}<span class="unit">m</span></div></div>
        <div class="stat"><div class="label">공정률</div>
          <div class="value">${num(d.cumulative.progress_rate)}<span class="unit">%</span></div></div>
      </div>
      <table class="summary">
        <tr><td>누계</td><td class="num">${d.cumulative.completed_holes} / ${d.cumulative.total_holes}공</td></tr>
      </table>
    </div>

    ${d.today_hole_range?.label ? `
    <div class="card">
      <h2>금일 천공번호</h2>
      <table class="summary">
        <tr><td>범위</td><td class="num">${d.today_hole_range.label}</td></tr>
        ${d.today_hole_range.excluded.length
          ? `<tr><td>제외</td><td class="num">${d.today_hole_range.excluded.join(', ')}</td></tr>` : ''}
      </table>
    </div>` : ''}

    ${d.by_ground_type?.length ? `
    <div class="card">
      <h2>지층별 실적</h2>
      <table class="summary">
        ${d.by_ground_type.map((g) =>
          `<tr><td>${g.ground_type_name}</td><td class="num">${num(g.completed_length)} m</td></tr>`).join('')}
      </table>
    </div>` : ''}

    ${d.ready_mix ? `
    <div class="card">
      <h2>레미콘</h2>
      <table class="summary">
        <tr><td>반입량</td><td class="num">${num(d.ready_mix.quantity_m3)} ㎥</td></tr>
      </table>
    </div>` : ''}

    ${d.notes?.length ? `
    <div class="card">
      <h2>특이사항</h2>
      <table class="summary">
        ${d.notes.map((n) => `<tr><td>${n.type}</td><td class="num">${n.detail}</td></tr>`).join('')}
      </table>
    </div>` : ''}

    ${d.next_day_plan ? `
    <div class="card">
      <h2>익일계획</h2>
      <p style="margin:0">${d.next_day_plan}</p>
    </div>` : ''}

    <p class="center muted" style="font-size:15px">이 페이지는 열람 전용입니다.</p>`;
}
load();
