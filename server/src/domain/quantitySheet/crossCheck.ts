/**
 * 산출근거 ↔ 천공조서 교차검증 — Master Prompt §14, §43
 *
 * 실제 샘플에서 확인된 관계:
 *   산출근거 토사 876.12 = 조서 H-PILE 438.06 + 무근 438.06
 *   산출근거 풍화암 147.30 = 조서 H-PILE 73.65 + 무근 73.65
 *
 * 불일치는 차단하지 않고 본사에 보고한다 (§43: 현장에 모든 경고를 보이지 않는다).
 */
import type { BasisTotal, ScheduleBlock } from './types.js';

export interface CrossCheckLine {
  label: string;
  basis_total: number | null;
  schedule_total: number;
  difference: number | null;
  match: boolean | null;
}

export interface CrossCheckResult {
  lines: CrossCheckLine[];
  grand_schedule_total: number;
  issues: { code: string; severity: string; message: string }[];
}

const round3 = (n: number) => Number(n.toFixed(3));
const TOLERANCE = 0.011;   // 조서가 소수 2자리로 반올림되어 있어 1cm 단위 오차를 허용한다

export function crossCheck(blocks: ScheduleBlock[], basisTotals: BasisTotal[]): CrossCheckResult {
  const scheduleTotals = new Map<string, number>();
  for (const b of blocks) {
    for (const t of b.computed_totals) {
      scheduleTotals.set(t.label, round3((scheduleTotals.get(t.label) ?? 0) + t.total));
    }
  }
  const basisMap = new Map(basisTotals.map((b) => [b.label, b.total]));
  const issues: CrossCheckResult['issues'] = [];
  const lines: CrossCheckLine[] = [];

  for (const [label, scheduleTotal] of scheduleTotals) {
    const basisTotal = basisMap.get(label) ?? null;
    if (basisTotal === null) {
      lines.push({ label, basis_total: null, schedule_total: scheduleTotal, difference: null, match: null });
      if (scheduleTotal > 0) {
        issues.push({
          code: 'BASIS_TOTAL_NOT_FOUND', severity: 'WARN',
          message: `산출근거에서 '${label}' 의 총연장을 찾지 못해 대조하지 못했습니다.`,
        });
      }
      continue;
    }
    const diff = round3(scheduleTotal - basisTotal);
    const match = Math.abs(diff) <= TOLERANCE;
    lines.push({ label, basis_total: basisTotal, schedule_total: scheduleTotal, difference: diff, match });
    if (!match) {
      issues.push({
        code: 'BASIS_SCHEDULE_MISMATCH', severity: 'ERROR',
        message: `${label}: 산출근거 ${basisTotal}m 와 천공조서 합계 ${scheduleTotal}m 가 `
          + `${diff > 0 ? '+' : ''}${diff}m 다릅니다.`,
      });
    }
  }

  for (const [label, total] of basisMap) {
    if (!scheduleTotals.has(label)) {
      issues.push({
        code: 'SCHEDULE_LAYER_MISSING', severity: 'WARN',
        message: `산출근거에는 '${label}' ${total}m 가 있으나 천공조서에는 해당 지층 열이 없습니다.`,
      });
    }
  }

  return {
    lines: lines.sort((a, b) => b.schedule_total - a.schedule_total),
    grand_schedule_total: round3([...scheduleTotals.values()].reduce((a, b) => a + b, 0)),
    issues,
  };
}
