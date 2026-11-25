// Steganographic encoders/decoders for the class-A (hidden-instruction) suite.
//
// Each technique exposes encode(hidden, ...) -> carrier string (or bytes) and
// decode(carrier) -> hidden, plus, where useful, a `view` that shows what a
// human reviewer sees in a plain `cat`/rendered pane versus the raw code
// points. Everything is deterministic: the same input yields the same bytes.
//
// References (see README.md): Unicode tag "ASCII smuggling" (Rehberger /
// Goodside), Trojan Source bidi (Boucher & Anderson, CVE-2021-42574), emoji
// variation-selector smuggling (Paul Butler), Unicode confusables (UTS #39),
// terminal/ANSI escape injection (Leadbeater), PNG tEXt chunks (PNG spec).

import zlib from "node:zlib";

// A tiny seeded PRNG (mulberry32) so any random choice in a payload is
// reproducible from a seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 1. Unicode tags
// U+E0000..U+E007F mirror ASCII 0x00..0x7F. They carry no glyph, so a run of
// them is invisible after any visible carrier text.
const TAG_BASE = 0xe0000;
export function encodeTags(hidden) {
  let out = "";
  for (const ch of hidden) {
    const cp = ch.codePointAt(0);
    out += cp <= 0x7f ? String.fromCodePoint(TAG_BASE + cp) : ch;
  }
  return out;
}
export function decodeTags(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= TAG_BASE && cp <= TAG_BASE + 0x7f) {
      out += String.fromCharCode(cp - TAG_BASE);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 2. Zero-width bits
// ZWSP=0, ZWNJ=1; the hidden bytes are spelled out in a run of these two
// invisible characters. ZWJ/WJ/BOM are also recognized as carriers on decode.
const ZW0 = "​"; // ZERO WIDTH SPACE
const ZW1 = "‌"; // ZERO WIDTH NON-JOINER
const ZW_SET = new Set(["​", "‌", "‍", "⁠", "﻿"]);
export function encodeZeroWidth(hidden) {
  const bytes = Buffer.from(hidden, "utf8");
  let bits = "";
  for (const b of bytes) {
    bits += b.toString(2).padStart(8, "0");
  }
  return [...bits].map((x) => (x === "0" ? ZW0 : ZW1)).join("");
}
export function decodeZeroWidth(s) {
  const bits = [...s].filter((c) => c === ZW0 || c === ZW1).map((c) => (c === ZW0 ? "0" : "1")).join("");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes).toString("utf8");
}

// ---------------------------------------------------------------- 3. Bidi (Trojan Source)
// The model reads code points in logical order; an editor renders them with the
// Unicode bidi algorithm. We place the instruction in logical order and wrap a
// decoy so a reviewer scanning the rendered line is misled. decode = strip the
// bidi controls and read the logical text (what the model/gate actually sees).
const RLO = "‮"; // RIGHT-TO-LEFT OVERRIDE
const PDF = "‬"; // POP DIRECTIONAL FORMATTING
const RLI = "⁦"; // LEFT-TO-RIGHT ISOLATE (2066 is LRI; 2067 RLI)
const BIDI_CONTROLS = new Set(["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"]);
export function encodeBidi(hidden, decoy = "return // nothing to see here") {
  // Logical order holds the instruction; the trailing override+decoy is what a
  // bidi renderer reorders to the front of the visual line.
  return `${hidden}${RLO}${[...decoy].reverse().join("")}${PDF}`;
}
export function decodeBidi(s) {
  // Strip bidi controls and the reversed decoy tail; return the logical prefix.
  const i = s.indexOf(RLO);
  const logical = i >= 0 ? s.slice(0, i) : s;
  return stripBidi(logical).trim();
}
export function stripBidi(s) {
  return [...s].filter((c) => !BIDI_CONTROLS.has(c)).join("");
}

// ---------------------------------------------------------------- 4. Variation selectors
// VS1..VS16 (U+FE00..FE0F) and the supplementary block (U+E0100..E01EF) can be
// chained after any base character as a byte channel (Paul Butler). Invisible.
function byteToVS(b) {
  return b < 16 ? 0xfe00 + b : 0xe0100 + (b - 16);
}
function vsToByte(cp) {
  if (cp >= 0xfe00 && cp <= 0xfe0f) {
    return cp - 0xfe00;
  }
  if (cp >= 0xe0100 && cp <= 0xe01ef) {
    return cp - 0xe0100 + 16;
  }
  return null;
}
export function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}
export function encodeVariation(hidden, base = "❤") {
  const bytes = Buffer.from(hidden, "utf8");
  return base + [...bytes].map((b) => String.fromCodePoint(byteToVS(b))).join("");
}
export function decodeVariation(s) {
  const out = [];
  for (const ch of s) {
    const b = vsToByte(ch.codePointAt(0));
    if (b !== null) {
      out.push(b);
    }
  }
  return Buffer.from(out).toString("utf8");
}

// ---------------------------------------------------------------- 5. Homoglyphs
// Confusable look-alikes (UTS #39). Not invisible, but visually identical, so a
// keyword scan for "curl"/"rm" misses them. decode = fold confusables to ASCII.
const CONFUSABLE_TO_ASCII = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
  "і": "i", "ԁ": "d", "ο": "o", "ѕ": "s", "һ": "h", "ɡ": "g", "ј": "j",
};
const ASCII_TO_CONFUSABLE = Object.fromEntries(Object.entries(CONFUSABLE_TO_ASCII).map(([k, v]) => [v, k]));
export function encodeHomoglyph(text) {
  return [...text].map((c) => ASCII_TO_CONFUSABLE[c] ?? c).join("");
}
export function decodeHomoglyph(s) {
  return [...s].map((c) => CONFUSABLE_TO_ASCII[c] ?? c).join("");
}

// ---------------------------------------------------------------- 6. ANSI conceal (poisoned output)
// Terminal escape injection: ESC[8m (conceal) and cursor moves hide text in a
// tool's stdout while the visible pane shows something benign. decode = strip
// the escapes. The model receives the raw bytes (including the concealed part).
const ESC = "\u001b";
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
export function encodeAnsiConceal(visible, hidden) {
  // Concealed instruction, then a carriage return + visible decoy over it.
  return `${ESC}[8m${hidden}${ESC}[0m\r${visible}`;
}
export function decodeAnsi(s) {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}

// ---------------------------------------------------------------- 7. Encodings in comments
export function encodeBase64(hidden) {
  return Buffer.from(hidden, "utf8").toString("base64");
}
export function decodeBase64(s) {
  return Buffer.from(s, "base64").toString("utf8");
}
export function rot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// ---------------------------------------------------------------- 8. PNG tEXt chunk
// A valid 1x1 PNG carrying an instruction in a tEXt metadata chunk. Some
// pipelines surface image metadata to the model; a reviewer looking at the
// rendered pixel never sees it.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "latin1");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
export function encodePngText(hidden, keyword = "Comment") {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.from([0x00, 0xff, 0xff, 0xff]); // one white pixel (filter byte + RGB)
  const idat = zlib.deflateSync(raw);
  const text = Buffer.concat([Buffer.from(`${keyword}\0`, "latin1"), Buffer.from(hidden, "latin1")]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
export function decodePngText(buf) {
  let off = 8;
  const out = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      out.push(data.toString("latin1", nul + 1));
    }
    off += 12 + len;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- views / helpers
// A reviewer-facing "visible" rendering: drop every invisible/format code point
// so the string shows what a plain pane (that does not render the channel)
// would show. This is for the invisibility demonstration only.
export function visibleView(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= TAG_BASE && cp <= TAG_BASE + 0x7f) ||
      ZW_SET.has(ch) ||
      BIDI_CONTROLS.has(ch) ||
      isVariationSelector(cp) ||
      ch === "­"
    ) {
      continue;
    }
    out += ch;
  }
  return renderTerminal(out);
}

// Emulate what a terminal actually shows: concealed spans (SGR 8) are not drawn,
// other escapes are dropped, and a carriage return overwrites the line from
// column 0 (how ESC[8m<hidden>ESC[0m\r<decoy> hides the hidden part).
export function renderTerminal(s) {
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u001b\[(?:[0-9;]*;)?8m[\s\S]*?\u001b\[0m/g, "");
  s = s.replace(ANSI_RE, "");
  return s
    .split("\n")
    .map((line) => {
      let col = 0;
      const buf = [];
      for (const ch of line) {
        if (ch === "\r") {
          col = 0;
        } else {
          buf[col++] = ch;
        }
      }
      return buf.join("");
    })
    .join("\n");
}

// Show the code points of a short string, for the "invisible in cat, present in
// the bytes" demonstration.
export function codepoints(s) {
  return [...s].map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
}
