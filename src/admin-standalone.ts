import { ADMIN_WEB_HOST, ADMIN_WEB_PORT } from './config.js';
import { startAdminWebServer } from './admin-web.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  initDatabase();
  await startAdminWebServer({
    projectRoot: process.cwd(),
    host: ADMIN_WEB_HOST,
    port: ADMIN_WEB_PORT,
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start standalone admin web');
  process.exit(1);
});
