/**
 * 산출근거 시트 파싱 — Master Prompt §12, §14
 *
 * 산출근거는 지층별 집계와 파생 공종을 담는다.
 * 여기서는 **천공조서와 대조할 지층별 총연장만** 뽑는다.
 * 파생 공종(케이싱/H-Pile/콘크리트 등)은 PHASE 4 범위가 아니다.
 *
 * AI/파서는 후보를 제안할 뿐이다. 확정은 사람이 한다 (§45).
 */
import type ExcelJS from 'exceljs';
import { normalizeHeader, readCell } from './cells.js';
import type { BasisTotal, DesignParam } from './types.js';

const MAX_ROW = 200;
const MAX_COL = 45;

/**
 * 지층명 후보 목록을 받아, 산출근거에서 그 이름이 나오는 행의
 * 첫 번째 숫자를 총연장 후보로 본다.
 */
export function parseBasisTotals(ws: ExcelJS.Worksheet, layerLabels: string[]): BasisTotal[] {
  const wanted = new Map(layerLabels.map((l) => [normalizeHeader(l), l]));
  const out: BasisTotal[] = [];
  const seen = new Set<string>();
  const lastRow = Math.min(ws.rowCount || MAX_ROW, MAX_ROW);
  const lastCol = Math.min(ws.columnCount || MAX_COL, MAX_COL);

  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= Math.min(lastCol, 4); c++) {
      const cell = readCell(ws, r, c);
      if (cell.isEmpty) continue;
      const label = wanted.get(normalizeHeader(cell.text));
      if (!label || seen.has(label)) continue;

      for (let cc = c + 1; cc <= lastCol; cc++) {
        const v = readCell(ws, r, cc);
        if (v.number !== null) {
          out.push({ label, total: Number(v.number.toFixed(3)), source_row: r });
          seen.add(label);
          break;
        }
      }
      break;
    }
  }
  return out;
}

const PARAM_UNIT = /^(m|m2|m3|㎡|㎥|%|공|본|ea|개소|회)$/i;

/**
 * 시트 우측 등에 있는 '구분 / 값 / 단위 / 비고' 형태의 설계 파라미터 블록을 찾는다.
 * 값이 숫자이고 바로 옆이 단위처럼 보이는 행을 후보로 삼는다.
 */
export function parseDesignParams(ws: ExcelJS.Worksheet): DesignParam[] {
  const out: DesignParam[] = [];
  const lastRow = Math.min(ws.rowCount || MAX_ROW, MAX_ROW);
  const lastCol = Math.min(ws.columnCount || MAX_COL, MAX_COL);

  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c < lastCol - 1; c++) {
      const label = readCell(ws, r, c);
      const value = readCell(ws, r, c + 1);
      const unit = readCell(ws, r, c + 2);
      if (label.isEmpty || label.number !== null) continue;
      if (value.number === null) continue;
      if (unit.isEmpty || !PARAM_UNIT.test(unit.text)) continue;

      const note = readCell(ws, r, c + 3);
      out.push({
        label: label.text,
        value: Number(value.number.toFixed(6)),
        unit: unit.text,
        note: note.isEmpty ? null : note.text,
        source_row: r,
      });
      break;
    }
  }
  return out;
}
