/**
 * The one predicate deciding whether a name Core creates is valid on every supported
 * filesystem. A managed root is one store seen from both Windows and WSL, so a name only POSIX
 * accepts cannot be admitted.
 *
 * Every writer of a Core-created name shares this. A second copy drifts silently: the state
 * store's copy omitted the superscript device names for a whole review round while the asset
 * store's carried them, and nothing could see the two lists disagree.
 *
 * The superscript forms matter because Windows resolves `COM¹` to the same device as `COM1`.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
]);

/**
 * Whether one path segment is portable.
 *
 * Path separators are NOT rejected here: a caller holding a relative path splits it first, and
 * a caller holding a single name rejects them itself. An interior space is portable everywhere
 * and only a trailing one is not, which the trailing test covers alongside the dot Windows
 * strips.
 */
export const portableSegment = (segment: string): boolean => {
  if (/[<>"|?*]/.test(segment)) return false;
  if ([...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return false;
  if (/[. ]$/.test(segment)) return false;
  const stem = segment.split(".")[0]?.replace(/ +$/, "");
  return stem !== undefined && !WINDOWS_RESERVED_NAMES.has(stem.toUpperCase());
};

/**
 * Whether a name that must stand alone as one filename is portable.
 *
 * Beyond `portableSegment` this rejects emptiness and every separator, because the caller maps
 * the value straight onto a filename rather than splitting it into segments first.
 */
export const portableFileName = (value: string): boolean => {
  if (value.length === 0) return false;
  if (value.includes("\\") || value.includes("/") || value.includes(":") || value.includes("\0")) return false;
  return portableSegment(value);
};
