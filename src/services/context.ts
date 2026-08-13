/**
 * Service context.
 *
 * Every service receives this instead of reaching for globals: the request's
 * repositories, resolved config, storage provider, logger and a `defer()` hook
 * for background work. Building it once per request keeps services pure and
 * trivially testable — a test passes a fake context, not a fake Worker.
 */

import type { Context } from 'hono';
import type { AppContext, Bindings, WorkerContext } from '../types/env';
import { createRepositories, type Repositories } from '../db/repositories';
import { getConfig, resolveOrigin, type AppConfig } from '../config';
import { createLogger, type Logger } from '../utils/logger';
import { getStorage } from './storageFactory';
import type { StorageProvider } from './storage';

export interface ServiceContext {
  env: Bindings;
  config: AppConfig;
  /** Canonical absolute origin for links and OpenGraph tags. */
  origin: string;
  repos: Repositories;
  logger: Logger;
  /** Lazily resolved so requests that never touch media do not build a client. */
  storage(): StorageProvider;
  /**
   * Run work after the response has been sent. Falls back to awaiting inline
   * when no ExecutionContext is available (e.g. inside tests).
   */
  defer(work: Promise<unknown> | (() => Promise<unknown>)): void;
  requestId: string;
}

export interface BuildContextInput {
  env: Bindings;
  request: Request;
  executionCtx?: WorkerContext;
  requestId: string;
  repos?: Repositories;
}

export function buildServiceContext(input: BuildContextInput): ServiceContext {
  const config = getConfig(input.env);
  const logger = createLogger(config.logLevel, { requestId: input.requestId });

  return {
    env: input.env,
    config,
    origin: resolveOrigin(input.env, input.request),
    repos: input.repos ?? createRepositories(input.env.DB),
    logger,
    storage: () => getStorage(input.env),
    requestId: input.requestId,
    defer(work) {
      const promise = typeof work === 'function' ? work() : work;
      const guarded = promise.catch((error: unknown) => {
        logger.error('deferred_task_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (input.executionCtx) input.executionCtx.waitUntil(guarded);
      else void guarded;
    },
  };
}

const perRequest = new WeakMap<object, ServiceContext>();

/**
 * Per-request service context, memoised so repeated calls inside one request
 * reuse the same repositories and storage client.
 */
export function serviceContext(c: Context<AppContext>): ServiceContext {
  const key = c.req.raw as unknown as object;
  const existing = perRequest.get(key);
  if (existing) return existing;

  const ctx = buildServiceContext({
    env: c.env,
    request: c.req.raw,
    executionCtx: safeExecutionCtx(c),
    requestId: c.get('requestId') ?? 'unknown',
  });
  perRequest.set(key, ctx);
  return ctx;
}

function safeExecutionCtx(c: Context<AppContext>): WorkerContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    // Not available in every runtime (e.g. unit tests) — degrade gracefully.
    return undefined;
  }
}
