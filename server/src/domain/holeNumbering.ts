/**
 * 천공번호 생성 — Master Prompt §10, §19, §46
 *
 * 천공번호 형식은 현장·도면마다 다르다. (실제 조서 확인: '1'~'29', '1.1'~'3.9')
 * 따라서 시스템은 형식을 강제하지 않고 두 가지 입력방법만 제공한다.
 *
 *   LIST  : 작업도면(PDF)에 표기된 번호를 그대로 나열     ← 기본이자 권장
 *   RANGE : 접두어 + 시작~끝 + 자릿수 + 접미어 (+ 제외)   ← 규칙적인 현장의 편의기능
 *
 * 순수 함수다. 같은 입력이면 항상 같은 결과가 나온다 (§46).
 */

export interface ListSpec {
  mode: 'LIST';
  /** 줄바꿈/쉼표/공백 어떤 것으로 구분해도 된다. */
  numbers: string[];
}

export interface RangeSpec {
  mode: 'RANGE';
  prefix?: string;
  suffix?: string;
  start: number;
  end: number;
  /** 자릿수 0 이면 0 채움 없음 ('1','2'…), 3 이면 '001','002'… */
  digits?: number;
  step?: number;
  /** 제외번호 (§19) — 접두어 없이 숫자만, 또는 완성된 번호 둘 다 허용 */
  exclude?: (string | number)[];
}

export type HoleNumberSpec = ListSpec | RangeSpec;

export class HoleNumberError extends Error {}

const MAX_HOLES = 5000;

/** 여러 줄/쉼표로 붙여넣은 번호 문자열을 배열로 만든다. */
export function parseNumberList(raw: string): string[] {
  return raw
    .split(/[\n,;\t]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function generateHoleNumbers(spec: HoleNumberSpec): string[] {
  if (spec.mode === 'LIST') {
    const cleaned = spec.numbers.map((n) => n.trim()).filter((n) => n.length > 0);
    if (cleaned.length === 0) throw new HoleNumberError('천공번호가 하나도 입력되지 않았습니다.');
    if (cleaned.length > MAX_HOLES) {
      throw new HoleNumberError(`한 번에 등록할 수 있는 천공번호는 ${MAX_HOLES}개까지입니다.`);
    }
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const n of cleaned) {
      if (seen.has(n)) dup.add(n);
      seen.add(n);
    }
    if (dup.size > 0) {
      throw new HoleNumberError(`입력 목록에 중복된 번호가 있습니다: ${[...dup].join(', ')}`);
    }
    return cleaned;
  }

  const { prefix = '', suffix = '', start, end, digits = 0, step = 1 } = spec;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new HoleNumberError('시작번호와 종료번호는 정수여야 합니다.');
  }
  if (start < 0 || end < 0) throw new HoleNumberError('번호는 0 이상이어야 합니다.');
  if (end < start) throw new HoleNumberError('종료번호가 시작번호보다 작습니다.');
  if (!Number.isInteger(step) || step < 1) throw new HoleNumberError('증가폭은 1 이상의 정수여야 합니다.');
  if (digits < 0 || digits > 10) throw new HoleNumberError('자릿수는 0~10 사이여야 합니다.');

  const count = Math.floor((end - start) / step) + 1;
  if (count > MAX_HOLES) {
    throw new HoleNumberError(`한 번에 등록할 수 있는 천공번호는 ${MAX_HOLES}개까지입니다. (요청 ${count}개)`);
  }

  // 제외번호는 '37' 처럼 숫자만 써도, 'A-037' 처럼 완성형으로 써도 인식한다.
  const excluded = new Set<string>();
  for (const e of spec.exclude ?? []) {
    const raw = String(e).trim();
    if (raw.length === 0) continue;
    excluded.add(raw);
    const asNum = Number(raw);
    if (Number.isInteger(asNum)) excluded.add(format(prefix, asNum, digits, suffix));
  }

  const out: string[] = [];
  for (let n = start; n <= end; n += step) {
    const value = format(prefix, n, digits, suffix);
    if (excluded.has(value) || excluded.has(String(n))) continue;
    out.push(value);
  }
  if (out.length === 0) throw new HoleNumberError('제외 후 남는 천공번호가 없습니다.');
  return out;
}

function format(prefix: string, n: number, digits: number, suffix: string): string {
  const body = digits > 0 ? String(n).padStart(digits, '0') : String(n);
  return `${prefix}${body}${suffix}`;
}

/**
 * 자연정렬 키. DB의 core.fn_natural_sort_key 와 동일한 규칙이어야 한다.
 * 미리보기 정렬을 서버에서 DB 왕복 없이 보여주기 위해 사용한다.
 */
export function naturalSortKey(text: string): string {
  return (text.match(/[0-9]+|[^0-9]+/g) ?? [])
    .map((tok) => (/^[0-9]+$/.test(tok) ? tok.padStart(12, '0') : tok))
    .join('');
}

export function sortHoleNumbers(numbers: string[]): string[] {
  return [...numbers].sort((a, b) => {
    const ka = naturalSortKey(a);
    const kb = naturalSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
