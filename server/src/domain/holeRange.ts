/**
 * §41 금일 천공번호를 사람이 읽는 범위로 줄인다.
 *   A-031, A-032 … A-044 에서 A-037 만 빠졌다면
 *   → { ranges: 'A-031 ~ A-044', excluded: ['A-037'] }
 *
 * 규칙
 *  - 같은 접두어에서 숫자가 연속이면 하나의 범위다.
 *  - 전체 범위(최소~최대) 안에서 빠진 번호가 적으면(전체의 1/3 이하) '제외' 로 표현한다.
 *    많이 빠졌으면 그냥 범위 여러 개로 나열한다 — '제외 20개' 는 읽을 수 없다.
 *  - 숫자로 안 끝나는 번호는 그대로 나열한다. 형식을 강제하지 않는다.
 */
export interface HoleRange { label: string; excluded: string[] }

const split = (no: string): { prefix: string; num: number | null } => {
  const m = no.match(/^(.*?)(\d+)$/);
  return m ? { prefix: m[1]!, num: Number(m[2]) } : { prefix: no, num: null };
};

export function compressHoleNumbers(holeNos: string[] | undefined | null): HoleRange {
  const nos = holeNos ?? [];
  if (nos.length === 0) return { label: '', excluded: [] };
  if (nos.length === 1) return { label: nos[0]!, excluded: [] };

  const byPrefix = new Map<string, { no: string; num: number }[]>();
  const literal: string[] = [];
  for (const no of nos) {
    const { prefix, num } = split(no);
    if (num === null) { literal.push(no); continue; }
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push({ no, num });
  }

  const parts: string[] = [];
  const excluded: string[] = [];
  for (const [prefix, items] of byPrefix) {
    items.sort((a, b) => a.num - b.num);
    const min = items[0]!, max = items[items.length - 1]!;
    const span = max.num - min.num + 1;
    const missing = span - items.length;

    if (missing === 0) {
      parts.push(items.length === 1 ? min.no : `${min.no} ~ ${max.no}`);
    } else if (missing <= Math.max(1, Math.floor(items.length / 3))) {
      // 빠진 번호가 적다 → '범위 + 제외'
      parts.push(`${min.no} ~ ${max.no}`);
      const have = new Set(items.map((i) => i.num));
      const width = String(max.num).length === String(min.num).length
        && min.no.length === max.no.length ? min.no.length - prefix.length : 0;
      for (let n = min.num + 1; n < max.num; n++) {
        if (!have.has(n)) {
          excluded.push(prefix + (width ? String(n).padStart(width, '0') : String(n)));
        }
      }
    } else {
      // 많이 빠졌다 → 연속 구간별로 나열
      let start = items[0]!;
      let prev = items[0]!;
      for (const it of items.slice(1)) {
        if (it.num === prev.num + 1) { prev = it; continue; }
        parts.push(start.no === prev.no ? start.no : `${start.no} ~ ${prev.no}`);
        start = it; prev = it;
      }
      parts.push(start.no === prev.no ? start.no : `${start.no} ~ ${prev.no}`);
    }
  }
  parts.push(...literal);
  return { label: parts.join(', '), excluded };
}
