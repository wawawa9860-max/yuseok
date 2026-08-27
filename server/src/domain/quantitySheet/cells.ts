/**
 * 엑셀 셀 읽기 유틸 — Master Prompt §12
 *
 * 원본의 산출방식과 표기를 바꾸지 않는 것이 최우선이다.
 * 특히 "표기 원문 복원"이 중요하다. 엑셀은 1.1, 1.2 … 1.9 다음의 2.0 을
 * 숫자 2 로 저장하고 서식도 General 로 남기기 때문에,
 * 셀 하나만 봐서는 원래 표기를 알 수 없다.
 * → 같은 열의 다른 값들이 몇 자리 소수를 쓰는지 보고 복원한다.
 */
import type ExcelJS from 'exceljs';

export interface CellValue {
  /** 원본 그대로 (수식이면 계산결과) */
  raw: unknown;
  /** 사람이 읽는 문자열 */
  text: string;
  /** 숫자로 해석 가능하면 숫자, 아니면 null */
  number: number | null;
  numFmt: string | null;
  isEmpty: boolean;
}

/** 수식 셀은 결과값을, 병합 셀은 대표값을 돌려준다 (ExcelJS 가 자동 처리). */
export function readCell(ws: ExcelJS.Worksheet, row: number, col: number): CellValue {
  const cell = ws.getCell(row, col);
  let v: unknown = cell.value;

  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) v = o.result;               // 수식
    else if ('text' in o) v = o.text;              // 하이퍼링크
    else if ('richText' in o) {
      v = (o.richText as { text: string }[]).map((t) => t.text).join('');
    }
  }

  const isEmpty = v === null || v === undefined || String(v).trim() === '';
  const text = isEmpty ? '' : String(v).trim();
  const number = typeof v === 'number' && Number.isFinite(v)
    ? v
    : (!isEmpty && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null);

  return { raw: v, text, number, numFmt: cell.numFmt ?? null, isEmpty };
}

/** 공백·전각공백을 없애고 소문자로. 헤더 문자열 비교용. */
export function normalizeHeader(s: string): string {
  return s.replace(/[\s　 ]+/g, '').toLowerCase();
}

/** 숫자의 소수 자릿수 (문자열 표기 기준). */
export function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * 한 열의 숫자들이 쓰는 최대 소수 자릿수.
 * 1.1 / 1.9 / 2 가 섞여 있으면 1 을 돌려준다 → 2 를 '2.0' 으로 복원할 근거.
 */
export function inferColumnDecimals(
  ws: ExcelJS.Worksheet, col: number, fromRow: number, toRow: number,
): number {
  let max = 0;
  for (let r = fromRow; r <= toRow; r++) {
    const c = readCell(ws, r, col);
    if (c.number !== null) max = Math.max(max, decimalPlaces(c.number));
  }
  return max;
}

/**
 * 천공번호 표기 복원.
 * 숫자 셀이면 열의 소수 자릿수에 맞춰 되살리고, 문자열이면 원문 그대로 둔다.
 */
export function restoreLabel(cell: CellValue, decimals: number): string {
  if (cell.number !== null && typeof cell.raw === 'number') {
    return cell.number.toFixed(decimals);
  }
  return cell.text;
}
