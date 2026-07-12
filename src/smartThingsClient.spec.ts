import assert = require('node:assert/strict');
import test = require('node:test');
import axios = require('axios');
import { Logger } from 'homebridge';
import { isTransientNetworkError, retryAfterMilliseconds, SmartThingsRequestCoordinator } from './smartThingsClient';

test('retryAfterMilliseconds parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMilliseconds('12'), 12000);
  assert.equal(retryAfterMilliseconds(2), 2000);
  assert.equal(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:15 GMT', 10000), 5000);
  assert.equal(retryAfterMilliseconds('invalid'), undefined);
});

test('isTransientNetworkError identifies retryable Axios failures', () => {
  assert.equal(isTransientNetworkError({ isAxiosError: true, response: undefined }), true);
  assert.equal(isTransientNetworkError({ isAxiosError: true, response: { status: 429 } }), true);
  assert.equal(isTransientNetworkError({ isAxiosError: true, response: { status: 503 } }), true);
  assert.equal(isTransientNetworkError({ isAxiosError: true, response: { status: 401 } }), false);
  assert.equal(isTransientNetworkError(new Error('not axios')), false);
});

test('coordinator bounds concurrency and queue waiting time', async () => {
  let releaseFirst: (() => void) | undefined;
  let dispatched = 0;
  const client = axios.default.create({
    adapter: async config => {
      dispatched++;
      if (dispatched === 1) {
        await new Promise<void>(resolve => releaseFirst = resolve);
      }
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  const logger = { warn: () => undefined } as unknown as Logger;
  new SmartThingsRequestCoordinator(1, 25, logger).attach(client);

  const first = client.get('/first');
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = client.get('/second');
  await assert.rejects(second, /Timed out waiting/);
  assert.equal(dispatched, 1);

  releaseFirst?.();
  await first;
});
