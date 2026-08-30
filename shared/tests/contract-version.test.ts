import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  checkContractCompatibility,
} from "../src/index.js";

describe("contract compatibility", () => {
  it.each([
    [CONTRACT_VERSION, CONTRACT_VERSION, "compatible"],
    ["0.1.0", "0.2.0", "incompatible"],
    ["1.2.0", "2.0.0", "incompatible"],
    ["1.2.0", "1.3.0", "compatible"],
    ["1.3.0", "1.2.0", "degraded"],
    ["1.2.0", "1.2.9", "compatible"],
  ])("classifies local %s and remote %s", (local, remote, status) => {
    const result = checkContractCompatibility(local, remote);

    expect(Object.keys(result).sort()).toEqual(["explanation", "status"]);
    expect(result.status).toBe(status);
  });
});
