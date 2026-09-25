import { Application } from 'express';
import {
  createApp as createAppFromFactory,
  AppFeatures,
  CreateAppOptions as FactoryOptions,
} from './app-factory';
import { ValidationError } from './utils/errors';

export interface CreateAppOptions {
  includeErrorHandlers?: boolean;
  features?: Partial<AppFeatures>;
}

export function createApp(options: CreateAppOptions = {}): Application {
  const factoryOptions: FactoryOptions = {
    ...options,
    mode: 'hackathon',
  };
  const app = createAppFromFactory(factoryOptions);

  app.get('/test-error', (_req, _res, next) => {
    const err = new ValidationError('Explicitly triggered test exception handler pass-through');
    err.name = err.message;
    next(err);
  });

  return app;
}

const app = createApp();
export default app;
