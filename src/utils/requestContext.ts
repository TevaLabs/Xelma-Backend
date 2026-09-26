import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

export function getRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return runWithRequestContext({ requestId }, fn);
}

export function getRequestContextStorage(): AsyncLocalStorage<RequestContext> {
  return asyncLocalStorage;
}

export default {
  getRequestContext,
  getRequestId,
  runWithRequestContext,
  runWithRequestId,
  getRequestContextStorage,
};
