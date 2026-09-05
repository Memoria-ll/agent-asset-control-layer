import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  checkContractCompatibility,
} from "../src/index.ts";

describe("contract compatibility", () => {
  it("uses the current contract version", () => {
    expect(CONTRACT_VERSION).toBe("0.6.0");
  });

  it("does not call two different versions a match", () => {
    const patchOnly = checkContractCompatibility("1.2.0", "1.2.9");
    const identical = checkContractCompatibility("1.2.0", "1.2.0");

    expect(patchOnly.status).toBe("compatible");
    // The explanation reaches the connection-state UI (#32), where calling two
    // visibly different versions a match reads as a defect in the check itself.
    expect(patchOnly.explanation).not.toMatch(/match/i);
    expect(patchOnly.explanation).toContain("1.2.9");
    expect(identical.status).toBe("compatible");
  });

  it.each([
    [CONTRACT_VERSION, CONTRACT_VERSION, "compatible"],
    ["0.1.0", "0.2.0", "incompatible"],
    ["0.4.9", "0.5.0", "incompatible"],
    ["0.5.0", "0.4.9", "incompatible"],
    ["1.2.0", "2.0.0", "incompatible"],
    // A minor difference is breaking in both readings: whichever side holds the
    // newer number sends a field the other side's strict objects reject.
    ["1.2.0", "1.3.0", "incompatible"],
    ["1.3.0", "1.2.0", "incompatible"],
    ["1.2.0", "1.2.9", "compatible"],
    ["1.2.0", "not-a-version", "incompatible"],
    // Adjacent either side of 2^53, where converting to a float would collapse
    // the two onto one value and report them as the same contract.
    ["9007199254740992.1.0", "9007199254740993.1.0", "incompatible"],
    ["1.9007199254740992.0", "1.9007199254740993.0", "incompatible"],
    ["9007199254740993.1.0", "9007199254740993.1.0", "compatible"],
  ])("classifies local %s and remote %s", (local, remote, status) => {
    const result = checkContractCompatibility(local, remote);

    expect(Object.keys(result).sort()).toEqual(["explanation", "status"]);
    expect(result.status).toBe(status);
  });

  it("gives the same verdict whichever side is called local", () => {
    const pairs: [string, string][] = [
      ["1.2.0", "1.3.0"],
      ["1.2.0", "2.0.0"],
      ["1.2.0", "1.2.9"],
      ["0.1.0", "0.2.0"],
    ];

    for (const [a, b] of pairs) {
      expect(
        checkContractCompatibility(a, b).status,
        `${a} vs ${b}`,
      ).toBe(checkContractCompatibility(b, a).status);
    }
  });
});
