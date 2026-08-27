/**
 * 발췌본 패턴 반복 확장 — 사용자 지시
 *
 * "638.30공이 되어야 맞는데 발췌본이라고 보면 된다. 29공 패턴 반복으로 진행합니다."
 *
 * 발췌본 N공의 지층 깊이를 대상 공수만큼 순환 적용한다.
 * 번호 생성은 PHASE 2 에서 검증된 순수 함수를 그대로 쓴다.
 *
 * 이것은 **계약수량을 만들어내는 조작**이므로 절대 자동 실행하지 않는다.
 * 미리보기로 결과를 보여주고 사용자가 승인해야만 저장된다 (§8, §12, §45).
 */
import { generateHoleNumbers, type HoleNumberSpec } from '../holeNumbering.js';
import type { ScheduleRow } from './types.js';

export interface ExpandedRow {
  hole_no: string;
  layers: { label: string; planned_length: number }[];
  layer_sum: number;
  /** 어느 발췌본 행에서 복제되었는지 (추적용) */
  generated_from: string;
}

export interface ExpandResult {
  rows: ExpandedRow[];
  pattern_size: number;
  cycles: number;
  layer_totals: { label: string; total: number }[];
  grand_total: number;
  issues: { code: string; severity: string; message: string }[];
}

const round3 = (n: number) => Number(n.toFixed(3));

export function expandByPattern(
  pattern: ScheduleRow[],
  numbering: HoleNumberSpec,
  holeNoOf: (row: ScheduleRow) => string,
): ExpandResult {
  const issues: ExpandResult['issues'] = [];
  if (pattern.length === 0) {
    return { rows: [], pattern_size: 0, cycles: 0, layer_totals: [], grand_total: 0,
      issues: [{ code: 'EMPTY_PATTERN', severity: 'ERROR', message: '반복할 발췌본 행이 없습니다.' }] };
  }

  const holeNos = generateHoleNumbers(numbering);
  const rows: ExpandedRow[] = holeNos.map((holeNo, i) => {
    const src = pattern[i % pattern.length]!;
    return {
      hole_no: holeNo,
      layers: src.layers.map((l) => ({ ...l })),
      layer_sum: src.layer_sum,
      generated_from: holeNoOf(src),
    };
  });

  const totals = new Map<string, number>();
  for (const r of rows) {
    for (const l of r.layers) {
      totals.set(l.label, round3((totals.get(l.label) ?? 0) + l.planned_length));
    }
  }

  const cycles = rows.length / pattern.length;
  if (!Number.isInteger(cycles)) {
    issues.push({
      code: 'PARTIAL_CYCLE', severity: 'WARN',
      message: `대상 ${rows.length}공은 발췌본 ${pattern.length}공의 배수가 아닙니다. `
        + `마지막 주기는 ${rows.length % pattern.length}공만 사용됩니다.`,
    });
  }
  issues.push({
    code: 'GENERATED_QUANTITY', severity: 'WARN',
    message: `${rows.length}공의 계획심도가 발췌본 ${pattern.length}공을 반복해 생성되었습니다. `
      + '실제 수량산출서 값이 아니므로 승인 전에 반드시 확인하십시오.',
  });

  return {
    rows,
    pattern_size: pattern.length,
    cycles: Number(cycles.toFixed(3)),
    layer_totals: [...totals.entries()].map(([label, total]) => ({ label, total })),
    grand_total: round3(rows.reduce((a, r) => a + r.layer_sum, 0)),
    issues,
  };
}
