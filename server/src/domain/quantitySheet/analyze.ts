/**
 * 워크북 전체 분석 — Master Prompt §12
 *
 * 절차: 업로드 → 열 구조 분석 → 천공번호 확인 → 지층 후보 확인
 *       → 계획심도 확인 → 미리보기 → 사용자 승인 → HOLE_MASTER 반영
 *
 * 이 모듈은 "분석"까지만 한다. 저장은 하지 않는다.
 */
import ExcelJS from 'exceljs';
import { normalizeHeader } from './cells.js';
import { parseScheduleSheet } from './parseSchedule.js';
import { parseBasisTotals, parseDesignParams } from './parseBasis.js';
import type { SheetAnalysis, WorkbookAnalysis } from './types.js';

const SCHEDULE_HINT = /천공조서|천공\s*조서|drillingschedule|조서/;
const BASIS_HINT = /산출근거|산출\s*근거|basis|근거/;

function classifySheet(name: string): SheetAnalysis['role'] {
  const n = normalizeHeader(name);
  if (SCHEDULE_HINT.test(n)) return 'SCHEDULE';
  if (BASIS_HINT.test(n)) return 'BASIS';
  return 'UNKNOWN';
}

export async function analyzeWorkbook(filePath: string): Promise<WorkbookAnalysis> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheets: SheetAnalysis[] = wb.worksheets.map((ws) => ({
    sheet_name: ws.name, role: classifySheet(ws.name),
  }));
  const warnings: WorkbookAnalysis['warnings'] = [];

  let scheduleSheet = sheets.find((s) => s.role === 'SCHEDULE')?.sheet_name ?? null;
  const basisSheet = sheets.find((s) => s.role === 'BASIS')?.sheet_name ?? null;

  // 시트 이름으로 못 찾으면 'PILE NO.' 헤더가 있는 시트를 조서로 본다.
  if (!scheduleSheet) {
    for (const ws of wb.worksheets) {
      if (parseScheduleSheet(ws).length > 0) {
        scheduleSheet = ws.name;
        warnings.push({
          code: 'SCHEDULE_SHEET_GUESSED', severity: 'WARN',
          message: `시트 이름으로 천공조서를 찾지 못해 '${ws.name}' 을 조서로 판단했습니다. 확인이 필요합니다.`,
        });
        break;
      }
    }
  }

  if (!scheduleSheet) {
    return {
      sheets, schedule_sheet: null, basis_sheet: basisSheet, blocks: [],
      layer_labels: [], basis_totals: [], design_params: [],
      warnings: [...warnings, {
        code: 'NO_SCHEDULE_SHEET', severity: 'ERROR',
        message: '천공번호별 명세(천공조서)를 찾지 못했습니다.',
      }],
    };
  }

  const blocks = parseScheduleSheet(wb.getWorksheet(scheduleSheet)!);
  if (blocks.length === 0) {
    warnings.push({
      code: 'NO_BLOCK_PARSED', severity: 'ERROR',
      message: '천공조서에서 천공번호 블록을 해석하지 못했습니다.',
    });
  }

  // 지층명은 조서에 인쇄된 원문을 쓴다. 시스템이 목록을 강제하지 않는다 (§7).
  const totals = new Map<string, number>();
  for (const b of blocks) {
    for (const t of b.computed_totals) {
      totals.set(t.label, Number(((totals.get(t.label) ?? 0) + t.total).toFixed(3)));
    }
  }
  const layerLabels = [...totals.entries()]
    .map(([label, total]) => ({ label, total, used: total > 0 }));

  const basisTotals = basisSheet
    ? parseBasisTotals(wb.getWorksheet(basisSheet)!, layerLabels.map((l) => l.label))
    : [];

  const designParams = parseDesignParams(wb.getWorksheet(scheduleSheet)!);

  // 조서 내부 정합성: 계산 합계 vs 조서 합계행
  for (const b of blocks) {
    if (!b.sheet_totals) continue;
    for (const st of b.sheet_totals) {
      const computed = b.computed_totals.find((c) => c.label === st.label);
      if (computed && Math.abs(computed.total - st.total) > 0.011) {
        warnings.push({
          code: 'BLOCK_TOTAL_MISMATCH', severity: 'ERROR',
          message: `[${b.block_label ?? b.block_key}] ${st.label}: `
            + `행 합계 ${computed.total}m 가 조서 합계행 ${st.total}m 와 다릅니다.`,
        });
      }
    }
  }

  if (layerLabels.some((l) => !l.used)) {
    warnings.push({
      code: 'ZERO_LAYER_PRESENT', severity: 'INFO',
      message: '값이 0 인 지층 열이 있습니다: '
        + layerLabels.filter((l) => !l.used).map((l) => l.label).join(', ')
        + '. 지층종류로는 등록하되 미확정(PROVISIONAL) 상태로 두는 것을 권장합니다.',
    });
  }

  return {
    sheets, schedule_sheet: scheduleSheet, basis_sheet: basisSheet, blocks,
    layer_labels: layerLabels, basis_totals: basisTotals,
    design_params: designParams, warnings,
  };
}
