import { Router } from 'express';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/token.js';
import { withAuthLookup, withSession, type AppRole } from '../db/pool.js';
import { badRequest, unauthorized } from '../http/errors.js';
import { requireAuth } from '../http/context.js';

export const authRouter = Router();

const loginSchema = z.object({
  login_id: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('아이디와 비밀번호를 입력하십시오.');

    const row = await withAuthLookup(async (c) => {
      const r = await c.query('SELECT * FROM app.fn_login_lookup($1)', [parsed.data.login_id]);
      return r.rows[0] as
        | { id: string; password_hash: string; display_name: string; role: AppRole; is_active: boolean }
        | undefined;
    });

    // 존재하지 않는 계정과 비밀번호 오류를 구분해서 알려주지 않는다.
    if (!row || !row.is_active || !(await verifyPassword(parsed.data.password, row.password_hash))) {
      throw unauthorized('아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    const token = signToken({ sub: row.id, role: row.role, name: row.display_name });
    await withAuthLookup(async (c) => { await c.query('SELECT app.fn_mark_login($1)', [row.id]); });

    res.json({
      token,
      user: { id: row.id, name: row.display_name, role: row.role },
    });
  } catch (e) { next(e); }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const actor = req.actor!;
    const sites = await withSession(actor, async (c) => {
      const r = await c.query(
        `SELECT s.id, s.site_code, s.site_name, s.status
           FROM core.site s
          WHERE s.id IN (SELECT app.fn_my_site_ids())
          ORDER BY s.site_code`);
      return r.rows;
    });
    res.json({ user: { id: actor.userId, name: actor.name, role: actor.role }, sites });
  } catch (e) { next(e); }
});
