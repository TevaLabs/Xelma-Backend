import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from './routes';

const app: Application = express();

app.use(express.json());
app.use(cors({ origin: true }));
app.use(helmet());
app.use(morgan('combined'));

app.use('/api', routes);

export default app;