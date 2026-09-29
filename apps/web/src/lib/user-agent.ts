/**
 * A session row answers one question: "do I recognise this device?". A full
 * user agent buries that under twelve tokens of build metadata, so only the
 * browser and the operating system are kept. Nothing here is a security
 * claim — a user agent is client-supplied text.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\//, "Firefox"],
  [/\bChrome\//, "Chrome"],
  [/\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bWindows NT\b/, "Windows"],
  [/\b(?:iPhone|iPad|iPod|iPhone OS|CPU OS)\b/, "iOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

function firstMatch(value: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null {
  for (const [pattern, label] of table) if (pattern.test(value)) return label;
  return null;
}

/** `null` when the agent says nothing recognisable; the caller words that. */
export function describeUserAgent(userAgent: string | null | undefined): string | null {
  const value = (userAgent ?? "").trim();
  if (!value) return null;
  const browser = firstMatch(value, BROWSERS);
  const system = firstMatch(value, SYSTEMS);
  if (browser && system) return `${browser} · ${system}`;
  // An unrecognised agent is still evidence; show it, but never a whole
  // paragraph of it.
  return browser ?? system ?? (value.length > 40 ? `${value.slice(0, 39)}…` : value);
}
