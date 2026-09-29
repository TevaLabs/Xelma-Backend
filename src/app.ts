import { Application } from 'express';
import {
  createApp as createAppFromFactory,
  AppFeatures,
  CreateAppOptions as FactoryOptions,
} from './app-factory';

export interface CreateAppOptions {
  includeErrorHandlers?: boolean;
  features?: Partial<AppFeatures>;
}

export function createApp(options: CreateAppOptions = {}): Application {
  const factoryOptions: FactoryOptions = {
    ...options,
    mode: 'hackathon',
  };
  return createAppFromFactory(factoryOptions);
}

const app = createApp();
export default app;
