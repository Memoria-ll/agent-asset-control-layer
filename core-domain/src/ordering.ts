/**
 * UTF-16 code-unit order, shared by the asset parser and the resolver.
 *
 * Not `localeCompare`: its order depends on the host's locale and ICU build, so
 * the same snapshot would resolve to a different asset order on a different
 * machine. The canonical order a resolution is required to reproduce has to be
 * a property of the data alone.
 */
export const codeUnitCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
