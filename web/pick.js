/**
 * 천공번호 범위 고르기 규칙 — Master Prompt §19, §1-12
 *
 * 브라우저와 테스트가 같은 코드를 쓰도록 따로 뺐다.
 * 이 규칙이 어긋나면 현장에서 범위가 잘못 잡혀 수량이 틀어진다.
 *
 * 시작번호는 "다음에 뚫을 번호"로 미리 채워져 있다 (§1-5).
 * 그래서 보통은 종료번호 하나만 누르면 범위가 완성된다.
 */
export function nextPick(current, holeNos, tapped) {
  const at = (n) => holeNos.indexOf(n);
  if (at(tapped) < 0) return current;                       // 목록에 없는 번호는 무시
  if (!current.from || current.to) return { from: tapped, to: null };
  if (at(tapped) < at(current.from)) return { from: tapped, to: null };
  return { from: current.from, to: tapped };
}

/** 현재 선택 범위에 들어가는 번호인지 (화면 강조용) */
export function isInRange(pick, holeNos, no) {
  if (!pick.from || !pick.to) return false;
  const i = holeNos.indexOf(no);
  const a = holeNos.indexOf(pick.from);
  const b = holeNos.indexOf(pick.to);
  return i > Math.min(a, b) && i < Math.max(a, b);
}
