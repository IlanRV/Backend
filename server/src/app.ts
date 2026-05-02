import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { HttpError } from './lib/http';
import { createLogger, requestLogger } from './lib/logger';
import aiRoutes from './routes/ai';
import chatRoutes from './routes/chat';
import repoRoutes from './routes/repos';
import workspaceRoutes from './routes/workspaces';

export function createApp(): express.Express {
  const app = express();
  const logger = createLogger('server');

  app.use(cors({ origin: config.corsOrigins }));
  app.use(requestLogger());
  app.use(express.json({ limit: '35mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api', workspaceRoutes);
  app.use('/api', repoRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/ai', aiRoutes);

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'Route not found'));
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      logger.warn('http_error', {
        statusCode: err.statusCode,
        message: err.message,
      });
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    logger.error('unhandled_request_error', { error: err });
    res.status(500).json({ error: 'Internal server error', details: err.message });
  });

  return app;
}

export const app = createApp();