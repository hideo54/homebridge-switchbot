import { Service, PlatformAccessory, CharacteristicValue, MacAddress } from 'homebridge';
import { SwitchBotPlatform } from '../platform';
import { interval, Subject } from 'rxjs';
import { debounceTime, skipWhile, tap } from 'rxjs/operators';
import { DeviceURL, device } from '../settings';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Bot {
  private service: Service;

  SwitchOn!: CharacteristicValue;
  OutletInUse!: CharacteristicValue;
  deviceStatus!: { statusCode: number; body: { deviceId: string; deviceType: string; hubDeviceId: string; power: string; }; message: string; };
  RunTimer!: NodeJS.Timeout;
  ScanDuration: number;
  TargetState;
  switchbot!: {
    discover: (
      arg0:
        {
          duration: any;
          model: string;
          quick: boolean;
          id: MacAddress;
        }
    ) => Promise<any>;
    wait: (
      arg0: number
    ) => any;
  };

  botUpdateInProgress!: boolean;
  doBotUpdate;

  constructor(
    private readonly platform: SwitchBotPlatform,
    private accessory: PlatformAccessory,
    public device: device,
  ) {
    // default placeholders
    this.SwitchOn = false;
    this.ScanDuration = this.platform.config.options!.refreshRate!;
    if (!this.platform.config.options?.bot?.switch) {
      this.OutletInUse = true;
    }
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      this.SwitchOn = false;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const SwitchBot = require('node-switchbot');
      this.switchbot = new SwitchBot();
      const colon = device.deviceId!.match(/.{1,2}/g);
      const bleMac = colon!.join(':'); //returns 1A:23:B4:56:78:9A;
      this.device.bleMac = bleMac.toLowerCase();
      this.platform.device(this.device.bleMac);
    }

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doBotUpdate = new Subject();
    this.botUpdateInProgress = false;

    // Retrieve initial values and updateHomekit
    this.parseStatus();

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.platform.Characteristic.Model, 'SWITCHBOT-BOT-S1')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceId!);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    if (this.platform.config.options?.bot?.switch) {
      (this.service =
        accessory.getService(this.platform.Service.Switch) ||
        accessory.addService(this.platform.Service.Switch)), `${device.deviceName} ${device.deviceType}`;
    } else {
      (this.service =
        accessory.getService(this.platform.Service.Outlet) ||
        accessory.addService(this.platform.Service.Outlet)), `${device.deviceName} ${device.deviceType}`;
    }

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // accessory.getService('NAME') ?? accessory.addService(this.platform.Service.Outlet, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Outlet

    this.service.getCharacteristic(this.platform.Characteristic.On).onSet(this.handleOnSet.bind(this));

    // Retrieve initial values and updateHomekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.platform.config.options!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.botUpdateInProgress))
      .subscribe(() => {
        this.refreshStatus();
      });

    // Watch for Bot change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    this.doBotUpdate
      .pipe(
        tap(() => {
          this.botUpdateInProgress = true;
        }),
        debounceTime(100),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges();
        } catch (e: any) {
          this.platform.log.error(JSON.stringify(e.message));
          this.platform.debug(`Bot ${accessory.displayName} - ${JSON.stringify(e)}`);
          this.apiError(e);
        }
        this.botUpdateInProgress = false;
      });
  }

  /**
   * Parse the device status from the SwitchBot api
   */
  async parseStatus() {
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      await this.BLEparseStatus();
    } else {
      await this.openAPIparseStatus();
    }
  }

  private async BLEparseStatus() {
    this.platform.debug('Bots BLE Device RefreshStatus');
  }

  private async openAPIparseStatus() {
    if (!this.platform.config.options?.bot?.switch) {
      this.OutletInUse = true;
      if (this.platform.config.options?.bot?.device_press?.includes(this.device.deviceId!)) {
        this.SwitchOn = false;
      }
      this.platform.debug(`Bot ${this.accessory.displayName} OutletInUse: ${this.OutletInUse} On: ${this.SwitchOn}`);
    } else {
      if (this.platform.config.options?.bot?.device_press?.includes(this.device.deviceId!)) {
        this.SwitchOn = false;
      }
      this.platform.debug(`Bot ${this.accessory.displayName} On: ${this.SwitchOn}`);
    }
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus() {
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      await this.BLErefreshStatus();
    } else {
      await this.openAPIRefreshStatus();
    }
  }

  private async BLErefreshStatus() {
    this.platform.device('Bot BLE Device refreshStatus');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Switchbot = require('node-switchbot');
    const switchbot = new Switchbot();
    const colon = this.device.deviceId!.match(/.{1,2}/g);
    const bleMac = colon!.join(':'); //returns 1A:23:B4:56:78:9A;
    this.device.bleMac = bleMac.toLowerCase();
    this.platform.device(this.device.bleMac!);
    switchbot.onadvertisement = (ad: any) => {
      this.platform.debug(JSON.stringify(ad, null, '  '));
      this.platform.device(`ad: ${JSON.stringify(ad)}`);
    };
    switchbot
      .startScan({
        id: this.device.bleMac,
      })
      .then(() => {
        return switchbot.wait(this.platform.config.options!.refreshRate! * 1000);
      })
      .then(() => {
        switchbot.stopScan();
      })
      .catch(async (error: any) => {
        this.platform.log.error(error);
        this.openAPIRefreshStatus();
      });
    setInterval(() => {
      this.platform.log.info('Start scan ' + this.device.deviceName + '(' + this.device.bleMac + ')');
      switchbot
        .startScan({
          mode: 'T',
          id: bleMac,
        })
        .then(() => {
          return switchbot.wait(this.platform.config.options!.refreshRate! * 1000);
        })
        .then(() => {
          switchbot.stopScan();
          this.platform.log.info('Stop scan ' + this.device.deviceName + '(' + this.device.bleMac + ')');
        })
        .catch(async (error: any) => {
          this.platform.log.error(error);
          this.openAPIRefreshStatus();
        });
      this.parseStatus();
      this.updateHomeKitCharacteristics();
    }, this.platform.config.options!.refreshRate! * 60000);
  }

  private async openAPIRefreshStatus() {
    try {
      this.deviceStatus = {
        statusCode: 100,
        body: {
          deviceId: this.device.deviceId!,
          deviceType: this.device.deviceType!,
          hubDeviceId: this.device.hubDeviceId,
          power: 'on',
        },
        message: 'success',
      };
      this.parseStatus();
      this.updateHomeKitCharacteristics();
    } catch (e: any) {
      this.platform.log.error(`Bot - Failed to refresh status of ${this.device.deviceName} - ${JSON.stringify(e.message)}`);
      this.platform.debug(`Bot ${this.accessory.displayName} - ${JSON.stringify(e)}`);
      this.apiError(e);
    }
  }

  /**
   * Pushes the requested changes to the SwitchBot API
   * deviceType	commandType	  Command	    command parameter	  Description
   * Bot   -    "command"     "turnOff"   "default"	  =        set to OFF state
   * Bot   -    "command"     "turnOn"    "default"	  =        set to ON state
   * Bot   -    "command"     "press"     "default"	  =        trigger press
   */
  async pushChanges() {
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      await this.BLEpushChanges();
    } else {
      await this.openAPIpushChanges();
    }
    this.refreshStatus();
  }

  private async BLEpushChanges() {
    this.platform.device('Bot BLE Device pushChanges');
    // Target state has been changed.
    this.platform.log.info('Target state of Bot setting: ' + (this.TargetState ? 'ON' : 'OFF'));
    this.switchbot
      .discover({ duration: this.ScanDuration, model: 'H', quick: true, id: (this.device.bleMac!) })
      .then((device_list: any) => {
        this.platform.log.info('Scan done.');
        let targetDevice: any = null;
        for (const device of device_list) {
          // log.info(device.modelName, device.address);
          if (device.address === this.device.bleMac) {
            targetDevice = device;
            break;
          }
        }
        if (!targetDevice) {
          this.platform.log.info('No device was found during scan.');
          return new Promise((resolve, reject) => {
            reject(new Error('No device was found during scan.'));
          });
        } else {
          this.platform.log.info(targetDevice.modelName + ' (' + targetDevice.address + ') was found.');
          // Set event handers
          targetDevice.onconnect = () => {
            // log.info('Connected.');
          };
          targetDevice.ondisconnect = () => {
            // log.info('Disconnected.');
          };
          this.platform.log.info('Bot is running...');
          return this.setTargetDeviceState(targetDevice, this.TargetState);
        }
      })
      .then(() => {
        this.platform.log.info('Done.');
        this.SwitchOn = this.TargetState;
        this.RunTimer = setTimeout(() => {
          this.service?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.SwitchOn);
        }, 500);
        this.platform.log.info('Bot state has been set to: ' + (this.SwitchOn ? 'ON' : 'OFF'));
      })
      .catch((error: any) => {
        this.platform.log.error(error);
        this.RunTimer = setTimeout(() => {
          this.service?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.SwitchOn);
        }, 500);
        this.platform.log.info('Bot state failed to be set to: ' + (this.TargetState ? 'ON' : 'OFF'));
      });
  }

  private async openAPIpushChanges() {
    const payload = {
      commandType: 'command',
      parameter: 'default',
    } as any;

    if (this.platform.config.options?.bot?.device_switch?.includes(this.device.deviceId!) && this.SwitchOn) {
      payload.command = 'turnOn';
      this.SwitchOn = true;
      this.platform.debug(`Switch Mode, Turning ${this.SwitchOn}`);
    } else if (this.platform.config.options?.bot?.device_switch?.includes(this.device.deviceId!) && !this.SwitchOn) {
      payload.command = 'turnOff';
      this.SwitchOn = false;
      this.platform.debug(`Switch Mode, Turning ${this.SwitchOn}`);
    } else if (this.platform.config.options?.bot?.device_press?.includes(this.device.deviceId!)) {
      payload.command = 'press';
      this.platform.debug('Press Mode');
      this.SwitchOn = false;
    } else {
      throw new Error('Bot Device Paramters not set for this Bot.');
    }

    this.platform.log.info(
      'Sending request for',
      this.accessory.displayName,
      'to SwitchBot API. command:',
      payload.command,
      'parameter:',
      payload.parameter,
      'commandType:',
      payload.commandType,
    );
    this.platform.debug(`Bot ${this.accessory.displayName} pushchanges: ${JSON.stringify(payload)}`);

    // Make the API request
    const push: any = (await this.platform.axios.post(`${DeviceURL}/${this.device.deviceId}/commands`, payload));
    this.platform.debug(`Bot ${this.accessory.displayName} Changes pushed: ${JSON.stringify(push.data)}`);
    this.statusCode(push);
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  updateHomeKitCharacteristics() {
    if (this.SwitchOn === undefined) {
      this.platform.debug(`On: ${this.SwitchOn}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.SwitchOn);
    }
    if (this.OutletInUse === undefined || this.platform.config.options?.bot?.switch) {
      this.platform.debug(`On: ${this.OutletInUse}, Switch: ${this.platform.config.options?.bot?.switch}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.OutletInUse, this.OutletInUse);
    }
  }

  public apiError(e: any) {
    this.service.updateCharacteristic(this.platform.Characteristic.On, e);
    if (!this.platform.config.options?.bot?.switch) {
      this.service.updateCharacteristic(this.platform.Characteristic.OutletInUse, e);
    }
  }

  private statusCode(push: { data: { statusCode: any; }; }) {
    switch (push.data.statusCode) {
      case 151:
        this.platform.log.error('Command not supported by this device type.');
        break;
      case 152:
        this.platform.log.error('Device not found.');
        break;
      case 160:
        this.platform.log.error('Command is not supported.');
        break;
      case 161:
        this.platform.log.error('Device is offline.');
        break;
      case 171:
        this.platform.log.error('Hub Device is offline.');
        break;
      case 190:
        this.platform.log.error('Device internal error due to device states not synchronized with server. Or command fomrat is invalid.');
        break;
      case 100:
        this.platform.debug('Command successfully sent.');
        break;
      default:
        this.platform.debug('Unknown statusCode.');
    }
  }

  /**
   * Handle requests to set the "On" characteristic
   */
  private handleOnSet(value: CharacteristicValue) {
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      this.TargetState = value as boolean;
      this.platform.device(`Bot BLE Device - ${this.TargetState}`);
      if (this.TargetState === this.SwitchOn) {
        this.platform.log.info('Target state of Bot has not changed: ' + (this.SwitchOn ? 'ON' : 'OFF'));
        this.service?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.SwitchOn);
      }
    } else {
      this.platform.debug(`Bot ${this.accessory.displayName} - Set On: ${value}`);
      this.SwitchOn = value;
      this.doBotUpdate.next();
    }
  }

  async setTargetDeviceState(targetDevice: any, targetState: boolean): Promise<null> {
    return await this.retry(5, () => {
      if (targetState) {
        return targetDevice.turnOn();
      } else {
        return targetDevice.turnOff();
      }
    });
  }

  async retry(max: number, fn: { (): any; (): Promise<any>; }): Promise<null> {
    return fn().catch(async (err: any) => {
      if (max === 0) {
        throw err;
      }
      this.platform.log.info(err);
      this.platform.log.info('Retrying');
      await this.switchbot.wait(1000);
      return this.retry(max - 1, fn);
    });
  }

}
