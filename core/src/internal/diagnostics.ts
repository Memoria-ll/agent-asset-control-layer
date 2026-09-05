import { coreFailure, type CanonicalAsset, type CoreFailure } from "@aacl/core-domain";

/**
 * The failure a reader owes when an asset carries an operation it cannot apply,
 * or `undefined` when the asset is a plain `add`.
 *
 * A reader that turns one asset straight into an active artifact — an executable
 * Workflow definition, the live metadata catalogue — sees a single file and never
 * the snapshot the operation is about. An `override` is applicable only relative to
 * the candidate it replaces and a `disable` is an instruction to drop one, so
 * consuming either here activates exactly what resolution would have removed. The
 * Skill store's read half is deliberately not a caller: `loadSkill` feeds
 * `updateSkill`, and refusing there would make an overlay file uneditable through
 * the store that owns it.
 */
export const unresolvedOperationFailure = (asset: CanonicalAsset): CoreFailure | undefined =>
  asset.operation === "add"
    ? undefined
    : coreFailure("invalid_request", "The asset carries a resolution operation this reader cannot apply.", [
        {
          path: ["asset", "operation"],
          code: "unresolved_asset_operation",
          message: `The asset declares operation "${asset.operation}", which only scope resolution can apply.`,
        },
      ]);

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
