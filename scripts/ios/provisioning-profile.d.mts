export type BoundedProvisioningProfile = {
  name: string;
  uuid: string;
  teamIdentifiers: string[];
  expirationDate: string;
  provisionsAllDevicesPresent: boolean;
  provisionsAllDevices: boolean | null;
  provisionedDevicesPresent: boolean;
  provisionedDeviceCount: number;
  entitlements: Record<string, unknown>;
};

export function parseDecodedProvisioningProfile(value: Buffer | string): BoundedProvisioningProfile;
