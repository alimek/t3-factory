/**
 * The color math Factory's palette mapping needs: OKLCH and sRGB conversion with gamut mapping by
 * chroma reduction, WCAG contrast, and Factory's own output formats. Every color it returns is
 * quantized to 8-bit sRGB, so contrast is measured on exactly the value clients paint.
 */

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}
/** Gamma-encoded sRGB channels in 0..1. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const toGamma = (channel: number) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** Linear sRGB channels, outside 0..1 where the color is out of gamut. */
export function linearFromOklch({ l, c, h }: Oklch): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  return [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
}

const inGamut = (channels: readonly number[]) =>
  channels.every((channel) => channel >= -1e-6 && channel <= 1 + 1e-6);
const quantize = (channel: number) => Math.round(Math.min(1, Math.max(0, channel)) * 255) / 255;

/** The displayable 8-bit sRGB color closest in chroma, keeping lightness and hue. */
export function toRgb(color: Oklch): Rgb {
  const l = Math.min(1, Math.max(0, color.l));
  let linear = linearFromOklch({ ...color, l });
  if (!inGamut(linear)) {
    let [low, high] = [0, color.c];
    for (let step = 0; step < 24; step++) {
      const c = (low + high) / 2;
      if (inGamut(linearFromOklch({ l, c, h: color.h }))) low = c;
      else high = c;
    }
    linear = linearFromOklch({ l, c: low, h: color.h });
  }
  const [r, g, b] = linear.map((channel) => quantize(toGamma(Math.min(1, Math.max(0, channel)))));
  return { r: r!, g: g!, b: b! };
}

export function toOklch({ r, g, b }: Rgb): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return {
    l: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    c: Math.hypot(a, bb),
    h: hue < 0 ? hue + 360 : hue,
  };
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;
const OKLCH = new RegExp(String.raw`^oklch\(${NUMBER} ${NUMBER} ${NUMBER}\)$`);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Opaque `oklch(L C H)` or `#rgb`/`#rrggbb`, the forms T3 authors built-in colors in. */
export function parseColor(text: string): Oklch | null {
  const oklch = OKLCH.exec(text);
  if (oklch) {
    const [l, c, h] = oklch.slice(1).map(Number) as [number, number, number];
    return l >= 0 && l <= 1 && c >= 0 ? { l, c, h: ((h % 360) + 360) % 360 } : null;
  }
  if (!HEX.test(text)) return null;
  const digits = text.length === 4 ? Array.from(text.slice(1), (digit) => digit + digit) : null;
  const pairs = digits ?? [text.slice(1, 3), text.slice(3, 5), text.slice(5, 7)];
  const [r, g, b] = pairs.map((pair) => Number.parseInt(pair, 16) / 255) as [
    number,
    number,
    number,
  ];
  return toOklch({ r, g, b });
}

export function luminance({ r, g, b }: Rgb) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(first: Rgb, second: Rgb) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Gamma-space blend from `from` toward `to`. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const blend = (x: number, y: number) => quantize(x + (y - x) * amount);
  return { r: blend(from.r, to.r), g: blend(from.g, to.g), b: blend(from.b, to.b) };
}

const byte = (channel: number) => Math.round(channel * 255);

export function formatHex(color: Rgb) {
  return `#${[color.r, color.g, color.b].map((channel) => byte(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function formatTranslucent(color: Rgb, alpha: number) {
  return `rgb(${byte(color.r)} ${byte(color.g)} ${byte(color.b)} / ${alpha})`;
}
