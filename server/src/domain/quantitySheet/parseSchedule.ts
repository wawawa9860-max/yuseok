/**
 * 천공조서 파싱 — Master Prompt §12
 *
 * 실제 조서는 다음 구조를 갖는다(업로드 샘플 확인).
 *   · 헤더가 3행에 걸친 병합 구조
 *   · 좌·우로 천공종류가 다른 블록이 나란히 배치
 *   · 지층 하나가 [공당 | 소계] 두 열을 차지
 *
 * 특정 시트의 좌표를 하드코딩하지 않는다. 헤더 문구로 구조를 찾아낸다.
 */
import type ExcelJS from 'exceljs';
import {
  decimalPlaces, inferColumnDecimals, normalizeHeader, readCell, restoreLabel,
} from './cells.js';
import type { LayerColumn, ScheduleBlock, ScheduleRow } from './types.js';

const ID_HEADER = /^(pileno\.?|천공번호|공번호|holeno\.?|no\.?)$/;
const PER_HOLE = /^(공당|공\/당|perhole)$/;
const SUBTOTAL = /^(소계|subtotal)$/;
const GRAND_TOTAL = /^(합계|계|total)$/;

const MAX_HEADER_SCAN = 30;
const MAX_COL_SCAN = 80;
const MAX_DATA_ROWS = 5000;

/** 'PILE NO.' 처럼 천공번호를 뜻하는 헤더가 있는 셀을 모두 찾는다. */
function findIdHeaders(ws: ExcelJS.Worksheet): { row: number; col: number }[] {
  const found: { row: number; col: number }[] = [];
  const lastRow = Math.min(ws.rowCount || MAX_HEADER_SCAN, MAX_HEADER_SCAN);
  const lastCol = Math.min(ws.columnCount || MAX_COL_SCAN, MAX_COL_SCAN);
  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= lastCol; c++) {
      const cell = readCell(ws, r, c);
      if (cell.isEmpty) continue;
      if (ID_HEADER.test(normalizeHeader(cell.text))) {
        // 병합으로 같은 값이 반복되므로 바로 옆/아래 중복은 건너뛴다
        if (found.some((f) => f.col === c)) continue;
        found.push({ row: r, col: c });
      }
    }
  }
  return found.sort((a, b) => a.col - b.col);
}

/** 블록 범위 안에서 '공당/소계/합계' 가 늘어선 행을 찾는다. */
function findMeasureRow(
  ws: ExcelJS.Worksheet, fromCol: number, toCol: number, headerRow: number,
): number | null {
  for (let r = headerRow; r <= headerRow + 5; r++) {
    let hits = 0;
    for (let c = fromCol; c <= toCol; c++) {
      const t = normalizeHeader(readCell(ws, r, c).text);
      if (PER_HOLE.test(t) || SUBTOTAL.test(t)) hits++;
    }
    if (hits >= 2) return r;
  }
  return null;
}

function collectLayers(
  ws: ExcelJS.Worksheet, measureRow: number, layerRow: number,
  fromCol: number, toCol: number,
): { layers: LayerColumn[]; totalCol: number | null } {
  const layers: LayerColumn[] = [];
  let totalCol: number | null = null;

  for (let c = fromCol; c <= toCol; c++) {
    const t = normalizeHeader(readCell(ws, measureRow, c).text);
    if (PER_HOLE.test(t)) {
      const label = readCell(ws, layerRow, c).text;   // 병합은 ExcelJS 가 해결
      const nextIsSubtotal = SUBTOTAL.test(normalizeHeader(readCell(ws, measureRow, c + 1).text));
      layers.push({
        label: label || `열${c}`,
        per_hole_col: c,
        subtotal_col: nextIsSubtotal ? c + 1 : null,
      });
    } else if (GRAND_TOTAL.test(t) && totalCol === null) {
      totalCol = c;
    }
  }
  return { layers, totalCol };
}

/**
 * 데이터 행 끝을 찾는다.
 *
 * 번호가 비는 첫 줄에서 끊는다. 빈 줄을 건너뛰고 계속 읽으면
 * 조서의 **합계행이 데이터 행으로 섞여 들어간다**.
 * (실제 샘플: 합계행 R36 의 번호칸에 공수 '29' 가 적혀 있어
 *  마지막 천공번호 29 와 중복됐다.)
 * 합계행은 findTotalRow 가 따로 찾는다.
 */
function findDataEnd(ws: ExcelJS.Worksheet, idCol: number, from: number): number {
  let last = from - 1;
  for (let r = from; r < from + MAX_DATA_ROWS; r++) {
    if (readCell(ws, r, idCol).isEmpty) break;
    last = r;
  }
  return last;
}

/** 데이터 끝 직후의 합계행을 찾는다 (있을 수도, 없을 수도 있다). */
function findTotalRow(
  ws: ExcelJS.Worksheet, layers: LayerColumn[], dataTo: number, toCol: number,
): number | null {
  for (let r = dataTo + 1; r <= dataTo + 5; r++) {
    let numeric = 0;
    for (const l of layers) {
      const col = l.subtotal_col ?? l.per_hole_col;
      if (col <= toCol && readCell(ws, r, col).number !== null) numeric++;
    }
    if (numeric >= Math.max(1, Math.ceil(layers.length / 2))) return r;
  }
  return null;
}

const round3 = (n: number) => Number(n.toFixed(3));

export function parseScheduleSheet(ws: ExcelJS.Worksheet): ScheduleBlock[] {
  const idHeaders = findIdHeaders(ws);
  if (idHeaders.length === 0) return [];

  const lastCol = Math.min(ws.columnCount || MAX_COL_SCAN, MAX_COL_SCAN);
  const blocks: ScheduleBlock[] = [];

  for (let i = 0; i < idHeaders.length; i++) {
    const h = idHeaders[i]!;
    const next = idHeaders[i + 1];
    const fromCol = h.col;
    const toCol = next ? next.col - 1 : lastCol;

    const measureRow = findMeasureRow(ws, fromCol, toCol, h.row);
    if (measureRow === null) continue;
    const layerRow = measureRow - 1;

    const { layers, totalCol } = collectLayers(ws, measureRow, layerRow, fromCol, toCol);
    if (layers.length === 0) continue;

    const dataFrom = measureRow + 1;
    const dataTo = findDataEnd(ws, h.col, dataFrom);
    if (dataTo < dataFrom) continue;

    // 표기 복원의 근거: 이 열이 쓰는 최대 소수 자릿수
    const idDecimals = inferColumnDecimals(ws, h.col, dataFrom, dataTo);

    // 블록 이름 (예: 'H-PILE 구간 천공 (M)')
    let blockLabel: string | null = null;
    for (let c = fromCol + 1; c <= toCol; c++) {
      const t = readCell(ws, h.row, c).text;
      if (t && !ID_HEADER.test(normalizeHeader(t))) { blockLabel = t; break; }
    }

    const rows: ScheduleRow[] = [];
    for (let r = dataFrom; r <= dataTo; r++) {
      const idAtRow = readCell(ws, r, h.col);
      if (idAtRow.isEmpty) continue;

      const issues: ScheduleRow['issues'] = [];
      const rowLayers: { label: string; planned_length: number }[] = [];
      for (const l of layers) {
        const v = readCell(ws, r, l.per_hole_col).number ?? 0;
        rowLayers.push({ label: l.label, planned_length: round3(v) });
      }
      const layerSum = round3(rowLayers.reduce((a, l) => a + l.planned_length, 0));
      const sheetTotal = totalCol === null ? null : readCell(ws, r, totalCol).number;

      if (sheetTotal !== null && Math.abs(sheetTotal - layerSum) > 0.011) {
        issues.push({
          code: 'ROW_TOTAL_MISMATCH', severity: 'ERROR',
          message: `지층합계 ${layerSum}m 가 조서 합계열 ${sheetTotal}m 와 다릅니다.`,
        });
      }
      if (layerSum <= 0) {
        issues.push({
          code: 'ZERO_DEPTH', severity: 'WARN',
          message: '지층 값이 모두 0 입니다.',
        });
      }

      rows.push({
        source_row: r,
        hole_no_raw: restoreLabel(idAtRow, idDecimals),
        layers: rowLayers,
        layer_sum: layerSum,
        sheet_total: sheetTotal === null ? null : round3(sheetTotal),
        issues,
      });
    }

    const computedTotals = layers.map((l) => ({
      label: l.label,
      total: round3(rows.reduce(
        (a, r) => a + (r.layers.find((x) => x.label === l.label)?.planned_length ?? 0), 0)),
    }));

    const totalRow = findTotalRow(ws, layers, dataTo, toCol);
    const sheetTotals = totalRow === null ? null : layers.map((l) => ({
      label: l.label,
      total: round3(readCell(ws, totalRow, l.subtotal_col ?? l.per_hole_col).number ?? 0),
    }));

    // 합계행의 '합계' 열과 번호칸은 지층 소계와 별개의 수식을 쓰는 경우가 많다.
    // 수식 범위가 낡으면 여기만 틀리므로 반드시 따로 대조한다.
    const sheetGrandTotal = (totalRow !== null && totalCol !== null)
      ? readCell(ws, totalRow, totalCol).number : null;
    const sheetHoleCount = totalRow !== null
      ? readCell(ws, totalRow, h.col).number : null;

    blocks.push({
      block_key: ws.getColumn(h.col).letter,
      block_label: blockLabel,
      id_column: h.col,
      id_header_row: h.row,
      layer_header_row: layerRow,
      measure_row: measureRow,
      data_from: dataFrom,
      data_to: dataTo,
      id_decimals: idDecimals,
      layers,
      total_col: totalCol,
      rows,
      computed_totals: computedTotals,
      computed_grand_total: round3(rows.reduce((a, r) => a + r.layer_sum, 0)),
      sheet_totals: sheetTotals,
      sheet_total_row: totalRow,
      sheet_grand_total: sheetGrandTotal === null ? null : round3(sheetGrandTotal),
      sheet_hole_count: sheetHoleCount,
    });
  }

  return blocks;
}

export { decimalPlaces };
