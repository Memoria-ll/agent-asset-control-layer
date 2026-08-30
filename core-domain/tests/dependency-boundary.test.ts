import { describe, expect, it } from "vitest";

type GlobOptions = {
  readonly eager?: boolean;
  readonly import?: string;
  readonly query?: string;
};

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options?: GlobOptions): Record<string, T>;
  }
}

const packageFiles = import.meta.glob<string>("../package.json", {
  eager: true,
  import: "default",
  query: "?raw",
});
const sourceFiles = import.meta.glob<string>("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});

const stripComments = (source: string): string => {
  let result = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line") {
      if (current === "\n") {
        state = "code";
        result += current;
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block") {
      if (current === "*" && next === "/") {
        state = "code";
        result += "  ";
        index += 1;
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      result += current;
      if (current === "\\") {
        result += next ?? "";
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "line";
      result += "  ";
      index += 1;
    } else if (current === "/" && next === "*") {
      state = "block";
      result += "  ";
      index += 1;
    } else {
      result += current;
      if (current === "'") state = "single";
      if (current === '"') state = "double";
      if (current === "`") state = "template";
    }
  }

  return result;
};

const moduleSpecifiers = (source: string): string[] => {
  const cleaned = stripComments(source);
  const specifiers: string[] = [];
  const staticImport = /\bimport\s+(?:(?:type\s+)?[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const staticExport = /\bexport\s+(?:\*|(?:type\s+)?[\s\S]*?)\s+from\s+["']([^"']+)["']/g;

  for (const match of cleaned.matchAll(staticImport)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const match of cleaned.matchAll(staticExport)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }

  for (const match of cleaned.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
    const argument = match[1]?.trim();
    if (argument === undefined) throw new Error("Dynamic import has no argument.");
    if (!/^(["'])[^"']*\1$/.test(argument)) {
      throw new Error("Dynamic imports must use string literals.");
    }
    specifiers.push(argument.slice(1, -1));
  }

  return specifiers;
};

const assertAllowedSpecifier = (specifier: string, sourceFile: string): void => {
  if (specifier.startsWith(".")) {
    if (!specifier.endsWith(".ts")) {
      throw new Error(`${sourceFile} uses a relative specifier without a .ts extension: ${specifier}`);
    }

    const pathParts = sourceFile.split("/");
    pathParts.pop();
    for (const part of specifier.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        pathParts.pop();
      } else {
        pathParts.push(part);
      }
    }
    if (pathParts[0] !== "..") {
      throw new Error(`${sourceFile} reaches outside core-domain: ${specifier}`);
    }
    return;
  }

  if (specifier !== "@aacl/shared") {
    throw new Error(`${sourceFile} imports a forbidden package: ${specifier}`);
  }
};

const packageManifest = (): Record<string, unknown> => {
  const raw = packageFiles["../package.json"];
  if (raw === undefined) throw new Error("core-domain/package.json was not found");
  return JSON.parse(raw) as Record<string, unknown>;
};

describe("core-domain dependency boundary", () => {
  it("declares only shared as a runtime dependency", () => {
    const manifest = packageManifest();
    expect(manifest.dependencies).toEqual({ "@aacl/shared": "workspace:*" });
    for (const field of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
      expect(manifest[field] === undefined ? {} : manifest[field]).toEqual({});
    }
    expect(manifest.name).toBe("@aacl/core-domain");
  });

  it("keeps all source imports inside the domain boundary", () => {
    const files = Object.entries(sourceFiles);
    expect(files.length).toBeGreaterThanOrEqual(2);

    for (const [file, source] of files) {
      for (const specifier of moduleSpecifiers(source)) {
        assertAllowedSpecifier(specifier, file);
      }
    }
  });

  it("ignores import-like text in comments", () => {
    expect(moduleSpecifiers('// import "node:fs"\n/* export * from "tauri" */')).toEqual([]);
  });

  it("rejects non-literal dynamic imports", () => {
    expect(() => moduleSpecifiers("import(moduleName)")).toThrow();
  });
});
