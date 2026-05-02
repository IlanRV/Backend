import { app } from './app';
import { config } from './config';
import { createLogger } from './lib/logger';

const logger = createLogger('server');

app.listen(config.port, () => {
  logger.info('server_started', {
    port: config.port,
    corsOrigins: config.corsOrigins,
    logLevel: config.logging.level,
    firebaseConfigured: Boolean(config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey),
    openRouterConfigured: Boolean(config.openrouter.apiKey),
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { error });
});
