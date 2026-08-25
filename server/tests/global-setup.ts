import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

export default async function setup(): Promise<void> {
  await migrate(true);   // DB 를 지우고 전체 마이그레이션 재적용
  await seed();
}
