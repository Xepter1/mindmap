#!/usr/bin/env node
// Entry point: reads settings from environment variables and starts the server.
import path from 'node:path';
import { createApp, ROOT } from './app.js';

const env = process.env;
const config = {
  port: Number(env.PORT) || 8090,
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  password: env.IDEENRAUM_PASSWORD || '',
  secureCookies: env.COOKIE_SECURE === 'true',
  backupKeepDays: Math.max(1, Number(env.BACKUP_KEEP_DAYS) || 14),
  trashKeepDays: Math.max(1, Number(env.TRASH_KEEP_DAYS) || 30),
};

let app;
try {
  app = await createApp(config);
} catch (e) {
  console.error(`\nIdeenraum konnte nicht starten:\n  ${e.message}\n`);
  process.exit(1);
}

app.server.listen(config.port, config.host, () => {
  console.log(`Ideenraum ${app.version} läuft auf http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Daten: ${config.dataDir}${config.password ? ' · Passwortschutz aktiv' : ''}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} empfangen, speichere und beende …`);
  const force = setTimeout(() => process.exit(1), 10000);
  try { await app.close(); } catch (e) { console.error(e); }
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
