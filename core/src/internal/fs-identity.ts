import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";

export type FileIdentity = {
  readonly dev: number;
  readonly ino: number;
};

export type IdentityPathKind = "directory" | "file";

export class FileIdentityError extends Error {
  public readonly code = "ECOMPROMISED";
  public readonly kind: IdentityPathKind;

  public constructor(kind: IdentityPathKind, message: string) {
    super(message);
    this.name = "FileIdentityError";
    this.kind = kind;
  }
}

export const fileIdentityOf = (info: Stats): FileIdentity => ({ dev: info.dev, ino: info.ino });

export const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const identityFailure = (kind: IdentityPathKind, path: string): FileIdentityError =>
  new FileIdentityError(kind, `The ${kind} path changed during the operation: ${path}`);

export const assertDirectoryIdentity = (path: string, expected: FileIdentity): void => {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw identityFailure("directory", path);
  }
  if (info.isSymbolicLink() || !info.isDirectory() || !sameFileIdentity(expected, fileIdentityOf(info))) {
    throw identityFailure("directory", path);
  }
};

export const assertRegularFileIdentity = (path: string, expected: FileIdentity): void => {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw identityFailure("file", path);
  }
  if (info.isSymbolicLink() || !info.isFile() || !sameFileIdentity(expected, fileIdentityOf(info))) {
    throw identityFailure("file", path);
  }
};
