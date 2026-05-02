import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { HttpError } from './lib/http';
import aiRoutes from './routes/ai';
import chatRoutes from './routes/chat';
import repoRoutes from './routes/repos';
import workspaceRoutes from './routes/workspaces';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '5mb' }));

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
  console.error(err);

  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});