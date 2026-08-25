import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { AppRole } from '../db/pool.js';

export interface TokenPayload {
  sub: string;
  role: AppRole;
  name: string;
}

export function signToken(p: TokenPayload): string {
  return jwt.sign(p, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === 'string') throw new Error('INVALID_TOKEN');
  const { sub, role, name } = decoded as jwt.JwtPayload & { role?: string; name?: string };
  if (!sub || !role || !name) throw new Error('INVALID_TOKEN');
  if (role !== 'HEAD_OFFICE' && role !== 'FIELD_MANAGER' && role !== 'EXTERNAL') {
    throw new Error('INVALID_ROLE');
  }
  return { sub, role, name };
}
