/**
 * 작업도면(PDF)에서 천공번호 라벨을 뽑는다 — Master Prompt §13, §14
 *
 * 도면의 번호 표기는 현장마다 다르다. 실제 샘플에서 확인된 형태:
 *   H-PILE : '1' '2' … '54'
 *   무근    : '1' + '-1'  → 두 조각으로 그려져 있다
 *
 * 따라서 "붙어 있는 글자 조각을 하나의 라벨로 합치는" 규칙이 필요하다.
 * 간격 임계값을 절대값(pt)으로 두면 축척이 다른 도면에서 깨지므로
 * **글자 크기에 대한 비율**로 판단한다.
 *
 * 시스템은 번호 체계를 해석하지 않는다. 도면에 적힌 문자열을 그대로 모을 뿐이다.
 */
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface DrawingLabel {
  text: string;
  page: number;
  x: number;
  y: number;
  font_size: number;
}

export interface ExtractOptions {
  /** 같은 줄로 볼 세로 오차 (글자 크기 대비 비율) */
  lineTolerance?: number;
  /** 한 라벨로 합칠 가로 간격 상한 (글자 크기 대비 비율) */
  joinGapRatio?: number;
}

interface Piece { str: string; x: number; y: number; w: number; size: number; page: number }

const DEFAULTS = { lineTolerance: 0.35, joinGapRatio: 0.6 } as const;

export async function extractDrawingLabels(
  data: Uint8Array, opts: ExtractOptions = {},
): Promise<{ labels: DrawingLabel[]; page_count: number; piece_count: number }> {
  const lineTolerance = opts.lineTolerance ?? DEFAULTS.lineTolerance;
  const joinGapRatio = opts.joinGapRatio ?? DEFAULTS.joinGapRatio;

  // pdf.js 는 넘겨받은 버퍼를 detach(전송)해 버린다.
  // 호출자의 버퍼를 파괴하지 않도록 사본을 넘긴다 — 같은 파일을 두 번 읽을 수 있어야 한다.
  const doc = await getDocument({
    data: Uint8Array.from(data), useSystemFonts: true, isEvalSupported: false,
  }).promise;
  const pieces: Piece[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    for (const item of content.items) {
      const it = item as { str: string; transform: number[]; width: number; height: number };
      const str = it.str?.trim();
      if (!str) continue;
      // 회전·기울기를 반영해 실제 화면 좌표로 변환한다.
      const m = Util.transform(viewport.transform, it.transform);
      const size = Math.hypot(m[2]!, m[3]!) || it.height || 1;
      pieces.push({ str, x: m[4]!, y: m[5]!, w: it.width, size, page: p });
    }
  }

  // 같은 줄끼리 모아 왼쪽부터 정렬한 뒤, 가까운 조각을 하나의 라벨로 합친다.
  pieces.sort((a, b) => (a.page - b.page) || (a.y - b.y) || (a.x - b.x));
  const labels: DrawingLabel[] = [];
  let current: Piece[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    labels.push({
      text: current.map((c) => c.str).join(''),
      page: first.page,
      x: Number(first.x.toFixed(2)),
      y: Number(first.y.toFixed(2)),
      font_size: Number(first.size.toFixed(2)),
    });
    current = [];
  };

  for (const piece of pieces) {
    const prev = current[current.length - 1];
    if (!prev) { current = [piece]; continue; }
    const sameLine = prev.page === piece.page
      && Math.abs(prev.y - piece.y) <= piece.size * lineTolerance;
    const gap = piece.x - (prev.x + prev.w);
    if (sameLine && gap <= piece.size * joinGapRatio) {
      current.push(piece);
    } else {
      flush();
      current = [piece];
    }
  }
  flush();

  return { labels, page_count: doc.numPages, piece_count: pieces.length };
}

/** 천공번호로 볼 수 있는 라벨만 고른다. 형식은 강제하지 않는다. */
const HOLE_LIKE = /^[A-Za-z가-힣]{0,6}[-–—]?\d+(?:[-–—.]\d+)*[A-Za-z가-힣]{0,4}$/;

export function filterHoleLabels(labels: DrawingLabel[]): DrawingLabel[] {
  return labels.filter((l) => {
    const t = l.text.replace(/\s+/g, '');
    return t.length > 0 && t.length <= 20 && /\d/.test(t) && HOLE_LIKE.test(t);
  }).map((l) => ({ ...l, text: l.text.replace(/\s+/g, '').replace(/[–—]/g, '-') }));
}
