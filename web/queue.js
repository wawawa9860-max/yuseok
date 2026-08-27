/**
 * 오프라인 입력 큐 — 현장은 통신이 자주 끊긴다.
 *
 * 저장 중 통신이 끊기면 입력을 기기(IndexedDB)에 쌓아 두었다가
 * 통신이 돌아오면 자동으로 다시 보낸다.
 *
 * 중복 저장을 막는 것이 핵심이다.
 *   · 요청마다 client_request_id 를 만들어 붙인다
 *   · 서버는 같은 ID 를 두 번 받으면 처음 응답을 그대로 돌려준다
 *   · 그래서 "보냈는지 확실하지 않을 때" 다시 보내도 안전하다
 */
const DB_NAME = 'rfcip-queue';
const STORE = 'pending';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

export function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // 구형 브라우저 대비
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function enqueue(item) {
  await tx('readwrite', (s) => s.put(item));
  return item;
}

export async function pending() {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => a.queued_at - b.queued_at);
}

export async function pendingCount() {
  return (await pending()).length;
}

export async function remove(id) {
  await tx('readwrite', (s) => s.delete(id));
}

/**
 * 쌓인 요청을 순서대로 다시 보낸다.
 * send(item, done) 은 성공하면 응답, 네트워크 문제면 throw 해야 한다.
 *
 * done 은 '이번에 보낸 것들의 응답'이다 (요청ID → 응답).
 * 영수증 사진처럼 앞 요청의 결과(비용 id)가 있어야 보낼 수 있는 항목이 있다.
 * 순서대로 보내고 실패하면 멈추므로 앞 항목의 응답을 뒤 항목이 쓸 수 있다.
 */
export async function flush(send) {
  const items = await pending();
  const result = { sent: 0, failed: 0, dropped: 0 };
  const done = new Map();
  for (const item of items) {
    try {
      const res = await send(item, done);
      done.set(item.id, res);
      await remove(item.id);
      result.sent++;
    } catch (e) {
      if (e && e.permanent) {
        // 서버가 거부한 요청(검증 실패 등)은 다시 보내도 소용없다.
        await remove(item.id);
        result.dropped++;
      } else {
        result.failed++;
        break;      // 통신이 아직 안 되면 순서를 지키기 위해 멈춘다
      }
    }
  }
  return result;
}

export async function clear() {
  await tx('readwrite', (s) => s.clear());
}
