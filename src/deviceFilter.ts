export interface DeviceIgnoreRule {
  deviceId?: string;
  label?: string;
  name?: string;
  manufacturerName?: string;
  deviceManufacturerCode?: string;
  type?: string;
  installedAppId?: string;
  endpointAppId?: string;
}

interface SmartThingsDevice {
  deviceId?: unknown;
  label?: unknown;
  name?: unknown;
  manufacturerName?: unknown;
  deviceManufacturerCode?: unknown;
  type?: unknown;
  app?: {
    installedAppId?: unknown;
  };
  viper?: {
    endpointAppId?: unknown;
  };
}

const ruleFields: Array<keyof DeviceIgnoreRule> = [
  'deviceId',
  'label',
  'name',
  'manufacturerName',
  'deviceManufacturerCode',
  'type',
  'installedAppId',
  'endpointAppId',
];

function deviceField(device: SmartThingsDevice, field: keyof DeviceIgnoreRule): unknown {
  if (field === 'installedAppId') {
    return device.app?.installedAppId;
  }

  if (field === 'endpointAppId') {
    return device.viper?.endpointAppId;
  }

  return device[field];
}

function wildcardToRegExp(pattern: string): RegExp {
  let expression = '^';

  for (const character of pattern) {
    if (character === '*') {
      expression += '.*';
    } else if (character === '?') {
      expression += '.';
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(expression + '$', 'i');
}

/**
 * Returns the first ignore rule that matches the device. Fields within one rule
 * are ANDed together; separate rules are ORed together.
 */
export function findMatchingDeviceIgnoreRule(
  device: SmartThingsDevice,
  rules: unknown,
): DeviceIgnoreRule | undefined {
  if (!Array.isArray(rules)) {
    return undefined;
  }

  return rules.find((candidate): candidate is DeviceIgnoreRule => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false;
    }

    const rule = candidate as DeviceIgnoreRule;
    const configuredFields = ruleFields.filter(field => typeof rule[field] === 'string' && rule[field] !== '');

    if (configuredFields.length === 0) {
      return false;
    }

    return configuredFields.every(field => {
      const value = deviceField(device, field);
      return value !== undefined && value !== null && wildcardToRegExp(rule[field]!).test(String(value));
    });
  });
}
