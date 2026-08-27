/**
 * 천공번호 표기 변환 — Master Prompt §12, 사용자 지시
 *
 * 원칙: 시스템이 번호 체계를 만들어내지 않는다. 조서 표기를 기계적으로 옮길 뿐이다.
 *
 * 사용자 지시: "무근 표기는 1-1, 1-2, 1-3 형식으로 진행할 예정"
 * → 조서의 소수 연번(1.1, 1.2 …)을 점 대신 하이픈으로 바꾸는 변환을 제공한다.
 *   이때 2.0 은 기계적으로 '2-0' 이 된다. 이것이 의도한 표기가 아니라면
 *   사용자가 다른 모드를 고르도록 경고를 띄운다. 추측해서 바꾸지 않는다.
 */
export type HoleNoStyle = 'RAW' | 'DECIMAL_TO_DASH';

export interface ConvertResult {
  hole_no: string;
  notes: { code: string; severity: string; message: string }[];
}

export function convertHoleNo(raw: string, style: HoleNoStyle): ConvertResult {
  if (style === 'RAW') return { hole_no: raw, notes: [] };

  const m = /^(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return { hole_no: raw, notes: [] };

  const [, major, minor] = m;
  const holeNo = `${major}-${minor}`;
  const notes: ConvertResult['notes'] = [];
  if (minor === '0') {
    notes.push({
      code: 'DASH_ZERO_INDEX', severity: 'WARN',
      message: `${raw} → ${holeNo} 로 변환했습니다. 조서의 '${raw}' 는 앞 군의 마지막 번호를 `
        + `뜻할 수도 있습니다. 의도한 표기가 맞는지 확인하십시오.`,
    });
  }
  return { hole_no: holeNo, notes };
}

export function convertAll(raws: string[], style: HoleNoStyle) {
  const converted = raws.map((r) => convertHoleNo(r, style));
  const holeNos = converted.map((c) => c.hole_no);
  const notes = converted.flatMap((c) => c.notes);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const n of holeNos) {
    if (seen.has(n)) duplicates.add(n);
    seen.add(n);
  }
  if (duplicates.size > 0) {
    notes.push({
      code: 'DUPLICATE_AFTER_CONVERT', severity: 'ERROR',
      message: `변환 후 중복된 번호가 생깁니다: ${[...duplicates].join(', ')}`,
    });
  }
  return { hole_nos: holeNos, notes };
}
