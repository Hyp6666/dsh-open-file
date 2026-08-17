const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const MAX_CODE_POINTS = 180;

function removeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("");
}

function truncateRetainingExtension(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_CODE_POINTS) return value;

  const lastDot = value.lastIndexOf(".");
  const extension = lastDot > 0 ? value.slice(lastDot) : "";
  const extensionCharacters = [...extension];
  if (extensionCharacters.length >= 32) {
    return characters.slice(0, MAX_CODE_POINTS).join("");
  }
  return `${characters.slice(0, MAX_CODE_POINTS - extensionCharacters.length).join("")}${extension}`;
}

export function sanitizeDisplayName(input: string): string {
  let value = removeControlCharacters(input.normalize("NFC"))
    .replace(BIDI_CONTROLS, "")
    .replace(/[\\/]/gu, "_")
    .trim()
    .replace(/[ .]+$/gu, "")
    .replace(/^\.+/u, "_")
    .replace(/^_+/u, "_");

  if (value.length === 0 || /^_+$/u.test(value)) value = "unnamed";
  if (WINDOWS_RESERVED_NAME.test(value)) value = `_${value}`;
  value = truncateRetainingExtension(value);
  return value.length === 0 ? "unnamed" : value;
}
