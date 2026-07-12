import { PlatformAccessory, Characteristic, CharacteristicValue, Service, WithUUID, Logger, API } from 'homebridge';
import axios = require('axios');
import { IKHomeBridgeHomebridgePlatform } from './platform';
import { BaseService } from './services/baseService';
// import { BasePlatformAccessory } from './basePlatformAccessory';
import { MotionService } from './services/motionService';
import { BatteryService } from './services/batteryService';
import { TemperatureService } from './services/temperatureService';
import { HumidityService } from './services/humidityService';
import { LightSensorService } from './services/lightSensorService';
import { ContactSensorService } from './services/contactSensorService';
import { LockService } from './services/lockService';
import { DoorService } from './services/doorService';
import { SwitchService } from './services/switchService';
import { LightService } from './services/lightService';
import { FanSwitchLevelService } from './services/fanSwitchLevelService';
import { OccupancySensorService } from './services/occupancySensorService';
import { LeakDetectorService } from './services/leakDetector';
import { SmokeDetectorService } from './services/smokeDetector';
import { CarbonMonoxideDetectorService } from './services/carbonMonoxideDetector';
import { ValveService } from './services/valveService';
import { ShortEvent } from './webhook/subscriptionHandler';
import { FanSpeedService } from './services/fanSpeedService';
import { WindowCoveringService } from './services/windowCoveringService';
import { ThermostatService } from './services/thermostatService';
import { StatelessProgrammableSwitchService } from './services/statelessProgrammableSwitchService';
import { AirConditionerService } from './services/airConditionerService';
import { Command } from './services/smartThingsCommand';

const STATUS_CACHE_MS = 10000;
const HOMEKIT_READ_WAIT_MS = 2000;
// type DeviceStatus = {
//   timestamp: number;
//   //status: Record<string, unknown>;
//   status: any;
// };

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
// export class MultiServiceAccessory extends BasePlatformAccessory {
export class MultiServiceAccessory {
  //  service: Service;
  //capabilities;
  components: {
    componentId: string;
    capabilities: string[];
    status: Record<string, unknown>;
  }[] = [];

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */

  private services: BaseService[] = [];

  // Order of these matters.  Make sure secondary capabilities like 'battery' and 'contactSensor' are at the end.
  private static capabilityMap = {
    'doorControl': DoorService,
    'lock': LockService,
    'switch': SwitchService,
    'windowShadeLevel': WindowCoveringService,
    'windowShade': WindowCoveringService,
    'motionSensor': MotionService,
    'waterSensor': LeakDetectorService,
    'smokeDetector': SmokeDetectorService,
    'carbonMonoxideDetector': CarbonMonoxideDetectorService,
    'presenceSensor': OccupancySensorService,
    'temperatureMeasurement': TemperatureService,
    'relativeHumidityMeasurement': HumidityService,
    'illuminanceMeasurement': LightSensorService,
    'contactSensor': ContactSensorService,
    'button': StatelessProgrammableSwitchService,
    'battery': BatteryService,
    'valve': ValveService,
  };

  // Maps combinations of supported capabilities to a service
  private static comboCapabilityMap = [
    {
      capabilities: [
        'switch',
        'airConditionerMode',
        'airConditionerFanMode',
        'thermostatCoolingSetpoint',
        'temperatureMeasurement',
      ],
      optionalCapabilities: [
        'fanOscillationMode',
        'relativeHumidityMeasurement',
        'custom.airConditionerOptionalMode',
      ],
      service: AirConditionerService,
    },
    {
      capabilities: ['switch', 'fanSpeed', 'switchLevel'],
      service: FanSwitchLevelService,
    },
    {
      capabilities: ['switch', 'fanSpeed'],
      service: FanSpeedService,
    },
    {
      capabilities: ['switch', 'switchLevel'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorControl'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorTemperature'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'valve'],
      service: ValveService,
    },
    {
      capabilities: ['temperatureMeasurement',
        'thermostatMode',
        'thermostatHeatingSetpoint',
        'thermostatCoolingSetpoint'],
      service: ThermostatService,
    },
    {
      // There is a heater out there that just supports thermostatMode and thermostatHeatingSetpoint
      capabilities: ['temperatureMeasurement',
        'thermostatHeatingSetpoint'],
      service: ThermostatService,
    },
    {
      capabilities: ['windowShade', 'windowShadeLevel'],
      service: WindowCoveringService,
    },
    {
      capabilities: ['windowShade', 'switchLevel'],
      service: WindowCoveringService,
    },
  ];

  protected accessory: PlatformAccessory;
  protected platform: IKHomeBridgeHomebridgePlatform;
  public readonly name: string;
  protected characteristic: typeof Characteristic;
  protected log: Logger;
  protected baseURL: string;
  protected key: string;
  protected axInstance: axios.AxiosInstance;
  protected commandURL: string;
  protected statusURL: string;
  protected healthURL: string;
  protected api: API;
  protected online = true;
  //protected deviceStatus: DeviceStatus = { timestamp: 0, status: undefined };
  protected deviceStatusTimestamp = 0;
  protected failureCount = 0;
  protected giveUpTime = 0;
  protected commandInProgress = false;
  protected lastCommandCompleted = 0;

  protected statusQueryInProgress = false;
  protected healthCheckInProgress = false;
  protected lastStatusResult = true;

  get id() {
    return this.accessory.UUID;
  }

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    // capabilities,
  ) {

    this.accessory = accessory;
    this.platform = platform;
    this.name = accessory.context.device.label;
    this.log = platform.log;
    this.baseURL = platform.config.BaseURL;
    this.key = platform.config.AccessToken;
    this.api = platform.api;
    this.axInstance = platform.smartThingsClient;

    this.commandURL = 'devices/' + accessory.context.device.deviceId + '/commands';
    this.statusURL = 'devices/' + accessory.context.device.deviceId + '/status';
    this.healthURL = 'devices/' + accessory.context.device.deviceId + '/health';
    this.characteristic = platform.Characteristic;

    // set accessory information
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, accessory.context.device.manufacturerName)
      .setCharacteristic(platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(platform.Characteristic.SerialNumber, 'Default-Serial');

    // Begin optimistically online. Status polling establishes availability without issuing
    // a startup health request for every device at once.
  }

  private registerServiceIfMatchesCapabilities(
    componentId: string,
    component: any,
    capabilitiesToCover: string[],
    capabilities: string[],
    optionalCapabilities: string[],
    serviceConstructor: any,
  ): string[] {
    // this.log.debug(`Testing ${serviceConstructor.name} for capabilities ${capabilitiesToCover}`);
    // ignore services which cannot cover all required capabilities
    if (!capabilities.every(e => capabilitiesToCover.includes(e))) {
      // this.log.debug(`Ignoring ${serviceConstructor.name}`);
      return capabilitiesToCover;
    }

    const allCapabilities = capabilities.concat(optionalCapabilities.filter(e => capabilitiesToCover.includes(e)));

    this.log.debug(`Creating instance of ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    const serviceInstance = new serviceConstructor(this.platform, this.accessory, componentId, allCapabilities, this, this.name, component);
    this.services.push(serviceInstance);

    this.log.debug(`Registered ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    // remove covered capabilities and return unused
    return capabilitiesToCover.filter(e => !allCapabilities.includes(e));
  }

  public addComponent(componentId: string, capabilities: string[]) {
    const component = {
      componentId,
      capabilities,
      status: {},
    };
    this.components.push(component);


    let capabilitiesToCover = [...capabilities];

    // Start with comboServices and remove used capabilities to avoid duplicated sensors.
    // For example, there is no need to expose a temperature sensor in case of a thermostat which already exposes that charateristic.
    MultiServiceAccessory.comboCapabilityMap
      .sort((a, b) => a.capabilities.length > b.capabilities.length ? -1 : 1) // services with larger capability set first
      .forEach(entry => {
        capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
          componentId,
          component,
          capabilitiesToCover,
          entry.capabilities,
          entry.optionalCapabilities || [],
          entry.service,
        );
      });

    Object.keys(MultiServiceAccessory.capabilityMap).forEach((capability) => {
      const service = MultiServiceAccessory.capabilityMap[capability];
      capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
        componentId,
        component,
        capabilitiesToCover,
        [capability],
        [],
        service,
      );
    });
  }

  public isOnline(): boolean {
    return this.online;
  }

  // Find return if a capability is supported by the multi-service accessory
  public static capabilitySupported(capability: string): boolean {
    if (Object.keys(MultiServiceAccessory.capabilityMap).find(c => c === capability)) {
      return true;
    } else {
      return false;
    }
  }

  // public async refreshStatus(): Promise<boolean> {
  //   return super.refreshStatus();
  // }

  // Called by subclasses to refresh the status for the device.  Will only refresh if it has been more than
  // 4 seconds since last refresh
  //
  async refreshStatus(): Promise<boolean> {
    this.log.debug(`Refreshing status for ${this.name} - current timestamp is ${this.deviceStatusTimestamp}`);
    if (Date.now() - this.deviceStatusTimestamp <= STATUS_CACHE_MS) {
      return true;
    }

    if (!this.statusQueryInProgress) {
      this.statusQueryInProgress = true;
      void this.performStatusRefresh();
    } else {
      this.log.debug(`Status query already in progress for ${this.name}. Waiting briefly...`);
    }

    const completed = await this.waitFor(() => !this.statusQueryInProgress, HOMEKIT_READ_WAIT_MS);
    return completed ? this.lastStatusResult : false;
  }

  private async performStatusRefresh(): Promise<void> {
    try {
      if (!await this.waitFor(() => !this.commandInProgress)) {
        this.log.warn(`Timed out waiting to refresh ${this.name}`);
        this.lastStatusResult = false;
        return;
      }

      this.log.debug(`Calling SmartThings to get an update for ${this.name}`);
      const res = await this.axInstance.get(this.statusURL);
      const componentsStatus = res.data.components;
      let receivedStatus = false;
      this.components.forEach(component => {
        if (componentsStatus?.[component.componentId] !== undefined) {
          component.status = componentsStatus[component.componentId];
          receivedStatus = true;
          this.log.debug(`Updated status for ${this.name}-${component.componentId}: ${JSON.stringify(component.status)}`);
        } else {
          this.log.error(`Failed to get status for ${this.name}-${component.componentId}`);
        }
      });

      if (!receivedStatus) {
        this.lastStatusResult = false;
        return;
      }
      this.deviceStatusTimestamp = Date.now();
      this.failureCount = 0;
      this.online = true;
      this.lastStatusResult = true;
    } catch (error) {
      this.recordStatusFailure(error);
      this.lastStatusResult = false;
    } finally {
      this.statusQueryInProgress = false;
    }
  }

  private recordStatusFailure(error: unknown): void {
    const authorizationFailure = axios.default.isAxiosError(error) &&
      (error.response?.status === 401 || error.response?.status === 403);
    this.failureCount = authorizationFailure ? 5 : this.failureCount + 1;
    this.log.error(`Failed to request status from ${this.name}: ${error}. This is failure number ${this.failureCount}`);
    if (this.failureCount >= 5 && this.online) {
      this.log.error(`Exceeded allowed failures for ${this.name}. Device is offline`);
      this.giveUpTime = Date.now();
      this.online = false;
    }
  }

  public forceNextStatusRefresh() {
    this.deviceStatusTimestamp = 0;
  }


  // public startPollingState(pollSeconds: number, getValue: () => Promise<CharacteristicValue>, service: Service,
  //   chracteristic: WithUUID<new () => Characteristic>, targetStateCharacteristic?: WithUUID<new () => Characteristic>,
  //   getTargetState?: () => Promise<CharacteristicValue>) {
  //   return super.startPollingState(pollSeconds, getValue, service, chracteristic, targetStateCharacteristic, getTargetState);
  // }

  startPollingState(pollSeconds: number, getValue: () => Promise<CharacteristicValue>, service: Service,
    chracteristic: WithUUID<new () => Characteristic>, targetStateCharacteristic?: WithUUID<new () => Characteristic>,
    getTargetState?: () => Promise<CharacteristicValue>): NodeJS.Timeout | void {

    if (this.platform.config.WebhookToken && this.platform.config.WebhookToken !== '') {
      return;  // Don't poll if we have a webhook token
    }

    if (pollSeconds > 0) {
      return setInterval(() => {
        // If we are in the middle of a commmand call, or it hasn't been at least 10 seconds, we don't want to poll.
        if (this.commandInProgress || Date.now() - this.lastCommandCompleted < 20 * 1000) {
          // Skip polling until command is complete
          this.log.debug(`Command in progress, skipping polling for ${this.name}`);
          return;
        }
        if (this.online) {
          this.log.debug(`${this.name} polling...`);
          // this.commandInProgress = true;
          getValue().then((v) => {
            service.updateCharacteristic(chracteristic, v);
            this.log.debug(`${this.name} value updated.`);
          }).catch(() => {  // If we get an error, ignore
            this.log.warn(`Poll failure on ${this.name}`);
            return;
          });
          // Update target if we have to
          if (targetStateCharacteristic && getTargetState) {
            //service.updateCharacteristic(targetStateCharacteristic, getTargetState());
            getTargetState()
              .then(value => service.updateCharacteristic(targetStateCharacteristic, value))
              .catch(() => this.log.warn(`Poll failure on target state for ${this.name}`));
          }
        } else {
          // If we failed this accessory due to errors. Reset the failure count and online status after 10 minutes.
          if (!this.healthCheckInProgress && this.giveUpTime > 0 && (Date.now() - this.giveUpTime > (10 * 60 * 1000))) {
            this.healthCheckInProgress = true;
            this.axInstance.get(this.healthURL)
              .then(res => {
                if (res.data.state === 'ONLINE') {
                  this.online = true;
                  this.giveUpTime = 0;
                  this.failureCount = 0;
                }
              })
              .catch(error => this.log.warn(`Could not recheck health for ${this.name}: ${error}`))
              .finally(() => this.healthCheckInProgress = false);
          }
        }
      }, pollSeconds * 1000 + Math.floor(Math.random() * pollSeconds * 1000));
    }
  }

  async sendCommand(capability: string, command: string, args?: unknown[]): Promise<boolean> {
    const cmd = new Command(capability, command, args);
    return this.sendCommands([cmd]);
  }

  async sendCommands(commands: Command[]): Promise<boolean> {
    const commandBody = JSON.stringify({ commands: commands });
    if (!await this.waitFor(() => !this.commandInProgress)) {
      this.log.error(`Timed out waiting to send a command to ${this.name}`);
      return false;
    }

    this.commandInProgress = true;
    try {
      await this.axInstance.post(this.commandURL, commandBody);
      this.log.debug(`${JSON.stringify(commands)} successful for ${this.name}`);
      this.deviceStatusTimestamp = 0;
      return true;
    } catch (error) {
      this.log.error(`${JSON.stringify(commands)} failed for ${this.name}: ${error}`);
      return false;
    } finally {
      this.commandInProgress = false;
      this.lastCommandCompleted = Date.now();
    }
  }

  // Wait for the condition to be true.  Will check every 500 ms
  private async waitFor(condition: () => boolean, timeoutMs = 15000): Promise<boolean> {
    if (condition()) {
      return true;
    }

    this.log.debug(`${this.name} command or request is waiting...`);
    return new Promise(resolve => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (condition()) {
          this.log.debug(`${this.name} command or request is proceeding.`);
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 250);
    });
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Received events for ${this.name}`);

    const service = this.services.find(s => s.componentId === event.componentId && s.capabilities.find(c => c === event.capability));

    if (service) {
      this.log.debug(`Event for ${this.name}:${event.componentId} - ${event.value}`);
      service.processEvent(event);
    }

  }

}
