/**
 * The identifier shape an on-disk Canonical Asset frontmatter key or scalar is
 * written in.
 *
 * Capability ids and feature ids are embedded verbatim in frontmatter keys
 * (`capability.features.<capabilityId>`), so an id outside this shape has no
 * on-disk representation at all — which is why the in-memory capability
 * contract narrows to this predicate instead of accepting any non-empty string.
 */
export const isLowerKebabToken = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 64 &&
  /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value) &&
  !value.includes("--");
