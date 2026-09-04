import { describe, expect, it } from "vitest";
import { parseResolvedContextDto, tryParseResolvedContextDto } from "../src/index.ts";

const resolvedContext = (reason: Record<string, unknown>, conflicts: unknown[] = []): unknown => ({
  context: {
    executionMode: "advisory_preparation",
    workflow: { kind: "none" },
  },
  assets: [{
    assetId: "asset-1",
    revision: "revision-1",
    assetType: "skill",
    loadingTier: "core",
    reason,
  }],
  conflicts,
  cost: { totalTokenEstimate: 0, includedAssetCount: 1, excludedAssetCount: 0 },
  resolvedAt: "2026-08-30T01:02:03+09:00",
});

describe("resolution status contract", () => {
  it("D5: rejects rank fields from a public reason", () => {
    const result = tryParseResolvedContextDto(resolvedContext({
      kind: "included",
      explanation: "Matched scope",
      matchedAxes: [],
      rank: {
        explicitPriority: -1,
        matchingAxisCount: 0,
        scopePrecedence: [],
        directoryDepth: 0,
        sourceLayerPrecedence: 0,
      },
    }));

    expect(result.ok).toBe(false);
  });

  it("D6: round-trips all eight conflict arms", () => {
    const conflicts = [
      { kind: "exclusive_tie", explanation: "Tie", mergeGroup: "group-1", involvedAssetIds: ["asset-1"] },
      { kind: "mandatory_conflict", explanation: "Mandatory conflict", involvedAssetIds: ["asset-1"] },
      { kind: "operation_conflict", explanation: "Operation conflict", targetAssetId: "asset-1", involvedAssetIds: ["asset-1"] },
      { kind: "duplicate_identity", explanation: "Duplicate identity", assetId: "asset-1", involvedAssetIds: ["asset-1"] },
      { kind: "dependency_cycle", explanation: "Dependency cycle", involvedAssetIds: ["asset-1"] },
      { kind: "dependency_failure", explanation: "Dependency failure", failedRequirement: "asset-2", involvedAssetIds: ["asset-1"] },
      { kind: "asset_type_conflict", explanation: "Asset type conflict", involvedAssetIds: ["asset-1"] },
      { kind: "capability_failure", explanation: "Capability failure", failedCapabilities: ["capability-1"], involvedAssetIds: ["asset-1"] },
    ];

    const parsed = parseResolvedContextDto(resolvedContext(
      { kind: "included", explanation: "Matched scope", matchedAxes: [] },
      conflicts,
    ));

    expect(parsed.conflicts).toEqual(conflicts);
    expect(tryParseResolvedContextDto(resolvedContext(
      { kind: "included", explanation: "Matched scope", matchedAxes: [] },
      [{ ...conflicts[0], unexpected: true }],
    )).ok).toBe(false);
  });
});
