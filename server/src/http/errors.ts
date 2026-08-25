export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const badRequest   = (m: string, c = 'BAD_REQUEST')   => new HttpError(400, c, m);
export const unauthorized = (m = '로그인이 필요합니다.')       => new HttpError(401, 'UNAUTHORIZED', m);
export const forbidden    = (m = '접근 권한이 없습니다.')      => new HttpError(403, 'FORBIDDEN', m);
export const notFound     = (m = '대상을 찾을 수 없습니다.')   => new HttpError(404, 'NOT_FOUND', m);
