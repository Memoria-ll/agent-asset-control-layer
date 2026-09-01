import { coreFailure, type CoreFailure } from "@aacl/core-domain";

/**
 * Re-root a failure's detail paths at the file they came from, so every reader of a
 * managed root reports a defect the same way: the path names the file, and the message
 * stays the domain's own wording.
 *
 * Shared by the asset store and the catalogue loader. A second reader that appended the
 * file to the message instead would force consumers to parse prose for one source and
 * read paths for another.
 */
export const withFilePath = (
  rootId: string,
  relativePath: string,
  sourceFailure: CoreFailure,
): CoreFailure => {
  const details = sourceFailure.details;
  if (details === undefined) {
    return coreFailure(sourceFailure.code, sourceFailure.message, [
      {
        path: ["root", rootId, "file", relativePath],
        code: "unavailable",
        message: sourceFailure.message,
      },
    ]);
  }
  return coreFailure(
    sourceFailure.code,
    sourceFailure.message,
    details.map((item) => {
      const path = item.path[0] === "document"
        ? ["root", rootId, "file", relativePath, ...item.path.slice(1)]
        : item.path[0] === "root"
          ? [...item.path]
          : ["root", rootId, "file", relativePath, ...item.path];
      return { ...item, path };
    }),
  );
};
