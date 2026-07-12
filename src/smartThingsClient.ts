import { Logger, PlatformConfig } from 'homebridge';
import axios = require('axios');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const MINIMUM_REQUEST_INTERVAL_MS = 250;
const MAX_BACKOFF_MS = 60000;

export function retryAfterMilliseconds(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(String(value));
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!axios.default.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  return !error.response || status === 408 || status === 429 || (status !== undefined && status >= 500);
}

/** Coordinates all SmartThings API traffic from one Homebridge platform instance. */
export class SmartThingsRequestCoordinator {
  private activeRequests = 0;
  private readonly queue: Array<{
    cancelled: boolean;
    resolve: (acquired: boolean) => void;
    timer?: NodeJS.Timeout;
  }> = [];

  private blockedUntil = 0;
  private nextRequestAt = 0;
  private transientFailureCount = 0;
  private readonly acquiredRequests = new WeakSet<object>();

  constructor(
    private readonly maxConcurrentRequests: number,
    private readonly maxQueueWaitMs: number,
    private readonly log: Logger,
  ) {}

  attach(client: axios.AxiosInstance): axios.AxiosInstance {
    client.interceptors.request.use(async config => {
      await this.acquire();
      this.acquiredRequests.add(config);
      return config;
    });

    client.interceptors.response.use(response => {
      this.transientFailureCount = 0;
      this.release(response.config);
      return response;
    }, error => {
      this.recordFailure(error);
      if (error?.config) {
        this.release(error.config);
      }
      return Promise.reject(error);
    });

    return client;
  }

  private async acquire(): Promise<void> {
    if (this.blockedUntil > Date.now()) {
      throw new Error(`SmartThings API requests are paused for ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} seconds`);
    }

    const dispatchAt = Math.max(Date.now(), this.nextRequestAt);
    this.nextRequestAt = dispatchAt + MINIMUM_REQUEST_INTERVAL_MS;
    if (dispatchAt > Date.now()) {
      await new Promise(resolve => setTimeout(resolve, dispatchAt - Date.now()));
    }
    if (this.blockedUntil > Date.now()) {
      throw new Error(`SmartThings API requests are paused for ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} seconds`);
    }

    if (this.activeRequests < this.maxConcurrentRequests) {
      this.activeRequests++;
      return;
    }

    const acquired = await new Promise<boolean>(resolve => {
      const entry: { cancelled: boolean; resolve: (acquired: boolean) => void; timer?: NodeJS.Timeout } = {
        cancelled: false,
        resolve,
      };
      this.queue.push(entry);
      entry.timer = setTimeout(() => {
        if (!entry.cancelled) {
          entry.cancelled = true;
          resolve(false);
        }
      }, this.maxQueueWaitMs);
    });
    if (!acquired) {
      throw new Error('Timed out waiting for an available SmartThings API request slot');
    }
    if (this.blockedUntil > Date.now()) {
      this.releaseSlot();
      throw new Error(`SmartThings API requests are paused for ${Math.ceil((this.blockedUntil - Date.now()) / 1000)} seconds`);
    }
  }

  private release(config: object): void {
    if (!this.acquiredRequests.delete(config)) {
      return;
    }

    this.releaseSlot();
  }

  private releaseSlot(): void {
    let next = this.queue.shift();
    while (next?.cancelled) {
      next = this.queue.shift();
    }
    if (next) {
      next.cancelled = true;
      if (next.timer) {
        clearTimeout(next.timer);
      }
      next.resolve(true);
      return;
    }
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  private recordFailure(error: unknown): void {
    if (!isTransientNetworkError(error)) {
      return;
    }

    this.transientFailureCount++;
    const axiosError = error as axios.AxiosError;
    const retryAfter = retryAfterMilliseconds(axiosError.response?.headers?.['retry-after']);
    const exponentialBackoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(this.transientFailureCount - 1, 6)));
    const delay = axiosError.response?.status === 429 ? Math.max(retryAfter || 30000, exponentialBackoff) : exponentialBackoff;
    const newBlockedUntil = Date.now() + delay;

    if (newBlockedUntil > this.blockedUntil) {
      this.blockedUntil = newBlockedUntil;
      const reason = axiosError.response?.status === 429 ? 'SmartThings rate limit' : 'temporary network failure';
      this.log.warn(`${reason}; pausing API requests for ${Math.ceil(delay / 1000)} seconds`);
    }
  }
}

export function createSmartThingsClient(config: PlatformConfig, log: Logger): axios.AxiosInstance {
  const timeoutSeconds = positiveNumber(config.NetworkTimeoutSeconds, DEFAULT_TIMEOUT_MS / 1000);
  const maxConcurrentRequests = Math.floor(positiveNumber(config.MaxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS));
  const coordinator = new SmartThingsRequestCoordinator(maxConcurrentRequests, timeoutSeconds * 1000, log);

  return coordinator.attach(axios.default.create({
    baseURL: config.BaseURL,
    headers: { 'Authorization': 'Bearer: ' + config.AccessToken },
    timeout: timeoutSeconds * 1000,
  }));
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
