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

createApp().listen(env.PORT, () => {
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
