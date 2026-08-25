import { createApp } from './app.js';
import { env } from './config/env.js';

createApp().listen(env.PORT, () => {
  console.log(`[server] RF CIP Mobile Field Control — http://localhost:${env.PORT}`);
});
