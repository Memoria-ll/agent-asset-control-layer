// Loads @aacl/shared the way the host-run Core will: a plain Node process
// resolving the package's `exports`, with no bundler and no test runner.
//
// This runs as its own gate step rather than as a test, because Vitest resolves
// modules through its own pipeline and therefore cannot see a broken `exports`
// target. That gap is not hypothetical: the package pointed `exports` at
// TypeScript sources whose relative specifiers ended in `.js`, so every consumer
// test passed while `node -e 'import("@aacl/shared")'` failed with
// ERR_MODULE_NOT_FOUND on the first sibling module.
import * as shared from "@aacl/shared";

const fail = (scope, message) => {
  console.error(`${scope} resolution: ${message}`);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+$/.test(shared.CONTRACT_VERSION)) {
  fail("shared", `CONTRACT_VERSION is not a version: ${shared.CONTRACT_VERSION}`);
}

const parsed = shared.parseResolveRequest({ scope: { projectId: "project-1" } });
if (parsed.scope.projectId !== "project-1") {
  fail("shared", "parseResolveRequest did not return the parsed scope");
}

const rejected = shared.tryParseResolveRequest({ scope: {}, zzz: 1 });
if (rejected.ok) {
  fail("shared", "tryParseResolveRequest accepted an unknown key");
}

if (!Array.isArray(shared.LOADING_TIERS) || shared.LOADING_TIERS.length === 0) {
  fail("shared", "LOADING_TIERS did not survive as plain data");
}

console.log("shared resolution: OK");

const coreDomain = await import("@aacl/core-domain");
if (
  typeof coreDomain.coreFailure !== "function" ||
  typeof coreDomain.toCoreErrorDto !== "function"
) {
  fail("core-domain", "failure functions did not survive as plain exports");
}

const dto = coreDomain.toCoreErrorDto(coreDomain.coreFailure("not_found", "x"));
if (dto.code !== "not_found" || dto.message !== "x" || "details" in dto) {
  fail("core-domain", "failure DTO did not preserve its contract shape");
}

console.log("core-domain resolution: OK");
