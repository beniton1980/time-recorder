export type PunchLocation = { latitude: number; longitude: number; accuracy: number };
export type PunchLocationReader = {
  prepare(): Promise<void>;
  read(): Promise<PunchLocation | null>;
  clear(): void;
};
export const PUNCH_LOCATION_OPTIONS: Readonly<PositionOptions>;
export function createPunchLocationReader(options: {
  geolocation?: Geolocation;
  permissions?: Permissions;
  now?: () => number;
}): PunchLocationReader;
