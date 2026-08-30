import { readFileSync } from "node:fs";

const expectedPackages = ["shared", "core-domain", "core", "vscode-extension"];

const fail = (message) => {
  console.error(`workspace packages: ${message}`);
  process.exit(1);
};

const workspaceText = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
// The workspace file uses two-space list indentation; this preflight intentionally parses that fixed shape.
const packageNames = [...workspaceText.matchAll(/^  - ([^\s]+)\s*$/gm)].map((match) => match[1]);
if (
  packageNames.length !== expectedPackages.length ||
  new Set(packageNames).size !== expectedPackages.length ||
  expectedPackages.some((name) => !packageNames.includes(name))
) {
  fail(`workspace package set is ${JSON.stringify(packageNames)}`);
}

for (const packageName of expectedPackages) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(new URL(`../${packageName}/package.json`, import.meta.url), "utf8"),
    );
  } catch {
    fail(`missing or invalid manifest for ${packageName}`);
  }

  if (manifest.name !== `@aacl/${packageName === "vscode-extension" ? "vscode-extension" : packageName}`) {
    fail(`unexpected package name for ${packageName}: ${manifest.name}`);
  }
  if (typeof manifest.scripts?.typecheck !== "string" || typeof manifest.scripts?.test !== "string") {
    fail(`${packageName} must define typecheck and test scripts`);
  }
}

console.log("workspace packages: OK");
