import { Service, PlatformAccessory, CharacteristicValue, MacAddress } from 'homebridge';
import { SwitchBotPlatform } from '../platform';
import { interval, Subject } from 'rxjs';
import { skipWhile } from 'rxjs/operators';
import { DeviceURL, device, deviceStatusResponse } from '../settings';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Contact {
  // Services
  private service: Service;
  motionService: Service;

  // Characteristic Values
  ContactSensorState!: CharacteristicValue;
  MotionDetected!: CharacteristicValue;

  // Others
  deviceStatus!: deviceStatusResponse;
  BLEmotion!: boolean;
  BLEstate!: boolean;
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

  // Updates
  contactUbpdateInProgress!: boolean;
  doContactUpdate;

  constructor(
    private readonly platform: SwitchBotPlatform,
    private accessory: PlatformAccessory,
    public device: device,
  ) {
    // default placeholders
    this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;

    // BLE Connection
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const SwitchBot = require('node-switchbot');
      this.switchbot = new SwitchBot();
      const colon = device.deviceId!.match(/.{1,2}/g);
      const bleMac = colon!.join(':'); //returns 1A:23:B4:56:78:9A;
      this.device.bleMac = bleMac.toLowerCase();
      this.platform.device(this.device.bleMac.toLowerCase());
    }

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doContactUpdate = new Subject();
    this.contactUbpdateInProgress = false;

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.platform.Characteristic.Model, 'SWITCHBOT-WOCONTACT-W1201500')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceId);

    // get the Battery service if it exists, otherwise create a new Contact service
    // you can create multiple services for each accessory
    (this.service =
      accessory.getService(this.platform.Service.ContactSensor) ||
      accessory.addService(this.platform.Service.ContactSensor)), `${device.deviceName} ${device.deviceType}`;

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // accessory.getService('NAME') ?? accessory.addService(this.platform.Service.Contact, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/MotionSensor
    (this.motionService =
      accessory.getService(this.platform.Service.MotionSensor) ||
      accessory.addService(this.platform.Service.MotionSensor)), `${device.deviceName} ${device.deviceType}`;

    // Retrieve initial values and updateHomekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.platform.config.options!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.contactUbpdateInProgress))
      .subscribe(() => {
        this.refreshStatus();
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
    this.MotionDetected = Boolean(this.BLEmotion);
    this.ContactSensorState = Boolean(this.BLEstate);
    this.platform.debug(`${this.accessory.displayName}
    , ContactSensorState: ${this.ContactSensorState}, MotionDetected: ${this.MotionDetected}`);
  }

  private async openAPIparseStatus() {
    if (this.deviceStatus.body.openState === 'open') {
      this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
      this.platform.log.info(`${this.accessory.displayName} ${this.deviceStatus.body.openState}`);
    } else if (this.deviceStatus.body.openState === 'close') {
      this.ContactSensorState = this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
      this.platform.device(`${this.accessory.displayName} ${this.deviceStatus.body.openState}`);
    } else {
      this.platform.device(`${this.accessory.displayName} ${this.deviceStatus.body.openState}`);
    }
    this.MotionDetected = Boolean(this.deviceStatus.body.moveDetected);
    this.platform.debug(`${this.accessory.displayName}
    , ContactSensorState: ${this.ContactSensorState}, MotionDetected: ${this.MotionDetected}`);
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus() {
    if (this.platform.config.options?.ble?.includes(this.device.deviceId!)) {
      await this.BLERefreshStatus();
    } else {
      await this.openAPIRefreshStatus();
    }
  }

  private async BLERefreshStatus() {
    this.platform.debug('Contact BLE Device RefreshStatus');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Switchbot = require('node-switchbot');
    const switchbot = new Switchbot();
    const colon = this.device.deviceId!.match(/.{1,2}/g);
    const bleMac = colon!.join(':'); //returns 1A:23:B4:56:78:9A;
    this.device.bleMac = bleMac.toLowerCase();
    this.platform.device(this.device.bleMac!);
    switchbot.onadvertisement = (ad: any) => {
      this.platform.log.info(JSON.stringify(ad, null, '  '));
      this.platform.device('ad:', JSON.stringify(ad));
      this.BLEmotion = ad.serviceData.motion;
      this.BLEstate = ad.serviceData.state;
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
        await this.openAPIRefreshStatus();
      });
    setInterval(() => {
      this.platform.log.info('Start scan ' + this.device.deviceName + '(' + this.device.bleMac + ')');
      switchbot
        .startScan({
          mode: 'D',
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
          await this.openAPIRefreshStatus();
        });
      this.parseStatus();
      this.updateHomeKitCharacteristics();
    }, this.platform.config.options!.refreshRate! * 60000);
  }

  private async openAPIRefreshStatus() {
    try {
      const deviceStatus: deviceStatusResponse = (
        await this.platform.axios.get(`${DeviceURL}/${this.device.deviceId}/status`)
      ).data;
      if (deviceStatus.message === 'success') {
        this.deviceStatus = deviceStatus;
        this.platform.debug(`Contact ${this.accessory.displayName} refreshStatus - ${JSON.stringify(this.deviceStatus)}`);

        this.parseStatus();
        this.updateHomeKitCharacteristics();
      } else {
        this.platform.debug(this.deviceStatus);
      }
    } catch (e: any) {
      this.platform.log.error(`Contact - Failed to refresh status of ${this.device.deviceName} - ${JSON.stringify(e.message)}`);
      this.platform.debug(`Contact ${this.accessory.displayName} - ${JSON.stringify(e)}`);
      this.apiError(e);
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  updateHomeKitCharacteristics() {
    if (this.ContactSensorState === undefined) {
      this.platform.debug(`ContactSensorState: ${this.ContactSensorState}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.ContactSensorState);
    }
    if (this.MotionDetected === undefined) {
      this.platform.debug(`MotionDetected: ${this.MotionDetected}`);
    } else {
      this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, this.MotionDetected);
    }
  }

  public apiError(e: any) {
    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, e);
    this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, e);
  }
}
