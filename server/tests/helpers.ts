import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();

export async function login(loginId: string, password = 'test1234!'): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ login_id: loginId, password });
  if (res.status !== 200) throw new Error(`login failed for ${loginId}: ${res.status} ${res.text}`);
  return res.body.token as string;
}

export async function siteIdByCode(token: string, code: string): Promise<string> {
  const res = await request(app).get('/api/sites').set('Authorization', `Bearer ${token}`);
  const site = res.body.sites.find((s: { site_code: string }) => s.site_code === code);
  if (!site) throw new Error(`site ${code} not visible`);
  return site.id as string;
}
