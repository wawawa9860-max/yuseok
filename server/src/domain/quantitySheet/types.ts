/** 수량산출서 분석 결과 타입 — Master Prompt §12 */

export interface LayerColumn {
  /** 조서에 인쇄된 지층명 원문 (하드코딩하지 않는다) */
  label: string;
  per_hole_col: number;
  subtotal_col: number | null;
}

export interface ScheduleRow {
  source_row: number;
  /** 셀 표기를 복원한 원문 (2 → '2.0') */
  hole_no_raw: string;
  layers: { label: string; planned_length: number }[];
  layer_sum: number;
  /** 조서의 합계열 값 (있으면) */
  sheet_total: number | null;
  issues: { code: string; severity: string; message: string }[];
}

export interface ScheduleBlock {
  block_key: string;
  block_label: string | null;
  id_column: number;
  id_header_row: number;
  layer_header_row: number;
  measure_row: number;
  data_from: number;
  data_to: number;
  id_decimals: number;
  layers: LayerColumn[];
  total_col: number | null;
  rows: ScheduleRow[];
  /** 계산한 지층별 합계 */
  computed_totals: { label: string; total: number }[];
  computed_grand_total: number;
  /** 조서 합계행에서 읽은 값 (있으면) */
  sheet_totals: { label: string; total: number }[] | null;
  sheet_total_row: number | null;
  /** 조서 합계행의 '합계' 열 값. 지층 소계와 따로 관리되므로 별도로 대조한다. */
  sheet_grand_total: number | null;
  /** 조서 합계행의 번호칸에 적힌 공수 (있으면) */
  sheet_hole_count: number | null;
}

export interface BasisTotal {
  label: string;
  total: number;
  source_row: number;
}

export interface DesignParam {
  label: string;
  value: number;
  unit: string | null;
  note: string | null;
  source_row: number;
}

export interface SheetAnalysis {
  sheet_name: string;
  role: 'SCHEDULE' | 'BASIS' | 'UNKNOWN';
}

export interface WorkbookAnalysis {
  sheets: SheetAnalysis[];
  schedule_sheet: string | null;
  basis_sheet: string | null;
  blocks: ScheduleBlock[];
  /** 조서에서 발견된 지층명 후보 (값이 0인 것 포함) */
  layer_labels: { label: string; total: number; used: boolean }[];
  basis_totals: BasisTotal[];
  design_params: DesignParam[];
  warnings: { code: string; severity: string; message: string }[];
}
