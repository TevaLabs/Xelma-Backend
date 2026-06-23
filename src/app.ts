import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from './routes';
import healthRoutes from './routes/health';
import statsRoutes from './routes/stats';
import roundsRoutes from './routes/rounds';
import { apiRateLimiter, writeRateLimiter } from './middleware/rateLimiter';

const app: Application = express();

app.use(express.json());
app.use(cors({ origin: true }));
app.use(helmet());
app.use(morgan('combined'));

app.use('/api', apiRateLimiter);
app.use('/api', writeRateLimiter);
app.use('/api', healthRoutes);
app.use('/api', statsRoutes);
app.use('/api/rounds', roundsRoutes);
app.use('/api', routes);

export default app;
