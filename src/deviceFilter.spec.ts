import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findMatchingDeviceIgnoreRule } from './deviceFilter';

const hueDevice = {
  deviceId: 'device-1',
  label: 'Kitchen ceiling',
  name: 'Hue color lamp',
  manufacturerName: 'Signify Netherlands B.V.',
  type: 'ENDPOINT_APP',
  app: {
    installedAppId: 'hue-installed-app-id',
  },
};

describe('findMatchingDeviceIgnoreRule', () => {
  it('matches wildcards case-insensitively', () => {
    const rule = { manufacturerName: 'signify*' };

    assert.equal(findMatchingDeviceIgnoreRule(hueDevice, [rule]), rule);
  });

  it('requires every configured field in a rule to match', () => {
    const matchingRule = { type: 'endpoint_app', name: 'Hue *' };
    const nonMatchingRule = { type: 'ENDPOINT_APP', manufacturerName: 'Lutron*' };

    assert.equal(findMatchingDeviceIgnoreRule(hueDevice, [nonMatchingRule, matchingRule]), matchingRule);
  });

  it('matches an installed app without relying on device names', () => {
    const rule = { installedAppId: 'hue-installed-app-id' };

    assert.equal(findMatchingDeviceIgnoreRule(hueDevice, [rule]), rule);
  });

  it('supports single-character wildcards and escapes regular-expression characters', () => {
    const rule = { label: 'Kitchen ceili?g', manufacturerName: 'Signify Netherlands B.V.' };

    assert.equal(findMatchingDeviceIgnoreRule(hueDevice, [rule]), rule);
  });

  it('ignores empty and malformed rules', () => {
    assert.equal(findMatchingDeviceIgnoreRule(hueDevice, [{}, null, 'Signify*']), undefined);
  });
});
