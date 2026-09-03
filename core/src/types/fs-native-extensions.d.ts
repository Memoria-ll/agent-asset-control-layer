declare module "fs-native-extensions" {
  export type LockOptions = {
    readonly shared?: boolean;
  };

  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: LockOptions,
  ): boolean;

  export function unlock(fd: number, offset?: number, length?: number): void;
}
