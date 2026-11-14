# Backdrop still provenance

The first-visit home backdrop still (`src/poster.ts`), named `<mapId>.<mapSeed>.<size>.webp`. A first visit opens on
this map, so the still matches the live scene that fades in over it. It is also the background of `index.html`'s boot
shell (preloaded there), so it paints with the first frame, before any JavaScript: keep exactly one still here, and
point `index.html` at it.

The game rendered the file itself: a production build (`pnpm build`) served by
`node apps/server/src/main.ts`, opened in headless Chromium 148 (WebGL2 through ANGLE, 1600×900, device scale 1) at
`/?map=ridges&mapSeed=4409&size=48&renderer=webgl`. The home's own capture path (`capturePoster`, the first settled
Surface frame, scaled to 1280 px wide and encoded to WebP at quality 0.72 by `src/poster.worker.ts`) stored the still
in Cache Storage, and the file was copied out of it unchanged. No other tooling or edits were involved.

Regenerate after a visible change to the Surface look or the default map generator (a stale still only shortens the
crossfade's match; returning visitors always get their own fresh capture).

## Public social preview

`../../public/social/agent-command-51cc5dd09324.jpg` (1200×630) is rendered by `pnpm banners` (entry `og` in
`tools/readme-art/banners.json`, layout in `tools/readme-art/templates.mjs`) from this same public Ridges still and
`../../src/brand/logo.webp`, not a live/private match: the still with cover fit under a dark horizontal gradient, a
gold top rule, the 660 px-wide wordmark at (38, 38) and the tagline, facts line and site in the vendored Bangers and
Special Elite fonts, captured by headless Chromium as JPEG quality 92. The filename includes the first 12 hex digits
of the file's SHA-256; `pnpm banners` writes the new hashed name and updates the homepage metadata/structured-data
URLs (`index.html`) and this paragraph together. Inspect the card at 600×315 social-feed scale after a change.
