import { describe, expect, it } from "vitest";
import {
  CORE_ERROR_CODES,
  parseCoreErrorDto,
  type CoreErrorCode,
  type CoreErrorDetail,
} from "@aacl/shared";
import { coreFailure, toCoreErrorDto } from "../src/index.ts";

const code: CoreErrorCode = "internal";
const detail: CoreErrorDetail = {
  path: ["request"],
  code: "invalid_value",
  message: "The request is invalid.",
};

describe("core failures", () => {
  it("omits details when no details are supplied", () => {
    const dto = toCoreErrorDto(coreFailure(code, "Failure."));

    expect("details" in dto).toBe(false);
    expect(() => parseCoreErrorDto(dto)).not.toThrow();
  });

  it("omits an empty details array", () => {
    const dto = toCoreErrorDto(coreFailure(code, "Failure.", []));

    expect("details" in dto).toBe(false);
    expect(() => parseCoreErrorDto(dto)).not.toThrow();
  });

  it("preserves a non-empty details array", () => {
    const dto = toCoreErrorDto(coreFailure(code, "Failure.", [detail]));

    expect(dto.details).toHaveLength(1);
    expect(() => parseCoreErrorDto(dto)).not.toThrow();
  });

  it.each(["", "   "])('rejects an empty message "%s"', (message) => {
    expect(() => coreFailure(code, message)).toThrow();
  });

  it("keeps every shared error code parseable", () => {
    for (const errorCode of CORE_ERROR_CODES) {
      const dto = toCoreErrorDto(coreFailure(errorCode, "Failure."));
      expect(() => parseCoreErrorDto(dto)).not.toThrow();
    }
  });
});
