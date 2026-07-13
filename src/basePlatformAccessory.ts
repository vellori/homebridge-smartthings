import { PlatformAccessory, Logger, API, Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';
import axios = require('axios');
import { IKHomeBridgeHomebridgePlatform } from './platform';
import { ShortEvent } from './webhook/subscriptionHandler';
import { SmartThingsBackoffError } from './smartThingsClient';

type DeviceStatus = {
  timestamp: number;
  //status: Record<string, unknown>;
  status: any;
};

const STATUS_CACHE_MS = 10000;
const HOMEKIT_READ_WAIT_MS = 2000;
/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export abstract class BasePlatformAccessory {
  // protected service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */

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
  protected deviceStatus: DeviceStatus = { timestamp: 0, status: undefined };
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
    // if (this.name === 'Test Lock') {
    //   platform.subscriptionHandler.addSubscription(this);
    // }
  }

  public abstract processEvent(event: ShortEvent):void;


  // Called by subclasses to refresh the status for the device.  Will only refresh if it has been more than
  // 4 seconds since last refresh
  //
  protected async refreshStatus(): Promise<boolean> {
    if (this.deviceStatus.status !== undefined && Date.now() - this.deviceStatus.timestamp <= STATUS_CACHE_MS) {
      return true;
    }
    if (!this.statusQueryInProgress) {
      this.statusQueryInProgress = true;
      void this.performStatusRefresh();
    }

    const completed = await this.waitFor(() => !this.statusQueryInProgress, HOMEKIT_READ_WAIT_MS);
    return completed ? this.lastStatusResult : false;
  }

  private async performStatusRefresh(): Promise<void> {
    try {
      if (!await this.waitFor(() => !this.commandInProgress)) {
        this.lastStatusResult = false;
        return;
      }
      const res = await this.axInstance.get(this.statusURL);
      if (res.data.components.main === undefined) {
        this.lastStatusResult = false;
        return;
      }
      this.deviceStatus.status = res.data.components.main;
      this.deviceStatus.timestamp = Date.now();
      this.failureCount = 0;
      this.online = true;
      this.lastStatusResult = true;
    } catch (error) {
      if (error instanceof SmartThingsBackoffError) {
        this.log.debug(`Status refresh deferred for ${this.name}: ${error.message}`);
      } else {
        const authorizationFailure = axios.default.isAxiosError(error) &&
          (error.response?.status === 401 || error.response?.status === 403);
        this.failureCount = authorizationFailure ? 5 : this.failureCount + 1;
        this.log.error(`Failed to request status from ${this.name}: ${error}. This is failure number ${this.failureCount}`);
        if (this.failureCount >= 5 && this.online) {
          this.giveUpTime = Date.now();
          this.online = false;
        }
      }
      this.lastStatusResult = false;
    } finally {
      this.statusQueryInProgress = false;
    }
  }

  protected startPollingState(pollSeconds: number, getValue: () => Promise<CharacteristicValue>, service: Service,
    chracteristic: WithUUID<new () => Characteristic>, targetStateCharacteristic?: WithUUID<new () => Characteristic>,
    getTargetState?: () => Promise<CharacteristicValue>):NodeJS.Timeout|void {

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
              .catch(error => {
                if (error instanceof SmartThingsBackoffError) {
                  this.log.debug(`Health recheck deferred for ${this.name}: ${error.message}`);
                } else {
                  this.log.warn(`Could not recheck health for ${this.name}: ${error}`);
                }
              })
              .finally(() => this.healthCheckInProgress = false);
          }
        }
      }, pollSeconds * 1000 + Math.floor(Math.random() * pollSeconds * 1000));
    }
  }

  async sendCommand(capability: string, command: string, args?: unknown[]): Promise<boolean> {

    let cmd: unknown;

    if (args) {
      cmd = {
        capability: capability,
        command: command,
        arguments: args,
      };
    } else {
      cmd = {
        capability: capability,
        command: command,
      };
    }

    const commandBody = JSON.stringify([cmd]);
    if (!await this.waitFor(() => !this.commandInProgress)) {
      return false;
    }
    this.commandInProgress = true;
    try {
      await this.axInstance.post(this.commandURL, commandBody);
      this.deviceStatus.timestamp = 0;
      return true;
    } catch (error) {
      this.log.error(`${command} failed for ${this.name}: ${error}`);
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
}
