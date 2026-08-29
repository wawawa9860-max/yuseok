/**
 * PHASE 14 — 카카오톡 메시지 본문 (Master Prompt §40, §41, §42, §46)
 *
 * §42 "카카오톡을 파일 저장소처럼 사용하지 않는다.
 *      핵심 작업정보 + 대표 상태 + 상세보기 링크만 제공한다."
 *
 * 메시지는 결정론적 문자열 조립이다. 값은 전부 서버가 이미 계산한 것을 쓴다.
 * 여기서 새로 계산하지 않는다 (§46).
 */

export interface ShareStatus {
  report_date: string;
  site: { site_name: string };
  today: { hole_count: number; length: string } | null;
  today_hole_numbers?: string[];
  cumulative: { completed_holes: number; total_holes: number; progress_rate: string };
  by_ground_type: { ground_type_name: string; completed_length: string }[];
  ready_mix: { quantity_m3: string; has_delay: boolean;
               delay_minutes: number | null; delay_reason: string | null } | null;
  notes: { type: string; detail: string }[];
  next_day_plan: string | null;
}

export interface HoleRangeLabel { label: string; excluded: string[] }

const dateLabel = (iso: string): string => {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(m)}월${Number(d)}일`;
};
const n1 = (v: string | number | null | undefined): string =>
  Number(v ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 });

/** §41 계약상대방용. 원가는 입력 자체에 존재하지 않는다 (share 스키마 산출물만 받는다). */
export function externalMessage(d: ShareStatus, range: HoleRangeLabel, shareUrl: string): string {
  const lines: string[] = [];
  // 현장명에 이미 'RF CIP' 가 들어 있으면 겹쳐 쓰지 않는다
  const title = /RF\s*CIP/i.test(d.site.site_name)
    ? `${d.site.site_name} 작업현황` : `${d.site.site_name} RF CIP 작업현황`;
  lines.push(`[${title}]`);
  lines.push('');
  lines.push(d.report_date.slice(0, 10).replace(/-/g, '.'));
  lines.push('');
  lines.push('금일');
  lines.push(`${d.today?.hole_count ?? 0}공 / ${n1(d.today?.length)}m`);
  lines.push('');
  lines.push('누계');
  lines.push(`${d.cumulative.completed_holes}공`);
  lines.push(`공정률 ${n1(d.cumulative.progress_rate)}%`);

  if (range.label) {
    lines.push('');
    lines.push('금일 천공번호');
    lines.push(range.label);
    if (range.excluded.length) lines.push(`제외 ${range.excluded.join(', ')}`);
  }
  if (d.ready_mix) {
    lines.push('');
    lines.push('레미콘');
    lines.push(`${n1(d.ready_mix.quantity_m3)}㎥`);
  }
  if (d.notes.length) {
    lines.push('');
    lines.push('특이사항');
    for (const note of d.notes) lines.push(`${note.type} ${note.detail}`.trim());
  }
  if (d.next_day_plan) {
    lines.push('');
    lines.push('익일계획');
    lines.push(d.next_day_plan);
  }
  lines.push('');
  lines.push(`[작업현황 상세보기]\n${shareUrl}`);
  return lines.join('\n');
}

export interface EvidenceCounts { total_count: number; verified_count: number; pending_count: number }

/**
 * §40 본사용. "내부 원가의 구체적인 금액을 기본적으로 직접 넣지 않는다."
 * 그래서 본사전용 블록에도 '건수' 만 들어간다. 금액은 상세보기(본사 인증) 뒤에서 본다.
 */
export function internalMessage(
  d: ShareStatus, range: HoleRangeLabel, evidence: EvidenceCounts,
  detailUrl: string, costUrl: string,
): string {
  const lines: string[] = [];
  lines.push(`[${d.site.site_name} / ${dateLabel(d.report_date)}]`);
  lines.push('');
  lines.push('금일');
  lines.push(`${d.today?.hole_count ?? 0}공 / ${n1(d.today?.length)}m`);
  lines.push('');
  lines.push('누계');
  lines.push(`${d.cumulative.completed_holes}공`);
  lines.push(`공정률 ${n1(d.cumulative.progress_rate)}%`);

  if (d.by_ground_type.length) {
    lines.push('');
    lines.push('지층별 계획실적');
    for (const g of d.by_ground_type) {
      lines.push(`${g.ground_type_name} ${n1(g.completed_length)}m`);
    }
  }
  if (d.ready_mix) {
    lines.push('');
    lines.push('레미콘');
    lines.push(`${n1(d.ready_mix.quantity_m3)}㎥`);
  }
  if (d.notes.length) {
    lines.push('');
    lines.push('특이사항');
    for (const note of d.notes) lines.push(`${note.type} ${note.detail}`.trim());
  }
  lines.push('');
  lines.push('본사전용');
  lines.push(`비용등록 ${evidence.total_count}건`);
  lines.push(`증빙완료 ${evidence.verified_count}`);
  lines.push(`증빙대기 ${evidence.pending_count}`);
  lines.push('');
  lines.push(`[현장 상세보기]\n${detailUrl}`);
  lines.push(`[본사 원가 상세보기]\n${costUrl}`);
  return lines.join('\n');
}
