import express, { type NextFunction, type Request, type Response } from 'express';
import { authRouter } from './routes/auth.js';
import { siteRouter } from './routes/sites.js';
import { holeRouter } from './routes/holes.js';
import { adminSiteRouter } from './routes/admin-sites.js';
import { adminHoleRouter } from './routes/admin-holes.js';
import { contractRouter } from './routes/contracts.js';
import { adminGroundRouter } from './routes/admin-ground.js';
import { groundAssignRouter } from './routes/admin-ground-assign.js';
import { quantityImportRouter } from './routes/quantity-import.js';
import { HttpError } from './http/errors.js';
import { logAccessDenied } from './http/context.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRouter);
  app.use('/api/sites', siteRouter);
  app.use('/api/sites', holeRouter);
  app.use('/api/admin/sites', adminSiteRouter);
  app.use('/api/admin', adminHoleRouter);
  app.use('/api/admin', adminGroundRouter);
  app.use('/api/admin', groundAssignRouter);
  app.use('/api/admin', quantityImportRouter);
  app.use('/api', contractRouter);

  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: '경로를 찾을 수 없습니다.' }));

  app.use(async (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    const pgErr = err as { code?: string; message?: string };
    // DB 가 마지막 방어선에서 막은 경우도 403 으로 처리하고 기록한다 (§29, §43).
    if (pgErr.code === '42501' || pgErr.code === 'insufficient_privilege') {
      await logAccessDenied(req, `DB 권한 거부: ${pgErr.message ?? ''}`);
      return res.status(403).json({ error: 'FORBIDDEN', message: '접근 권한이 없습니다.' });
    }
    if (pgErr.code === '23505') {
      return res.status(409).json({ error: 'DUPLICATE', message: '이미 존재하는 데이터입니다.' });
    }
    // 사용 중인 데이터를 지우려 한 경우 (예: 지반조건에서 쓰는 지층종류)
    if (pgErr.code === '23503') {
      return res.status(409).json({
        error: 'IN_USE', message: pgErr.message ?? '다른 데이터가 참조하고 있어 삭제할 수 없습니다.' });
    }
    if (pgErr.code === '23514') {
      return res.status(400).json({ error: 'CHECK_VIOLATION', message: pgErr.message ?? '데이터 검증에 실패했습니다.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'INTERNAL', message: '서버 오류가 발생했습니다.' });
  });

  return app;
}
