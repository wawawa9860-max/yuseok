import { networkInterfaces } from 'node:os';
import qrcode from 'qrcode-terminal';
import { createApp } from './app.js';
import { env } from './config/env.js';

/**
 * 시험사용을 쉽게 하기 위해, 서버를 띄우면 휴대폰에서 바로 들어갈 수 있는
 * 주소와 QR 코드를 함께 보여준다.
 * 현장에서 긴 주소를 손으로 입력하게 만들지 않는다.
 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/*
 * 운영에서는 시작할 때 마이그레이션과 첫 계정 부트스트랩을 자동으로 돈다 (PHASE 15).
 * "어떤 파일을 들어가서 뭘 실행해야 하나" 를 없애기 위해서다 — 켜는 것 하나면 된다.
 * 개발(tsx watch)에서는 db:reset 을 따로 쓰므로 건드리지 않는다.
 */
if (process.env.NODE_ENV === 'production' || process.env.AUTO_MIGRATE === '1') {
  const { migrate, bootstrapAdmin } = await import('./db/migrate.js');
  await migrate(false);
  await bootstrapAdmin();
}

const server = createApp();

const listener = server.listen(env.PORT, () => {
  const urls = lanAddresses().map((ip) => `http://${ip}:${env.PORT}/app/`);
  console.log('\n  RF CIP Mobile Field Control');
  console.log(`  이 PC에서       http://localhost:${env.PORT}/app/`);
  if (urls.length > 0) {
    console.log(`  같은 Wi-Fi 휴대폰  ${urls[0]}`);
    for (const u of urls.slice(1)) console.log(`                     ${u}`);
    console.log('');
    qrcode.generate(urls[0]!, { small: true });
    console.log('  ↑ 휴대폰 카메라로 찍으면 바로 열립니다.\n');
  } else {
    console.log('  (외부 네트워크 주소를 찾지 못했습니다)\n');
  }
});

/**
 * 시험사용은 개발자가 아닌 사람이 실행한다.
 * 포트가 이미 쓰이고 있을 때 스택트레이스를 보여주면 거기서 막힌다.
 * 무엇이 문제이고 어떻게 하면 되는지 한국어로 알려준다.
 */
listener.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ${env.PORT}번 포트를 이미 다른 프로그램이 쓰고 있습니다.`);
    console.error('  이미 서버가 켜져 있을 수 있습니다. 브라우저에서 먼저 확인해 보십시오.');
    console.error(`      http://localhost:${env.PORT}/app/`);
    console.error('');
    console.error('  그래도 다시 켜려면 실행 중인 창을 닫거나, 다른 포트를 쓰십시오.');
    console.error(`      PORT=3100 npm run dev\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  ${env.PORT}번 포트를 열 권한이 없습니다. 1024 이상의 포트를 쓰십시오.`);
    console.error('      PORT=3100 npm run dev\n');
  } else {
    console.error('\n  서버를 시작하지 못했습니다:', err.message, '\n');
  }
  process.exit(1);
});
