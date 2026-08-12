import type { DeckSpec, RevealCompilerOptions, SlideBlock, SlideSpec } from "./types.js";

export class InvalidDeckSpecError extends Error {}

const DEFAULT_ASSETS: Required<RevealCompilerOptions> = {
  revealCssPath: "/vendor/reveal/reveal.css",
  revealThemeCssPath: "/vendor/reveal/theme/black.css",
  revealScriptPath: "/vendor/reveal/reveal.js",
  notesPluginScriptPath: "/vendor/reveal/plugin/notes/notes.js",
  bootstrapScriptPath: "/courseforge/deck-bootstrap.js",
};

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|[a-zA-Z]{3,20})$/;
const SAFE_LOCAL_PATH = /^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]+$/;

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const safeLocalPath = (value: string, label: string): string => {
  if (!SAFE_LOCAL_PATH.test(value) || value.includes("..") || value.startsWith("//")) {
    throw new InvalidDeckSpecError(`${label} must be a same-origin absolute path`);
  }
  return value;
};

const safeColor = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback;
  if (!SAFE_COLOR.test(value)) throw new InvalidDeckSpecError(`Unsafe theme color: ${value}`);
  return value;
};

function renderBlock(block: SlideBlock): string {
  switch (block.type) {
    case "paragraph":
      return `<p>${escapeHtml(block.text)}</p>`;
    case "bullets":
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    case "quote":
      return `<figure><blockquote>${escapeHtml(block.text)}</blockquote>${block.attribution ? `<figcaption>${escapeHtml(block.attribution)}</figcaption>` : ""}</figure>`;
    case "image": {
      const src = safeLocalPath(block.assetUri, "Image asset URI");
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" loading="eager">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
    }
  }
}

function renderSlide(slide: SlideSpec): string {
  const transition = slide.transition ?? "fade";
  const autoAnimate = slide.autoAnimate ? " data-auto-animate" : "";
  const duration = slide.durationMs ?? 5_000;
  return `<section data-slide-id="${escapeHtml(slide.slideId)}" data-duration-ms="${duration}" data-transition="${transition}"${autoAnimate}>
<h2>${escapeHtml(slide.title)}</h2>
${slide.blocks.map(renderBlock).join("\n")}
<aside class="notes">${escapeHtml(slide.notes)}</aside>
</section>`;
}

function validateDeck(deck: DeckSpec): void {
  if (!deck.deckId.trim() || !deck.title.trim()) throw new InvalidDeckSpecError("Deck id and title are required");
  if (deck.slides.length === 0) throw new InvalidDeckSpecError("A deck must contain at least one slide");
  const ids = new Set<string>();
  for (const slide of deck.slides) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(slide.slideId)) throw new InvalidDeckSpecError(`Invalid slide id: ${slide.slideId}`);
    if (ids.has(slide.slideId)) throw new InvalidDeckSpecError(`Duplicate slide id: ${slide.slideId}`);
    ids.add(slide.slideId);
    if (!slide.title.trim()) throw new InvalidDeckSpecError(`Slide ${slide.slideId} requires a title`);
    if (slide.durationMs !== undefined && (!Number.isInteger(slide.durationMs) || slide.durationMs < 250)) {
      throw new InvalidDeckSpecError(`Slide ${slide.slideId} has invalid duration`);
    }
  }
}

export function compileRevealHtml(deck: DeckSpec, options: RevealCompilerOptions = {}): string {
  validateDeck(deck);
  const assets = { ...DEFAULT_ASSETS, ...options };
  for (const [name, assetPath] of Object.entries(assets)) safeLocalPath(assetPath, name);
  const background = safeColor(deck.theme?.background, "#081421");
  const foreground = safeColor(deck.theme?.foreground, "#f4f8fb");
  const accent = safeColor(deck.theme?.accent, "#35d0ba");
  const bootstrapConfig = JSON.stringify({
    schemaVersion: deck.schemaVersion,
    deckId: deck.deckId,
    reveal: { hash: false, controls: true, progress: true, center: true, transition: "fade" },
  }).replaceAll("<", "\\u003c");
  const requestedLang = deck.lang ?? "";
  const lang = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(requestedLang) ? requestedLang : "zh-CN";

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(deck.title)}</title>
<link rel="stylesheet" href="${escapeHtml(assets.revealCssPath)}">
<link rel="stylesheet" href="${escapeHtml(assets.revealThemeCssPath)}">
<style>:root{--cf-bg:${background};--cf-fg:${foreground};--cf-accent:${accent}}.reveal{background:var(--cf-bg);color:var(--cf-fg)}.reveal h1,.reveal h2{color:var(--cf-accent)}.reveal img{max-height:70vh;object-fit:contain}</style>
</head>
<body>
<main class="reveal"><div class="slides">
${deck.slides.map(renderSlide).join("\n")}
</div></main>
<script id="courseforge-deck-config" type="application/json">${bootstrapConfig}</script>
<script src="${escapeHtml(assets.revealScriptPath)}"></script>
<script src="${escapeHtml(assets.notesPluginScriptPath)}"></script>
<script src="${escapeHtml(assets.bootstrapScriptPath)}"></script>
</body>
</html>`;
}
