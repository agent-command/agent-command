# Art direction research — Agent Command

Reference doc for choosing a distinctive look for a four-plane (Depths / Surface / Sky / Orbit) browser RTS on
Three.js r187 `WebGPURenderer` + TSL with WebGL2 fallback. Every factual claim links a source; things I could
not confirm from a primary source are marked **[unverified]**; my own reasoning or arithmetic is marked
**[inference]** / **[estimate]**. API names in §2–§3 were checked against the installed
`node_modules/.pnpm/three@0.187.0/node_modules/three/` source (paths given as `src/…` or `examples/jsm/…`).

Pre-migration baseline: flat box tiles with noise tint, one `bloom()` pass on a `RenderPipeline`, and a single-channel
48×48 `DataTexture` fog per plane (`RedFormat`, `LinearFilter`, eased 0..1, no "explored" tier).
This historical baseline has been replaced by Field Journal; current captures in `docs/media/` show the migrated
renderer, including RG8 three-tier fog. See [DIRECTIONS §7](DIRECTIONS.md#7-live-implementation-evidence) for measured
live-game evidence and limits; the research below records the design inputs, not a claim about today's renderer.

---

## 1. Reference games

Format: **identity** · *what makes it read* · **steal for Agent Command** · links.

### Strategy / RTS with strong fog or readability

- **Northgard** (Shiro Games) — Viking RTS on a map pre-cut into territory slices ([RPS review](https://www.rockpapershotgun.com/northgard-review-early-access)); players "vie for control of a fog covered island" ([TryRolling](https://tryrolling.com/northgard-early-access-review)).
  *Reads* because each territory is a discrete, bordered unit: you reveal and own whole regions, not cells. The painted/parchment look of its fog is commonly described but I found no primary dev source **[unverified]**.
  **Steal:** reveal/ownership at region granularity on top of the 48×48 cell sim; strong coloured territory borders.
- **Dune: Spice Wars** (Shiro Games) — Arrakis palette deliberately limited to "shades of brown, red, yellow and gray"; variety comes from terrain *form* (dunes, clifftops, plateaus, craters), "shimmering light… sharp shadows and contrasts" ([Level Infinite](https://www.levelinfinite.com/news/how-dune-spice-wars-art-evokes-beautiful-dangerous-arrakis)). Fog treatment not covered in any source I found **[unverified]**.
  **Steal:** a constrained per-plane palette is fine if silhouette/height and hard shadow carry variety — directly applicable to Surface plateaus/cliffs/craters.
- **Against the Storm** (Eremite Games) — city builder in a forest where the map is hidden in glades you open by cutting/exploring; "opening glades" is a core tutorial step ([official wiki: Tutorial](https://wiki.hoodedhorse.com/Against_the_Storm/Tutorial_Walkthrough), [Glades](https://wiki.hoodedhorse.com/Against_the_Storm/Glades)). The visual specifics (forest-fog veil over unopened glades, red "dangerous glade" marking) are from play memory **[unverified]**; the wiki pages 403 to scripted fetches.
  **Steal:** unexplored = *occluded by world matter* (trees/rock), not a black overlay — maps well to Depths (rock) and Sky (cloud banks).
- **StarCraft II** — two fog tiers: "Dark areas have not yet been explored, while the grayed-out areas have"; terrain and structures stay visible through grey, but "enemy troop movements and newly built structures" do not ([Blizzard guide](https://news.blizzard.com/en-us/article/4546768/game-guide-map-elements)).
  **Steal:** three tiers (never seen / remembered / visible) with *remembered* showing last-known static state.
- **League of Legends** — fog lives on a 128×128 grid; Riot hid jaggies by upscaling each source texel to a 4×4 block with 16 antialiased neighbour patterns (→512×512), then blurring with a separable Gaussian, because designers wanted "a smooth and visually pleasing transition limited to a narrow band"; they also found the old fog darkened visible areas (multiplier ~0.9 → 1.0) ([Riot: A Story of Fog and War](https://technology.riotgames.com/news/story-fog-and-war)).
  **Steal:** our 48×48 texture can get the same narrow, smooth edge cheaply (see §2.10); make sure "visible" multiplies by exactly 1.0.
- **Civilization VI** — undiscovered and fogged territory is covered by a hand-drawn map art style ([IGN](https://in.ign.com/civilization-6/93881/civilization-6s-new-game-changer-features)); tiles are "blank (if you haven't been there) or visibly faded (if you have…)" and resource icons persist ([PCMag](https://uk.pcmag.com/games/84981/civilization-vi-for-pc)).
  **Steal:** fog as a *different rendering style* (sketch/blueprint) rather than darkness; keep remembered icons.
- **Into the Breach** (Subset) — design built on "Telegraphed Attacks: all enemy attacks shown, no hit/miss chance, completely deterministic"; UI must "show the target" and "the attack type" for each enemy, constrained to three attack types ([GDC 2019 postmortem slides](https://media.gdcvault.com/gdc2019/presentations/Into%20the%20Breach%20Postmortem%20Final.pdf)).
  **Steal:** every asteroid drop / chasm opening / storm path shows *where*, *what kind* and *when* with a tiny fixed vocabulary.
- **Planetary Annihilation** — "strategic icons that appear over units so you can control them even at extreme zooms" (setting *Show Unit Icons*) ([PA guide](https://planetaryannihilation.com/guides/controls-and-the-user-interface)).
  **Steal:** unfocused planes and zoomed-out views swap meshes for team-coloured icons.
- **DEFCON** (Introversion) — "1980s vector graphics computer-themed world map" evoking the "big boards" of *WarGames* / *Dr. Strangelove* ([Wikipedia](https://en.wikipedia.org/wiki/DEFCON_(video_game))).
  **Steal:** the hologram language for non-focused planes: glowing vector contours on dark, no shading.
- **Homeworld 2** — skyboxes are not textures: they are vertex-coloured, adaptively tessellated sphere meshes produced from a TGA by adding vertices where contrast changes ([Simon Schreibt](https://simonschreibt.de/gat/homeworld-2-backgrounds); viewer: [hw2view](https://github.com/laanwj/hw2view)). Homeworld 1 likely similar **[unverified]**. Homeworld 3 keeps a moddable *Sensor Manager* strategic view ([mod.io guide](https://mod.io/g/homeworld3/r/modding-sensor-manager-level)); how it renders is **[unverified]**.
  **Steal:** Orbit/Sky backdrop as a vertex-coloured icosphere (zero texture memory, no banding, trivially recoloured per match/time-of-day); a sensors-style tactical view for unfocused planes.
- **Tooth and Tail** (Pocketwatch) — pixel-art RTS; art director posts "Nothing New Under the Sunray Shader" and "Pixel Ark: The Look of the Animals" ([blog](https://blog.pocketwatchgames.com/post/129160388256/nothing-new-under-the-sunray-shader-the), [blog](https://blog.pocketwatchgames.com/post/134808733616/pixel-ark-the-look-of-the-animals-in-tooth-and)) — content returns HTTP 403 to scripts **[unverified]**.
  **Steal:** unit silhouettes designed for distance first.
- **Songs of Conquest** (Lavapotion) — pixel-art billboards in 3D; terrain splat weights stored in mesh vertex colours + texture arrays of tiny 128×128 textures (~16 per faction); a real-time *top-down projected lightmap* rendered by a separate camera from "lighting sprites", carrying cloud shadows and coloured lights; day/night is "mostly the color grading" ([80.lv](https://80.lv/articles/mixing-2d-billboards-and-3d-environments-in-a-game)).
  **Steal:** one top-down light/shadow texture per plane (render cheap sprites into it) — perfect for Orbit's rotating sun wedges lighting the Surface and Sky storms shading it.
- **Highfleet** — strategy built on a dense diegetic analogue interface: "a small museum where you are allowed to touch and twist everything" ([Game Developer](https://www.gamedeveloper.com/design/designing-i-highfleet-i-a-strategy-game-with-heavy-machinery-and-twirling-knobs)).
  **Steal:** HUD for plane selection/telegraph timers as instrument dials rather than flat web panels (optional).

### Builders / dioramas (terrain that doesn't look like a grid)

- **Bad North** (Plausible Concept / Oskar Stålberg) — "minimalistic real-time tactics" on small islands ([Nintendo UK](https://www.nintendo.com/en-gb/News/2018/April/Interview-Taking-on-hordes-of-invading-Vikings-in-Bad-North-1368315.html)). Islands are assembled by Wave Function Collapse from 300+ Maya-authored tiles, placed marching-cubes-style ([Game Developer](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making)). Talk: *Developing The Bad North Look*, Konsoll 2018 ([listing](https://konsoll.org/talks/developing-the-bad-north-look)).
  **Steal:** author modules for *corner configurations* of the logical grid; the grid then never shows as boxes.
- **Townscaper** — irregular relaxed quad grid; modules chosen by corner occupancy (marching cubes) plus WFC decoration; Stålberg: "what's important is what happens when things change… at the corner of a house" ([Game Developer](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making); talks: [SGC21 *Beyond Townscapers*](https://www.youtube.com/watch?v=Uxeo9c-PX-w), [Konsoll 2021 *The Story of Townscaper*](https://confpad.io/conferences/konsoll-2021/the-story-of-townscaper)).
  **Steal:** spend art budget on transitions (ground→cliff, rock→tunnel, island edge), not on flat interiors.
- **Dorfromantik** (Toukana) — style sheet fixed early (shapes, proportions, lighting, colours, perspective); no traditional texturing: faces get up to five vertex-colour mask channels + greyscale albedo, mapped in-engine to hand-picked biome colour sets so "each building can automatically adapt its appearance depending on the biome"; assets are judged "from the slight top-down perspective" of play ([80.lv 2026](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)).
  **Steal:** exactly our per-plane identity problem: one mesh set, palette swapped per plane / team / fog tier.
- **Tiny Glade** (Pounce Light) — GPC 2024 talk *Rendering Tiny Glades With Entirely Too Much Ray Marching*: real-time GI, tilt-shift DoF, stable shadows under continuous time of day, GPU-driven rendering, "10 year old hardware" ([GPC archive](https://graphicsprogrammingconference.com/archive/2024)); diffuse GI is software ray tracing against lower-complexity proxy geometry, Vulkan + compute ([Digital Foundry](https://www.digitalfoundry.net/articles/digitalfoundry-2024-tiny-glade-proves-the-power-of-bespoke-game-engines-and-graphics-tech)).
  **Steal:** tilt-shift DoF sells "miniature diorama" at RTS zoom; GI itself is out of budget for us.
- **Islanders** (GrizzlyGames) — three people, four months, strategic minimalism ([Game World Observer](https://gameworldobserver.com/2019/06/14/islanders)). Flat-coloured low-poly islands **[unverified from primary]**.
- **Frostpunk** (11 bit) — "Royal and steel shades of blue dominate… all colors are cold and bleached"; mornings made "a bit different and uplifting" ([Xbox Wire, 11 bit artist](https://news.xbox.com/en-us/2021/07/21/how-the-visual-identity-of-frostpunk-changed)).
  **Steal:** keep the world desaturated so the few saturated hues (team blue/red, threat amber) own attention.
- **Kingdom Two Crowns** — "1:1" design: everything is in the world, e.g. income as physical coins in a pouch that spill into water when full ([Game Developer](https://www.gamedeveloper.com/design/-i-kingdom-two-crowns-i-and-the-practical-intersection-of-pixel-art-and-roguelike-design)).
  **Steal:** diegetic state (ore carts, glowing solar arrays) reduces HUD reliance.
- **Mini Metro / Mini Motorways** — abstract transit-map visual style from a jam prototype ([postmortem](https://www.gamedeveloper.com/audio/postmortem-dinosaur-polo-club-s-i-mini-metro-i-)).
  **Steal:** the Orbit plane could be almost purely diagrammatic (orbits as lines, rings, dots).

### Adventure / NPR references (plane moods)

- **Zelda: Tears of the Kingdom** — Depths: you are "working in darkness until you turn the nearest [Lightroot] on"; Lightroots "reveal the map around them, and literally illuminate the area" ([GamesRadar](https://www.gamesradar.com/zelda-tears-of-the-kingdom-depths/), [IGN](https://www.ign.com/wikis/the-legend-of-zelda-tears-of-the-kingdom/The_Depths_Guide_and_Overview)). Sky: designed around seamless surface→sky travel and the new "dive" action ([Nintendo, Ask the Developer Vol. 9 pt 3](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-9-the-legend-of-zelda-tears-of-the-kingdom-part-3)). Look specifics (cloud-sea floor, high-key palette) **[unverified]**.
  **Steal:** Depths fog = literal darkness lifted by placed light sources; the camera dive is the plane transition.
- **Outer Wilds** — redesigned style: "sharp, stylized shapes" to "clearly define walkable surfaces" and "simplified textures with large-scale gradients… a sense of depth… on foot and from afar" ([Mobius: Our New Style](https://www.mobiusdigitalgames.com/news/our-new-style)); planet-by-planet breakdown video ([80.lv](https://80.lv/articles/dissecting-the-art-style-of-outer-wilds)); atmosphere shader post ([Mobius](https://www.mobiusdigitalgames.com/news/the-atmosphere-awakens)).
  **Steal:** large gradients (height, distance-to-edge) instead of per-tile noise.
- **Sable** (Shedworks, GDC 2022) — flat shading is hard to read in depth, so they layered lighting + shadows ("we needed players to be casting shadows as often as possible"), then "distant fog" — "it definitely had the biggest impact overall" — then outlines with "fading opacity" with distance ([Game Developer](https://www.gamedeveloper.com/marketing/how-shedworks-refined-the-art-of-sable-in-pursuit-of-readability), [Cook & Becker](https://www.cookandbecker.com/en/article/170/sable-exploration-through-line-art.html)).
  **Steal:** that exact layer order; distance-faded lines; per-plane fog colour.
- **Return of the Obra Dinn** — renders 8-bit greyscale then converts to 1-bit in post; 8×8 Bayer for smooth shades, 128×128 blue noise elsewhere; to stop the pattern swimming with camera motion, the dither pattern is mapped onto a sphere around the camera (world-space) instead of the screen; "screenspace mapping with offset works best at 1x and the sphere mapping works best at 2x" ([Lucas Pope devlog](https://dukope.com/devlogs/obra-dinn/tig-32)).
- **Team Fortress 2** — the canonical red-vs-blue NPR shooter: Half-Lambert (×0.5+0.5, squared), an artist-painted 1D "diffuse warping" ramp, an "ambient cube" directional ambient, dedicated Fresnel rim light; "shadows go to cool, not black", "saturation increases at the terminator" ([NPAR 2007 paper](https://cdn.cloudflare.steamstatic.com/apps/valve/2007/NPAR07_IllustrativeRenderingInTeamFortress2.pdf)).
- **Guilty Gear Xrd** — cel-shaded 3D made to read as 2D by "kill everything 3D", limited animation, per-character lighting ([Polygon](https://www.polygon.com/2015/5/26/8663003/guilty-gear-xrd-cel-shading-making-of/); [GDC Vault talk](https://www.gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The)). Hand-edited normals for clean shadow shapes are widely cited from the talk **[unverified — handout PDF unreachable]**.
- **Teardown** — each object is a 3D volume texture, one byte per voxel indexing a 256-entry colour+material palette; transparency uses a 50% screen-door ([Acko.net frame teardown](https://acko.net/blog/teardown-frame-teardown)).
  **Steal:** Depths voxels as palette indices → palette swap per fog tier/team is free.
- **Deep Rock Galactic** — flares thrown "into the inky blackness" light "faceted low-poly walls" ([RPS](https://www.rockpapershotgun.com/how-deep-rock-galactic-mines-fun-from-absolute-darkess)).
  **Steal:** faceted low-poly rock + point lights is a proven cave read; flat-shaded facets love toon ramps.

---

## 2. Techniques

Cost notation: per-pixel taps / extra passes; full-screen pass bandwidth at 1080p (2.07 MP) and 1440p (3.69 MP).
One RGBA16F read+write ≈ 16 B/px → ≈33 MB/pass at 1080p, ≈59 MB at 1440p; ×60 fps ≈ 2.0 / 3.5 GB/s per pass
**[estimate]** — material on integrated GPUs, trivial on discrete. three.js defaults MRT attachments to RGBA16
half-float and recommends switching data attachments to `UnsignedByteType` to halve bandwidth
([three.js manual: Post-Processing with WebGPURenderer](https://threejs.org/manual/pages/webgpu-postprocessing.html)).

| Full-screen work **[estimate]** | 1080p (2.07 MP) | 1440p (3.69 MP) |
|---|---|---|
| 1 pass, RGBA16F read + write (16 B/px) | 33 MB → 2.0 GB/s @60 | 59 MB → 3.5 GB/s @60 |
| + RGBA8 normal/ID MRT attachment (write + read, 8 B/px) | +17 MB | +30 MB |
| 3×3 depth+normal edge kernel (~18 taps) | ~37 M taps | ~66 M taps |
| Kuwahara r=4, 4 sectors (~80 taps) | ~166 M taps | ~295 M taps |
| `bloom()` (`BloomNode`: high-pass + 5 mips from `_resolutionScale = 0.5`, separable kernels 6/10/14/18/22) | mip area ≈ ⅓ of full res, ×2 directions, wide kernels → roughly 1–2 full-res passes | same ratio |

Rule of thumb **[inference]**: on integrated GPUs (tens of GB/s shared with CPU) every extra full-res pass is a few % of
the frame budget; merge per-pixel work into as few passes as possible (the three.js pipeline "combines effects if
possible", per the manual) and run expensive effects at `setResolutionScale(0.5)`.

### 2.1 Toon / cel lighting

- **How:** quantise the light term. Classic: 1D ramp lookup indexed by N·L (Lake et al., used by TF2's "diffuse warping function"); Half-Lambert `(N·L·0.5+0.5)²` keeps shape on the dark side; ambient via hemisphere/"ambient cube"; rim = Fresnel `(1−N·V)^k` masked so it only appears on lit sides ([TF2 paper](https://cdn.cloudflare.steamstatic.com/apps/valve/2007/NPAR07_IllustrativeRenderingInTeamFortress2.pdf); [Roystan toon tutorial](https://roystan.net/articles/toon-shader) — BotW-style two bands + rim + specular, `smoothstep` to soften the terminator; [Panthavma: Toon Shading Fundamentals](https://panthavma.com/articles/shading/toonshading)). Gooch-style warm→cool hue shift instead of darkening reads better than black shadows (TF2 paper).
- **Cost:** ≤ Lambert; cheaper than `MeshStandardNodeMaterial` (no GGX/IBL).
- **Gotchas:** two-tone shading exposes terminator wobble from triangle interpolation (Panthavma); flat-shaded boxes give one band per face — need bevels/averaged normals to get a visible terminator; shadow-map acne becomes very visible against hard bands.
- **Three r187:** `MeshToonNodeMaterial` (`src/materials/nodes/MeshToonNodeMaterial.js`) → `ToonLightingModel` (`src/nodes/functions/ToonLightingModel.js`):
  - direct light only: `coord = vec2(dotNL*0.5+0.5, 0)`; with `gradientMap` it returns `gradientMap.r` (red channel only — colour ramps need a custom model); without one, a hard 0.7→1.0 step antialiased with `fwidth`.
  - indirect diffuse (ambient/hemisphere/probes) is added **unquantised** and multiplied by AO.
  - r187 adds `emissiveNode` to toon materials ([r187 notes](https://github.com/mrdoob/three.js/releases/tag/r187)).
  - example: [webgpu_materials_toon](https://threejs.org/examples/webgpu_materials_toon.html) (uses a `DataTexture` gradientMap + `toonOutlinePass`).
  - For colour ramps / per-plane palettes write the shading in TSL on `MeshBasicNodeMaterial.colorNode` with a uniform sun direction: `Fn(() => { const ndl = normalWorld.dot(sunDir).mul(0.5).add(0.5); return texture(rampTex, vec2(ndl, planeRow)).rgb; })` — no light loop at all, ideal for 10k+ instanced tiles **[inference]**. Use `NearestFilter` ramps for hard bands, `LinearFilter` for soft terminators.

### 2.2 Outlines: inverted hull vs screen-space edges

- **Inverted hull:** second draw of the mesh, extruded along normals, front-face culled; reproduces occlusion contours cheaply; breaks at hard edges/split normals ([Panthavma: Line Rendering Deep Overview](https://panthavma.com/articles/lines/deep-overview-extraction)).
  - **Three r187:** `toonOutlinePass(scene, camera, color=black, thickness=0.003, alpha=1)` from `three/tsl` (`src/nodes/display/ToonOutlinePassNode.js`, [docs](https://threejs.org/docs/pages/ToonOutlinePassNode.html)). Only objects with `MeshToonMaterial`/`MeshToonNodeMaterial` get a hull; hull = `BackSide` `NodeMaterial`, offset ∝ `thickness * clip.w` (≈ constant screen width); per-vertex thickness is a `TODO` in source. Honors the original `positionNode`. `NodeMaterial.setup()` runs `setupPosition` (instancing/batching) before `vertexNode`, so InstancedMesh hulls should follow instances **[inference from source]**. Cost: doubles vertex work + draw calls for toon objects; on unit-cube voxels the hull splits at corners (normals aren't averaged).
- **Screen-space edges:** render depth + view normals (MRT), run a 3×3 Sobel/Roberts/Laplacian on both; depth finds silhouettes, normals find creases ([Maxime Heckel: Moebius-style post-processing](https://blog.maximeheckel.com/posts/moebius-style-post-processing), [Omar Shehata: webgl-outlines](https://github.com/OmarShehata/webgl-outlines)). Add an **object/surface-ID** channel to catch coplanar boundaries between different objects (Shehata's "surface IDs"). Scharr kernels handle diagonals better (Panthavma).
  - **Three r187:**
    ```js
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
    scenePass.getTexture('normal').type = UnsignedByteType;     // halve bandwidth
    const n = scenePass.getTextureNode('normal'), d = scenePass.getLinearDepthNode();
    // custom Fn: sample n/d at ±texel (screenSize), edge = max(depthDiff*k1, normalDiff*k2)
    ```
    `packNormalToRGB`/`unpackRGBToNormal` replaced `directionToColor`/`colorToDirection` in r185 (`src/nodes/utils/Packing.js` deprecation warnings).
  - `sobel(node)` (`examples/jsm/tsl/display/SobelOperatorNode.js`) runs on **luminance of a colour texture** and is meant "after tone mapping" — fine for colour edges, *not* a depth+normal detector.
  - `pixelationPass(scene, camera, pixelSize=6, normalEdgeStrength=0.3, depthEdgeStrength=0.4)` (`PixelationPassNode.js`) already contains depth- and normal-edge indicator code — crib it; but it renders at reduced resolution by design ([example](https://threejs.org/examples/webgpu_postprocessing_pixel.html)).
  - `outline(scene, camera, { selectedObjects, edgeThickness, edgeGlow })` (`OutlineNode.js`) is a **selection highlight** (mask of `selectedObjects`), not world linework ([example](https://threejs.org/examples/webgpu_postprocessing_outline.html)).
- **Line width at distance:** screen-space lines are constant-pixel-width, so far terrain gets as heavy as near units; scale thresholds with linear depth and fade opacity with distance (Sable). Very wide/soft outlines (selection, threat halos): Jump Flood distance field ([Ben Golus: The Quest for Very Wide Outlines](https://bgolus.medium.com/the-quest-for-very-wide-outlines-ba82ed442cd9), [gist](https://gist.github.com/bgolus/a18c1a3fc9af2d73cc19169a809eb195)) — log₂(width) ping-pong passes.
- **Moebius/hand-drawn:** jitter edge-sample UVs by `hash(fragCoord)·sin(fragCoord·freq)` for wobble; crosshatch shadows by luminance bands (Heckel, above; [Jan Kaluza UE Moebius shading](https://jan.games/personal-work/moebius-style-shading)).
- **Cost:** depth+normal Sobel ≈ 16–18 taps/px, one full-screen pass + one extra RGBA8 attachment (~8 MB at 1080p) **[estimate]**. Inverted hull: 2× vertex cost on outlined meshes, zero full-screen cost.

### 2.3 Hatching and painterly

- **Tonal Art Maps (object space):** pre-built mip-consistent stroke textures per tone level, blended per pixel → strokes stick to surfaces ([Praun et al., *Real-Time Hatching*, SIGGRAPH 2001](https://gfx.cs.princeton.edu/proj/hatching/)). Needs UVs/triplanar; texture-array lookups (6 tones ≈ 2 RGB texels).
- **Screen-space hatching:** threshold a tiled stroke pattern in screen UV by luminance; trivial cost but "shower-door" swimming when the camera pans (same problem Obra Dinn solved by world-anchoring, §2.5) **[inference]**.
- **Kuwahara:** per pixel, split a window into sectors, output the mean of the lowest-variance sector; anisotropic / 8-sector circular kernels look more painterly; Heckel targets ~60 fps but it is a wide-kernel filter ([Maxime Heckel: On Crafting Painterly Shaders](https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders); [Blender Kuwahara node](https://docs.blender.org/manual/en/4.0/compositing/types/filter/kuwahara.html)). Cost: radius 4, 4 sectors ≈ 80 taps/px **[estimate]** — too costly as a default full-screen pass on iGPUs; acceptable on a downsampled fog/hologram layer.
- **Three r187:** none built in. Write a TSL `Fn` over `scenePass.getTextureNode()`; use `convertToTexture()` to sample arbitrary nodes as textures.

### 2.4 Posterisation and gradient-mapped palettes

- **How:** compute luminance, then look up a 1D/2D palette ramp (gradient map) — one ramp row per plane (and per fog tier). Or quantise channels (`posterize`). Dorfromantik does the authoring-side equivalent with vertex-colour masks → biome palettes ([80.lv](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)).
- **Three r187:** `posterize(source, steps)` (`src/nodes/display/ColorAdjustment.js`); `luminance`, `saturation`, `hue`, `vibrance`, `grayscale` in `three/tsl`; `lut3D(node, lut, size, intensity)` (`examples/jsm/tsl/display/Lut3DNode.js`, [example](https://threejs.org/examples/webgpu_postprocessing_3dlut.html)) for whole-frame grading. Vertex colour: `vertexColor()`; per-instance colour via `InstancedMesh.setColorAt`.
- **Gotchas:** posterising *after* bloom/tonemapping bands the glow; posterise the lit albedo in-material instead. Team colours must bypass the palette (write them into a separate emissive/ID channel) **[inference]**.

### 2.5 Dithering

- **How:** compare value to a threshold matrix (Bayer 4×4/8×8 = ordered, visible crosshatch) or blue-noise texture (no structure); ([Surma: Ditherpunk](https://surma.dev/things/ditherpunk/); [Heckel: The Art of Dithering and Retro Shading](https://blog.maximeheckel.com/posts/the-art-of-dithering-and-retro-shading-web/)). **Stability:** screen-space patterns crawl over moving geometry; Obra Dinn anchors the pattern to a camera-centred sphere so it stays put during rotation ([dukope tig-32](https://dukope.com/devlogs/obra-dinn/tig-32)).
- **Uses here:** (a) hologram planes via dithered alpha → stays opaque-pass, **no transparency sorting**; (b) fog-edge dissolve; (c) raymarch step-offset to hide banding.
- **Three r187:** `bayer16(uv)` and `bayerDither(color, steps)` in `three/addons/tsl/math/Bayer.js` (doc: also "an alternative to blue-noise" for `VolumeNodeMaterial.offsetNode`); `interleavedGradientNoise(position)` (`src/nodes/utils/PostProcessingUtils.js`); `material.alphaHash = true` (stochastic alpha, `NodeMaterial.js`); `maskNode` + `discard`. Example of camera-occlusion dither with toon + `bayer16`: [webgpu_tsl_occlusion_dither](https://threejs.org/examples/webgpu_tsl_occlusion_dither.html); halftone: [webgpu_tsl_halftone](https://threejs.org/examples/webgpu_tsl_halftone.html). `dotScreen(node, angle, scale)` exists for a screen halftone.

### 2.6 Triplanar + noise break-up (macro variation, anti-tiling)

- **How:** project textures along X/Y/Z weighted by normal — no UVs, good for voxels/cliffs; fix normals with whiteout/RNM blends ([Ben Golus: Normal Mapping for a Triplanar Shader](https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a)). Anti-tiling: random per-tile offsets blended via a low-frequency index ([Inigo Quilez: Texture Repetition](https://iquilezles.org/articles/texturerepetition/)). Macro variation: multiply by 1–2 octaves of low-frequency world noise; Outer Wilds' "large-scale gradients" is the same idea ([Mobius](https://www.mobiusdigitalgames.com/news/our-new-style)).
- **Cost:** triplanar = 3 taps per texture; procedural `mx_noise_float` is ALU-only (cheap per octave); `mx_worley_noise_float` ≈ 9–27 cell evaluations **[estimate]**.
- **Three r187:** `triplanarTexture(texX, texY?, texZ?, scale, position=positionLocal, normal=normalLocal)` / `triplanarTextures` (`src/nodes/utils/TriplanarTextures.js`, based on keijiro/StandardTriplanar); MaterialX noise `mx_noise_float/vec3/vec4`, `mx_fractal_noise_float/vec3`, `mx_worley_noise_float/vec2/vec3`, `mx_cell_noise_float`; addons `voronoi2d/voronoi3d` (`examples/jsm/tsl/math/voronoiNoise.js`), `curlNoise`, `snoise` (`curlNoise.js`); [webgpu_materialx_noise](https://threejs.org/examples/webgpu_materialx_noise.html), [webgpu_tsl_procedural_terrain](https://threejs.org/examples/webgpu_tsl_procedural_terrain.html). Pass `positionWorld` for world-stable noise across instances.

### 2.7 Terrain without hard grid tiles

- **Dual grid (Stålberg):** draw visual tiles offset half a cell; each visual tile's 4 corners sample 4 logical cells → marching-squares case selection. With 2 terrains: 16 cases (6 unique up to rotation) vs the 47-tile "blob" set ([Boris the Brave: Quarter-Tile Autotiling](https://www.boristhebrave.com/2023/05/31/quarter-tile-autotiling/); [jess::codes: *Draw fewer tiles — by using a Dual-Grid system!*](https://www.youtube.com/watch?v=jEWFSv3ivTg); [TileMapDual (Godot) — "from 47 to just 15"](https://github.com/pablogila/TileMapDual)).
- **Blob / Wang 47:** 8-neighbour bitmask, corners only count if both adjacent edges are set → 47 tiles ([cr31 Blob tileset mirror](http://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/blob.html); [OpenGameArt template](https://opengameart.org/content/wang-%E2%80%98blob%E2%80%99-tileset)). More authoring than dual grid for the same result.
- **Marching squares contours:** contour a scalar field (height/biome weight) per cell with linear interpolation → smooth coastlines/cliff lips; ([Jamie Wong: Metaballs and Marching Squares](https://jamie-wong.com/2014/08/19/metaballs-and-marching-squares/)). Bad North/Townscaper use the 3D analogue for module placement ([Game Developer](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making)).
- **SDF heightfield smoothing:** treat cell heights as an SDF / blurred heightmap and evaluate in the vertex shader on a denser mesh; smooth-min blends plateaus into slopes ([Inigo Quilez: smooth minimum](https://iquilezles.org/articles/smin/)). Cliffs: blur a binary "cliff" mask and threshold with `smoothstep` so edges are rounded but still crisp.
- **Beveled / rounded voxels:** `RoundedBoxGeometry` (`examples/jsm/geometries/RoundedBoxGeometry.js`) gives toon ramps a terminator and inverted hulls continuous normals; cost = more vertices per instance (segments=2 ⇒ hundreds of verts **[estimate]**) — fine with `InstancedMesh`.
- **Grid readability without grid lines:** draw the grid only where needed (placement mode, under selection, near telegraphs) via decals or a world-space `fract(positionWorld.xz)` line mask modulated by distance to cursor **[inference]**. `DecalGeometry` (`examples/jsm/geometries/DecalGeometry.js`) for projected marks on uneven terrain.
- **Three r187:** per-cell data in a `DataTexture`/`storage` buffer sampled by `positionWorld`; `vertexIndex`, `instanceIndex` for procedural placement; `BatchedMesh` for many unique module meshes in one draw (`perObjectFrustumCulled`, `sortObjects`; [webgpu_mesh_batch](https://threejs.org/examples/webgpu_mesh_batch.html)).

### 2.8 Stylised water, clouds, god rays

- **Water:** depth difference between water surface and scene depth → shallow/deep colour ramp + shoreline foam band; scrolling noise + distortion for toon wave crests ([Roystan: Toon Water](https://roystan.net/articles/toon-water)). Three r187: `viewportDepthTexture()`, `viewportLinearDepth`, `linearDepth`, `screenUV`, `viewportTexture()` for refraction ([webgpu_backdrop_water](https://threejs.org/examples/webgpu_backdrop_water.html)); `softParticles({ distance, contrast })` (`examples/jsm/tsl/utils/SoftParticles.js`) is the same depth-fade for cloud puffs/fog cards. Applies to fords and magma (magma = emissive water with inverted ramp) **[inference]**.
- **Clouds — billboard puffs/impostors:** camera-facing quads with soft depth fade; `billboarding()` and `SpriteNodeMaterial` in r187; cheap, sortable issues (see §2.11). Toon-shaded sphere clusters: icospheres per island with a 2–3 band ramp and noise-displaced vertices — opaque, no sorting, reads Ghibli-esque **[inference]**.
- **Clouds — raymarched volumes:** Horizon's Nubis (low-res raymarch, temporal reprojection) ([Schneider, SIGGRAPH 2015](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf)); web implementation with blue-noise step offset, "calculate at half-res & dither… upscale and then apply light blur" ([Heckel: Real-time dreamy Cloudscapes](https://blog.maximeheckel.com/posts/real-time-cloudscapes-with-volumetric-raymarching)). Three r187: `VolumeNodeMaterial` + `RaymarchingBox(steps, cb)` (`examples/jsm/tsl/utils/Raymarching.js`) with `bayer16` offset, [webgpu_volume_cloud](https://threejs.org/examples/webgpu_volume_cloud.html), [webgpu_volume_perlin](https://threejs.org/examples/webgpu_volume_perlin.html). Cost: N steps × noise per pixel covered — at 32 steps × fBM over a large screen area this dominates the frame; restrict to small bounded boxes (storms, fog banks) at reduced resolution **[estimate]**.
- **God rays:** radial-blur of an occlusion mask toward the light's screen position ([GPU Gems 3 ch.13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process)). Three r187: `godrays(depthNode, camera, light)` is *screen-space raymarched against the shadow map* (needs full shadow setup; point/directional only), recommended with `bilateralBlur` + `depthAwareBlend` (`GodraysNode.js` header; [example](https://threejs.org/examples/webgpu_postprocessing_godrays.html)); `radialBlur` (`radialBlur.js`) is the cheap GPU-Gems variant. For Orbit's sun wedges, stylised geometric light shafts (additive cones/quads) are cheaper and more on-style **[inference]**.

### 2.9 Height fog / plane separation

- Per-plane distance/height fog sells layering (Sable: fog "had the biggest impact overall"). Three r187: `fog(color, factor)` with `rangeFogFactor(near, far)`, `densityFogFactor(d)`, `exponentialHeightFogFactor(density, height)` (`src/nodes/fog/Fog.js`); [webgpu_fog_height](https://threejs.org/examples/webgpu_fog_height.html), [webgpu_custom_fog](https://threejs.org/examples/webgpu_custom_fog.html). Fog is per-scene (`scene.fogNode`); per-plane fog colour is easier as a material-level `mix()` on `positionWorld.y` **[inference]**.

### 2.10 Fog of war that stays readable

Patterns observed:

| Tier | SC2 | Civ VI | LoL | Proposal-ready treatment |
|---|---|---|---|---|
| Never seen | dark | blank / hand-drawn map | — | plane-specific "material" veil (rock for Depths, cloud sea for Sky, starless void/blueprint for Orbit, parchment/sketch for Surface) |
| Seen, not visible | greyed, terrain & structures shown | faded, icons kept | fogged | desaturate + darken + cool hue shift, keep last-known structure icons, hide units |
| Visible | full | full | full (×1.0!) | full colour |

Sources: [SC2](https://news.blizzard.com/en-us/article/4546768/game-guide-map-elements), [Civ VI PCMag](https://uk.pcmag.com/games/84981/civilization-vi-for-pc), [Civ VI IGN](https://in.ign.com/civilization-6/93881/civilization-6s-new-game-changer-features), [Riot](https://technology.riotgames.com/news/story-fog-and-war); RTS fog background: [jdxdev RTS Fog of War](https://www.jdxdev.com/blog/2022/06/08/rts-fog-of-war/), [Gemserk (Iron Marines) pt 1](https://blog.gemserk.com/2018/08/27/implementing-fog-of-war-for-rts-games-in-unity-1-2), [pt 2](https://blog.gemserk.com/2018/11/20/implementing-fog-of-war-for-rts-games-in-unity-2-2).

- **Edges:** LoL wanted narrow-but-smooth transitions from coarse data (§1). Cheap equivalent for 48×48: keep `LinearFilter`, then in TSL `smoothstep(0.35, 0.65, vis)` to sharpen the bilinear ramp into a ~0.3-cell band; add `mx_noise_float(positionWorld.xz * k + time)` to the threshold for an animated, organic edge **[inference]**. Thresholded bilinear on a 48² texture leaves diamond/stair artefacts along diagonals **[inference]**; LoL's 4× pattern-upscale, or a one-time fragment/CPU blur into 192², removes them.
- **Tiers in one texture:** RG8 `DataTexture` (R = visible now, eased; G = explored, monotonic) — one fetch serves both **[inference]**. Current code is `RedFormat` only.
- **Depths:** TotK-style literal darkness — unexplored rock gets no light; explored tunnels keep a dim ambient; visible gets team light radius ([GamesRadar](https://www.gamesradar.com/zelda-tears-of-the-kingdom-depths/)).
- **Never hide threats:** telegraphs for known incoming events should draw over fog (Into the Breach's "all attacks shown" principle; [GDC 2019](https://media.gdcvault.com/gdc2019/presentations/Into%20the%20Breach%20Postmortem%20Final.pdf)).
- **Sketch (TSL, r187 names)** **[inference]**:
  ```js
  // fogTex: RG8 DataTexture, R = visible (eased), G = explored; uvMap from positionWorld.xz as in fog.ts
  const fogTiers = Fn(([lit]) => {
    const f = texture(fogTex, uvMap);
    const edge = mx_noise_float(vec3(positionWorld.xz.mul(0.6), time.mul(0.15))).mul(0.12);
    const vis = smoothstep(0.35, 0.65, f.r.add(edge));
    const seen = smoothstep(0.35, 0.65, f.g.add(edge));
    const remembered = mix(vec3(luminance(lit)), coolTint, 0.35).mul(0.55);   // desaturate, cool, darken
    return mix(neverSeenColor, mix(remembered, lit, vis), seen);                // never-seen veil per plane
  });
  ```

### 2.11 Telegraph language

- **Shapes:** ground decal ring/footprint at impact site + **fill-up timer** (radial sweep or inward-closing ring reaching the edge at impact) + vertical marker visible from other planes; one shape per *kind* (ITB: target + attack type, three types). Pulse frequency rising as time runs out **[inference]**.
- **Colour-blind safety:** don't encode solely by colour ([Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/ensure-no-essential-information-is-conveyed-by-a-fixed-colour-alone); [Xbox XAG 103: at least two of text, symbols, color…](https://devdocs.xbox.com/build/game-principles/accessibility/xag-deep-dives/xag-103-additional-cues)). Okabe–Ito palette (`#E69F00` orange, `#56B4E9` sky blue, `#009E73` green, `#F0E442` yellow, `#0072B2` blue, `#D55E00` vermillion, `#CC79A7` purple) is designed to stay distinguishable under common CVD ([Siegal lab table](https://siegal.bio.nyu.edu/color-palette); [R Journal 2023](https://journal.r-project.org/articles/RJ-2023-071)).
  - **Our colours, computed** (WCAG relative luminance; full-severity simulation with the [Machado et al. 2009](https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html) matrices) **[estimate, my calculation]**: blue `#3aa8ff` L=0.36, red `#ff4f5e` L=0.28, amber `#ffd23f` L=0.68. Contrast ratios: blue/red **1.26** (near-identical in greyscale), blue/amber 1.77, red/amber 2.23. Deuteranopia sim: blue→`#639afd`, red→`#ab9d59` (khaki), amber→`#f5dc48`; protanopia: red→`#7f785d`, amber→`#eacf24`. So blue-vs-red survives CVD via the blue–yellow axis, but **red-vs-amber collapses to "dark yellow vs light yellow"** — threat telegraphs must not rely on amber-vs-red-team hue; give threats a unique *pattern* (animated diagonal hatch, inward-closing ring) and keep them brighter than any team colour.
- **Three r187:** `InstancedMesh` + `MeshBasicNodeMaterial` with per-instance attributes (`instancedBufferAttribute`) for ring progress/time; additive blending (order-independent) for glows; `circle(scale, softness, uv)` helper (`examples/jsm/tsl/display/Shape.js`). The project already does this (`apps/web/src/world/telegraphs.ts`).

### 2.12 WebGPU vs WebGL2 fallback, and performance traps

- **Compute:** WebGL2 backend emulates compute with transform feedback (`WebGLBackend.js` binds `TRANSFORM_FEEDBACK_BUFFER`); GLSL builder declares `storageBuffer: false` and reads storage via PBO textures (`GLSLNodeBuilder.js` `supports`, `setupPBO`). `atomicAdd`, `workgroupArray`, `textureStore`/`storageTexture` are WebGPU-only in practice **[inference from source; verify per feature]**. → Any effect that must run on fallback (fog upscale, JFA) should be fragment-pass based, not compute.
- **MRT:** works on both; WebGL2 uses `drawBuffers` (`WebGLBackend.js`). Default attachment precision RGBA16F; use `UnsignedByteType` for normals/IDs ([manual](https://threejs.org/manual/pages/webgpu-postprocessing.html); [webgpu_mrt](https://threejs.org/examples/webgpu_mrt.html)).
- **Pipeline:** `RenderPipeline` (renamed from `PostProcessing` in r183; `PostProcessing` is a deprecated subclass that warns) ([r183 notes](https://github.com/mrdoob/three.js/releases/tag/r183); `src/renderers/common/PostProcessing.js`). `renderAsync()` deprecated r181 → `await renderer.init()` + `render()` ([r181 notes](https://github.com/mrdoob/three.js/releases/tag/r181)). `DirectRenderPipeline` applies output transform in material shaders, skipping the intermediate framebuffer — cheaper when there is *no* post chain, but incompatible with framebuffer-sampling materials and "with the WebGL backend, `antialias` has no effect" (`src/renderers/common/DirectRenderPipeline.js`). `PassNode.setResolutionScale()` for half-res effect passes; `PassNode.setLayers()` to render subsets (e.g. one plane) into a pass.
- **Built-in post costs (relative):** `bloom()` = 5-mip blur chain (`BloomNode._nMips = 5`); `ao()` (GTAO) has `resolutionScale`, `samples` uniforms — expensive at full res; `fxaa()`/`smaa()`/`traa()` available ([examples list](https://threejs.org/examples/?q=webgpu_postprocessing)).
- **Transparency:** sorted per object, not per triangle → overlapping hologram planes and cloud cards pop/self-intersect. Options: additive blending (order-independent), dithered/`alphaHash` opaque, or `oitPass(scene, camera)` — Weighted Blended OIT added to addons (`examples/jsm/tsl/display/OITPassNode.js`; [webgpu_oit](https://threejs.org/examples/webgpu_oit.html)) at the cost of two accumulation targets.
- **Instancing:** `InstancedMesh` = one draw per geometry+material; `BatchedMesh` = many geometries one material, per-object culling/sorting, uses `WEBGL_multi_draw` when available on fallback (`GLSLNodeBuilder.js` drawIndex note) ([docs](https://threejs.org/docs/pages/BatchedMesh.html)). 4 planes × 48² = 9,216 cells → trivially instanceable; cost is fill-rate/overdraw of stacked transparent planes, not draw calls **[estimate]**.

---

## 3. Three.js r187 feasibility table

Est. cost at 1440p on a mid iGPU **[estimate]**: Low < 0.5 ms, Med 0.5–2 ms, High > 2 ms. "Key API" verified in local r187 source.

| Technique | WebGPU | WebGL2 fallback | Est. cost | Key API (r187) |
|---|---|---|---|---|
| Toon ramp lighting (built-in) | ✅ | ✅ | Low | `MeshToonNodeMaterial` + `gradientMap` (`ToonLightingModel`) |
| Toon ramp, custom palette/plane | ✅ | ✅ | Low | `MeshBasicNodeMaterial.colorNode`, `Fn`, `normalWorld`, `texture()` |
| Rim / Fresnel | ✅ | ✅ | Low | `normalView`, `positionViewDirection`, `pow` |
| Inverted-hull outline | ✅ | ✅ | Low–Med (2× verts) | `toonOutlinePass(scene, camera, color, thickness, alpha)` from `three/tsl` |
| Depth+normal edge lines | ✅ | ✅ | Med | `pass()`, `mrt()`, `output`, `packNormalToRGB(normalView)`, `getLinearDepthNode()`, custom `Fn` |
| Object-ID edges | ✅ | ✅ | Med (+1 RGBA8) | `mrt({ id: … })` + custom `Fn` |
| Colour-luminance Sobel | ✅ | ✅ | Low–Med | `sobel()` (`SobelOperatorNode`) |
| Pixelation + edges | ✅ | ✅ | Med | `pixelationPass()` (`PixelationPassNode`) |
| Selection outline | ✅ | ✅ | Med (multi-pass) | `outline()` (`OutlineNode`, selection-only) |
| Wide outlines (JFA) | ✅ | ✅ (fragment ping-pong) | Med–High | custom passes / `RTTNode` (`rtt`) |
| Kuwahara / painterly | ✅ | ✅ | High | custom `Fn` over `getTextureNode()` |
| Tonal-art-map hatching | ✅ | ✅ | Low–Med | texture arrays + `triplanarTexture` |
| Posterise / palette ramp | ✅ | ✅ | Low | `posterize()`, `luminance()`, `lut3D()` |
| Ordered / blue-noise dither | ✅ | ✅ | Low | `bayer16`, `bayerDither` (`addons/tsl/math/Bayer.js`), `interleavedGradientNoise`, `alphaHash` |
| Halftone screen | ✅ | ✅ | Low | `dotScreen()` |
| Triplanar | ✅ | ✅ | Low–Med (3 taps/tex) | `triplanarTexture` / `triplanarTextures` |
| Procedural noise | ✅ | ✅ | Low–Med | `mx_noise_*`, `mx_fractal_noise_*`, `mx_worley_noise_*`, `voronoi2d` |
| Dual-grid / marching-squares terrain | ✅ (CPU or compute mesh gen) | ✅ (CPU gen) | Low at runtime | `BatchedMesh`, `InstancedMesh`, `BufferGeometry` |
| Rounded voxels | ✅ | ✅ | Low–Med (verts) | `RoundedBoxGeometry` + `InstancedMesh` |
| Projected decals | ✅ | ✅ | Low | `DecalGeometry`; or TSL `positionWorld.xz` mask |
| Toon water / foam | ✅ | ✅ | Low–Med | `viewportDepthTexture()`, `viewportLinearDepth`, `screenUV`, `viewportTexture()` |
| Soft particles / cloud puffs | ✅ | ✅ | Med (overdraw) | `softParticles()`, `billboarding()`, `SpriteNodeMaterial` |
| Raymarched clouds | ✅ | ✅ (slower) | High | `VolumeNodeMaterial`, `RaymarchingBox`, `bayer16` offset |
| Shadow-map god rays | ✅ | ✅ | Med–High | `godrays()`, `bilateralBlur()`, `depthAwareBlend()` |
| Radial-blur god rays | ✅ | ✅ | Low–Med | `radialBlur()` |
| Bloom | ✅ | ✅ | Med | `bloom(node, strength, radius, threshold)` |
| GTAO | ✅ | ✅ | High (Med at ½ res) | `ao(depth, normal, camera)` (`GTAONode`) |
| Height / range fog | ✅ | ✅ | Low | `fog()`, `exponentialHeightFogFactor()`, `rangeFogFactor()` |
| Fog-of-war sampling + tiers | ✅ | ✅ | Low | `DataTexture` (RG8), `texture()`, `smoothstep`, `positionWorld` |
| Fog upscale in compute | ✅ | ⚠️ emulated (transform feedback; no storage textures) | Low | `compute()`, `storage()`, `instancedArray()` — use a fragment `rtt` pass for parity |
| Order-independent transparency | ✅ | ✅ (needs float targets) **[unverified on WebGL]** | Med | `oitPass()` (`OITPassNode`) |
| Atomics / workgroup memory | ✅ | ❌ **[inference]** | — | `atomicAdd`, `workgroupArray` |
| MRT | ✅ | ✅ (`drawBuffers`) | +bandwidth/attachment | `pass().setMRT(mrt({...}))` |
| Post pipeline | ✅ | ✅ | — | `RenderPipeline` (not `PostProcessing`), `DirectRenderPipeline` |

---

## 4. Takeaways for Agent Command

1. **Commit to a cel/illustrative base, not PBR:** custom TSL ramp shading on `MeshBasicNodeMaterial` (sun direction uniform, Half-Lambert into a per-plane 2D ramp texture, Gooch warm→cool shadows, masked rim). It is cheaper than the current standard material, and the ramp row becomes the plane's identity (TF2, Roystan, Dorfromantik).
2. **One mesh set, many palettes:** author greyscale albedo + vertex-colour masks (Dorfromantik's ≤5 channels) or palette indices (Teardown); remap per plane, per team and per fog tier in shader. Team blue/red bypasses the palette via an emissive/ID channel so it always pops (Frostpunk's "everything cold so warmth reads").
3. **Kill the box grid on Surface with a dual-grid:** keep the 48×48 sim, render offset-by-half modules chosen by corner cases (16 per terrain pair) — cliffs/plateaus/fords/craters get authored transitions; show grid lines only in placement mode (Stålberg; Boris; jess::codes).
4. **Lines = depth + normal + ID edges in one post pass,** thickness/opacity fading with linear depth (Sable). Don't use `sobel()` (luminance) or `outline()` (selection) for world linework; crib `PixelationPassNode`'s edge indicators. Keep `toonOutlinePass` as a cheap per-unit silhouette option for toon-material units.
5. **Layer order from Sable:** flat colour → light + cast shadows → per-plane distance/height fog → lines. Fog is the biggest readability win per ms.
6. **Fog of war as three tiers per plane** (RG8 texture: visible / explored): never-seen = plane-native veil (rock, cloud sea, void/blueprint, parchment-sketch); remembered = desaturated, cooled, last-known structures; visible = ×1.0 (LoL bug). Sharpen bilinear edges with `smoothstep` + animated noise threshold; optionally LoL-style 4× upscale.
7. **Depths = TotK darkness:** unexplored rock unlit, tunnels/rails/magma and team light sources reveal; faceted low-poly rock under point lights (DRG) instead of glossy boxes.
8. **Unfocused planes as DEFCON/Homeworld holograms rendered without transparency sorting:** dithered (`bayer16`/`alphaHash`) or additive vector contours + team icons (Planetary Annihilation strategic icons); reserve `oitPass` for if dithering looks too noisy.
9. **Orbit/Sky backdrop as a vertex-coloured icosphere** (Homeworld 2) and Orbit sun wedges as a Songs-of-Conquest-style top-down light texture that the Surface/Sky materials sample — the sun literally paints lit sectors.
10. **Telegraphs speak one language across planes:** ring decal + fill-up sweep + vertical beam visible from other planes, amber + hatched animated stripes (never colour alone), drawn above fog; one silhouette per threat type (Into the Breach).
11. **Clouds/storms as opaque toon sphere clusters or soft billboards**, not full-screen raymarching; if volumetrics are wanted, bound them to small boxes at half resolution with Bayer offsets.
12. **Stay fallback-safe:** every look-defining effect must be fragment/MRT based (works on WebGL2); compute only for optional extras. Budget ≤3 full-screen passes at 1440p (scene MRT, lines+fog composite, bloom) **[estimate]**.

---

## API surprises found in local r187 source

- `PostProcessing` → **`RenderPipeline`** (r183); old name is a deprecated subclass with `warnOnce` (`src/renderers/common/PostProcessing.js`). Internal `RenderPipeline` was renamed `RenderObjectPipeline` in the same release ([r183 notes](https://github.com/mrdoob/three.js/releases/tag/r183)).
- `directionToColor` / `colorToDirection` → **`packNormalToRGB` / `unpackRGBToNormal`** (r185).
- **`toonOutlinePass`** is a *core* TSL export (`src/nodes/display/ToonOutlinePassNode.js`), not an addon; only affects toon materials.
- `sobel()` is luminance-based on a colour input, not depth/normal.
- `ToonLightingModel` only steps **direct** light and reads only `gradientMap.r`.
- New since older tutorials: `DirectRenderPipeline`, `OITPassNode` (`oitPass`), `bayer16`/`bayerDither`, `softParticles`, `RaymarchingBox`, `godrays` (shadow-map raymarched), `PassNode.setLayers()`.
- No `transformedNormalView` export exists any more; use `normalView`.
- Found while building `apps/lookdev`: `WebGPURenderer` drops `PCFSoftShadowMap` with a warning and uses `PCFShadowMap` (`src/renderers/common/Renderer.js`, `shadowMap.type` check).
- `NodeMaterial.mrtNode` overrides what a single material writes into the pass MRT (`src/materials/nodes/NodeMaterial.js`, merged with the pass `mrt()`), so water, veils and telegraphs can opt out of line detection, and objects can write an ID channel, without a second pass.

---

## Sky weather VFX

### Research: weather, not a weather chart

The Sky's ambient gameplay weather must read as clouds, wind and mist at both normal and strategic zoom.
Island drift rings are the only persistent chart lines. Techniques below target the existing r187 TSL
pipeline and its WebGL2 fallback, not a new rendering stack. Costs marked **[estimate]** are not measurements.

**Storm clouds and lightning**

- [Rare's SIGGRAPH 2018 paper, *The Technical Art of Sea of Thieves*](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)
  explicitly rejects raymarching for performance and artistic control. Opaque cloud geometry receives cheap
  approximate scattering, then quarter-resolution blur, depth-aware composition and distortion. It targets
  laptop integrated GPUs as well as high-end PCs. Its lightning is an L-system mesh with baked branch/distance
  attributes, normalised so a vertex shader can animate it. **Take:** bounded geometry carriers and prebaked
  forked bolts; soft density shading rather than opaque puff assemblies. No additional blur/render target.
- [Horizon Forbidden West's superstorm talk](https://media.gdcvault.com/GDC+2022/Speaker+Slides/TheReal-timeVolumetricSuperstormsOfHorizonForbiddenWest_Schneider_Andrew.pdf)
  distinguishes intra-cloud flashes from discharges and couples bolts to internal/external cloud highlights.
  **Take:** flash the cloud itself and the condensation beneath the strike, rather than adding an
  unrelated white zigzag. Our hashed tick + cell-index envelope flickers twice; it never mutates the sim or RNG.
- [Horizon Zero Dawn's volumetric cloud slides](https://www.advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf)
  report roughly 20 ms for the full effect, reduced to roughly 2 ms using temporal reuse. A raymarch is not
  inherently cheap just because it is stylised. Three's [volume-cloud example](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_volume_cloud.html)
  demonstrates the volume approach, not a measured performance guarantee for this RTS.
- **Comparison:** billboards have few vertices but large overlapping transparent areas and need depth fade;
  mesh shells spend vertices but preserve shape while orbiting the camera and use ordinary depth rejection;
  raymarched volumes spend many density samples and usually need reduced-resolution/history machinery.
  WebGPU may accelerate the latter, but a fragment/mesh implementation is the boring shared WebGL2/TSL path.
  The original choice here (two density carriers, a pooled spiral-streamer draw and a separate bolt draw, no
  extra render target) was superseded by the fused storm pass below.
- **Style references, not invented technical claims:** Wind Waker, BotW/TotK and Genshin provide useful toon
  silhouettes/colour references; no primary source establishing their storm shader implementation was found.
  Nintendo's [TotK developer interview](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-9-the-legend-of-zelda-tears-of-the-kingdom-part-3/)
  explains sky traversal, not cloud rendering. Do not label a fan recreation as Nintendo/HoYoverse technology.

**Wind Waker wind and cheap alternatives**

- [Nintendo Dream's developer interview, translated by Good Blood](https://goodblood.games/wind-waker-interview):
  Aonuma describes white wind lines and cautions that too many become noisy. **Take:** short, separated streaks.
- [Nathan Gordon's Wind Waker reconstruction](https://web.archive.org/web/https://medium.com/@gordonnl/wind-f4fc7a3b366a)
  builds thick-line/ribbon spirals, moves a tapered opaque window along their UVs and offsets timing between
  copies. This is a reconstruction, not the original Nintendo source. **Take:** one static strip mesh, instanced
  seeds and a shader head/tail window. Our vertex shader forms occasional curls and moves streaks along the
  public lane heading; no simulated trail history or per-frame particle allocation/upload.
- [Ghost of Tsushima's lead VFX artist](https://blog.playstation.com/2021/01/12/how-stunning-visual-effects-bring-ghost-of-tsushima-to-life/)
  describes using wind particles as navigation, keeping wind inputs consistent and replacing expensive grass
  particle displacement with scrolling coarse/fine noise. **Take:** the motion itself communicates direction.
- [Valve flow maps](https://alex.vlachos.com/graphics/Vlachos-SIGGRAPH10-WaterFlow.pdf) hide scrolling resets
  with two phases. Useful for a filled wash, but rejected here: a filled lane would reintroduce the old arrow band.
  CPU-emitted ribbon histories are also unnecessary for fixed forecast lanes. One instanced streak draw suffices.

**Fog: height fog, volumes and soft particles**

- [Crytek's atmospheric effects](https://advances.realtimerendering.com/s2006/Wenzel-Real-time_Atmospheric_Effects_in_Games.pdf)
  cover analytic height fog and local fog volumes. Global height fog is useful atmosphere, but cannot alone
  communicate two moving local banks. Analytic ellipsoid integration is a viable alternative, but needs a
  depth-aware entry/exit calculation and another scene-depth dependency.
- [NVIDIA soft particles](https://developer.download.nvidia.com/whitepapers/2007/SDK10/SoftParticles_hi.pdf)
  fade intersections against scene depth. Three exposes [softParticles](https://threejs.org/docs/pages/module-SoftParticles.html).
  This helps camera-facing sprite clouds, but does not remove their transparency/overdraw cost.
- **Chosen:** four low horizontal noise slices per bank, upper slices smaller, scrolling at different rates.
  Two pre-baked tileable noise channels produce broad billows and fine breakup; no procedural fractal noise
  is evaluated per fog pixel. A pale body with a soft grey-blue pooled edge reads on the Sky's pale paper.
  There is no outline, hatch grid, depth sampling pass or raymarch. This trades some slice overdraw for a
  small, fixed eight-instance draw; grazing-angle slice visibility is the known limitation.

**RTS readability without ambient outlines**

- [Into the Breach's designers](https://www.rockpapershotgun.com/into-the-breach-interface-design) describe
  cutting hatched attack clutter, limiting overlapping effects, and using contextual tooltips to explain them.
  [Total War: Pharaoh's weather interview](https://gamerant.com/total-war-pharaoh-interview-dynamic-weather-system-development-explained/)
  describes toning down weather because units became unreadable. These are readability lessons, not claims
  that all strategy games avoid outlines.
- Our storm silhouette/darkness gives extent, drifting white streaks give wind heading, and low pale mist
  distinguishes fog. A local camera-facing scoop keeps visible island decks readable at flight, lowering and
  moored heights without clearing the surrounding storm. The weather legend names these looks; hovering
  public weather uses the shared `tip()` content/rendering with actual match-rule effects.
  Hover precedence is storm → seeded storm → fog → wind, so damage is never displaced by a harmless lane tip.

### Line/ring inventory and implementation

- `weather.ts` formerly drew violet storm boundaries/crosshatches, teal fog rings/stripes and ochre lane
  boundaries/arrows. All are removed, not merely hidden by a toggle.
- `sky.ts`'s old blue/teal concentric circles were **island drift orbits**, not Spire beam range. The ring centre
  and radius come from each public island path. They now carry the island owner's blue/red/neutral ink,
  a short solid direction lead, and bold hover/selection emphasis; the dashed next-minute preview and
  +15/30/45/60-second ticks are only shown for the highlighted island. All retained path lines describe islands.
- The generic rectangular Sky page frame is removed. The cloud-sea veil is reduced to a faint static paper
  mottle so noise does not masquerade as additional moving fog banks.
- Model silhouette ink is still part of the ink-and-watercolour art style, not a gameplay weather boundary.
  Selection markers, transient scan/impact warnings, weapon shots, relay energy flow and cross-plane awareness
  still describe their actual actions; none is an always-on Spire weapon-range circle. They are not ambient
  weather chart overlays and remain deliberately unchanged.
  Storm transforms reuse fixed typed buffers and scratch objects; changing radius never rebuilds geometry.
  Wind instance attributes rebuild only when lane data changes.
  Weather extent comes only from public `View.weather`; cosmetic cutaways use rendered island tracks gated by
  current Sky tile visibility, never public paths alone, fog memory, owners, buildings or units.

### Prototype and evidence

`apps/lookdev/?dir=weather&renderer=webgl` retains the original isolated prototype; `t=3.2` freezes time,
`flash=0|1` forces its envelope, and `zoom=wide` shows strategic zoom. It is not the acceptance surface for the
current storm renderer: the production-source proof below exercises the web client's actual Sky and materials.

The captures (before/after normal and far views, mist and lightning detail and the lookdev prototype) were taken
locally in `/tmp/ac-skyvfx/` and are not committed. Frame-time methodology and measured results are recorded below.

### Storm rendering: fused toon hurricanes

The puff banks, helical body, porous funnel, smooth hurricane and clipped-shell direction were rejected.
`storm-clouds.ts` now replaces every earlier storm carrier in the live `World` (one pass per World, fed by the
active map's `WeatherLayer` cloud field). Adopted techniques are not proof of good visual quality; the
captures below are.

**Primary-source comparison**

| Method | Evidence and tradeoff |
| --- | --- |
| Layered mesh flow | [Cyanilux](https://www.cyanilux.com/tutorials/tornado-shader-breakdown/) uses three cylindrical-UV shells, coherent wobble and rim-assisted clipping. Cheap, but camera-exposed carriers remain too close to the rejected designs. |
| Particles / impostors | [NVIDIA's off-screen particle chapter](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-particles) explains fill-rate savings and foreground-depth halos. Ordinary cards vary with view; [true impostors](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-21-true-impostors) reconstruct depth at the cost of raycasting. |
| Fused rasterized volumes | [Rare's Sea of Thieves paper](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf) describes opaque cloud geometry, reduced-resolution colour/depth filtering and soft compositing, explicitly targeting stylized clouds without raymarching. Selected architectural reference. |
| Actual volumetrics | [Guerrilla's Nubis, Evolved](https://www.guerrilla-games.com/read/nubis-evolved) covers fly-through clouds, rotating superstorms and temporal artifacts. Its timings are not transferable to AC. [Three's reference](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_volume_cloud.html) defaults to 100 steps and three volume fetches per step, not a cheap default here. |

**Camera stability:** the rejected density was UV-based, not screen-space. However its camera-facing rim
multiplied density before clipping, so camera motion changed surviving fragments. Thresholded fine detail
used non-mipmapped linear minification; layered depth-writing surfaces and finite MSAA coverage added risks.
The global ink pass separately contains screen-space paper grain and edge-tap jitter. Their relative visual
contribution has not been isolated in a valid Sky capture; these are code findings, not measured attribution.

**Renderer (`storm-clouds.ts`)**

- Eighty-eight actual 3D packets per public cell, laid out once in a static instance table: an eight-packet
  eyewall with eight taller hot towers, a ten-packet dense overcast with fourteen edge billows, and three
  trailing spiral arms of eight tangent-pitched packets plus eight outer billows each. Rings and arms rotate at
  different rates; the billows scallop the fused silhouette (toon cloud edge) without separate lobes reading.
  Nine inward wind trails and one lightning chord per cell share the pass. No noise texture, view-facing density
  threshold, alpha hash, temporal jitter, history, readback or raymarch.
- Packets never enter the main ink pass. One half-resolution RGBA16F pass stores illumination, opacity, flash
  and linear depth against a zero clear, so the 3×3-tap peak recovers smooth bilinear shape coverage (all
  channels are premultiplied by it) separately from lifecycle opacity: faint forecasts keep a crisp silhouette.
- The full-resolution resolve quantises light into a four-step cel ramp (shadow `#232c45`, slate `#3f4d6c`, lit
  `#6f82a6`, wind `#c4d2ea`), darker and cooler than the white deck; a rotating three-arm spiral band darkens
  the light so circulation reads in a still frame. It inks the outer silhouette, depth folds where banks
  overlap and the cutaway rim in the viewed page's line colour. Wind (illumination 3) and lightning (10) are
  markers above the ramp; the bolt core is read from the unfiltered centre tap inside a violet halo. A flash
  lifts the bank slightly along the same ramp. Bolts show only on the painted Sky (`FADE.sky.focus`).
- Every cloud tap tests the original **full-resolution scene depth**. Island clearance is applied afterwards
  at full resolution, never blurred into the cloud target, through the same `islandClearance` the deck uses.
- Only rendered/current-Sky-fog-visible islands enter clearance. Cached actual terrain/canopy bounds follow
  rendered drift, scale and mooring elevation. Visible explicitly linked buildings and disclosed live ore
  bounds extend them; there is no hidden occupant or whole-root bounds traversal. `StormClouds.sync` copies
  the active layer's field and admitted islands into its own retained arrays each frame (no allocation).
- White deck puffs inside a storm shrink smoothly to nothing (by distance to each cell, scaled by its opacity)
  rather than poking through the dark mass.
- Reduced motion freezes cosmetic advection/flashes, not public weather progression. Canonical
  `weatherStormAt` exposure, simulation radius/timing/damage, fog and routes are unchanged.
- The startup warm-up compiles the pass's three programs against its own target (`StormClouds.compile`);
  the output warm-up skips every scene pass.

**Structural cost, not a benchmark:** three instanced draws in one cloud pass, one reusable RGBA16F target
plus depth at 0.5 linear resolution, nine full-resolution resolve samples. Eighty-eight 168-triangle packets,
nine 80-triangle trails and one bolt are about 15.6k triangles per cell (~3.5× the rejected shells), capped at
64 cells; the fixture's whole frame drew ~170k triangles with one storm. Actual overdraw, bandwidth and frame
time are unmeasured; no low-end performance claim follows from screenshots.

**Proof:** `apps/lookdev/scripts/storm.mjs` drives the real `World` (startup warm-up, `updateScene`, its own
storm pass), islands, a linked Aerie, aircraft, terrain/canopy/ore, fog and ink. Default service is
`http://localhost:5173` (127.0.0.1 is not equivalent for the IPv6 dev binding). Minimal mode is 960×672,
three rendered frames per pose, no timing loop. `STORM_PROOF_GATE` = `art` (centre/reveal, clearance-disabled
control, low angle, later circulation, lightning), `cutaway` (a moving island outside → entering → centre →
lowering → moored → raising → leaving, hidden, low-angle moored/raising), `growth` (a later storm from forecast
through formation) or `fade` (Sky, Sky→Orbit dive, Orbit, Surface); `STORM_PROOF_SCENE` selects one case.
Wrong Sky focus, missing clearance or missing in-storm exposure fails the fixture. Use finite
`/tmp/ac-test.lock`.

Lifecycle: a natural storm's drawn size/opacity is one continuous, monotonic function of its public
start/grown/breaking/end ticks (a forecast gathers 0.22→0.4 of its radius, forming grows on 0.4→1; it no longer
restarts from zero at `start`). Plane fade: the storm uses `FADE.sky.alpha` and, like `finish`, ghosts to the
viewed paper/ghost pencil by `FADE.sky.focus` (Orbit view, dives); bolts and flashes only on the painted Sky. The
pass is skipped entirely while no storm is drawn. Openings: the 16 island cutaways and 96 visible-aircraft holes
are admitted nearest the camera first; aircraft holes are drawn into the storm pass itself, so the fused
silhouette inks their rim.

History: the first fused gate (`/tmp/ac-fused-storm-proof/`) was too pale with separate rounded lobes; a
20-packet two-arm revision (`-2`) read as a thin translucent ribbon. Hard cel banding, a peak-normalised shape
edge, ink, billows, the three-arm eyewall/overcast layout and deck absorption followed (`-3` … `-10`). The
live-bound gate is `/tmp/ac-fused-storm-proof-final/` (WebGL2, zero console errors): two islands admitted in
storm versus zero with clearance disabled, moored reveal included. WebGPU parity, moving reveal and GPU timing
are not yet captured.

## Sources

Games / studios
- https://www.rockpapershotgun.com/northgard-review-early-access
- https://tryrolling.com/northgard-early-access-review
- https://www.levelinfinite.com/news/how-dune-spice-wars-art-evokes-beautiful-dangerous-arrakis
- https://wiki.hoodedhorse.com/Against_the_Storm/Tutorial_Walkthrough
- https://wiki.hoodedhorse.com/Against_the_Storm/Glades
- https://news.blizzard.com/en-us/article/4546768/game-guide-map-elements
- https://technology.riotgames.com/news/story-fog-and-war
- https://in.ign.com/civilization-6/93881/civilization-6s-new-game-changer-features
- https://uk.pcmag.com/games/84981/civilization-vi-for-pc
- https://media.gdcvault.com/gdc2019/presentations/Into%20the%20Breach%20Postmortem%20Final.pdf
- https://planetaryannihilation.com/guides/controls-and-the-user-interface
- https://en.wikipedia.org/wiki/DEFCON_(video_game)
- https://simonschreibt.de/gat/homeworld-2-backgrounds
- https://github.com/laanwj/hw2view
- https://mod.io/g/homeworld3/r/modding-sensor-manager-level
- https://blog.pocketwatchgames.com/post/129160388256/nothing-new-under-the-sunray-shader-the
- https://blog.pocketwatchgames.com/post/134808733616/pixel-ark-the-look-of-the-animals-in-tooth-and
- https://80.lv/articles/mixing-2d-billboards-and-3d-environments-in-a-game
- https://www.gamedeveloper.com/design/designing-i-highfleet-i-a-strategy-game-with-heavy-machinery-and-twirling-knobs
- https://www.nintendo.com/en-gb/News/2018/April/Interview-Taking-on-hordes-of-invading-Vikings-in-Bad-North-1368315.html
- https://konsoll.org/talks/developing-the-bad-north-look
- https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making
- https://www.youtube.com/watch?v=Uxeo9c-PX-w
- https://confpad.io/conferences/konsoll-2021/the-story-of-townscaper
- https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design
- https://graphicsprogrammingconference.com/archive/2024
- https://www.digitalfoundry.net/articles/digitalfoundry-2024-tiny-glade-proves-the-power-of-bespoke-game-engines-and-graphics-tech
- https://gameworldobserver.com/2019/06/14/islanders
- https://news.xbox.com/en-us/2021/07/21/how-the-visual-identity-of-frostpunk-changed
- https://www.gamedeveloper.com/design/-i-kingdom-two-crowns-i-and-the-practical-intersection-of-pixel-art-and-roguelike-design
- https://www.gamedeveloper.com/audio/postmortem-dinosaur-polo-club-s-i-mini-metro-i-
- https://www.gamesradar.com/zelda-tears-of-the-kingdom-depths/
- https://www.ign.com/wikis/the-legend-of-zelda-tears-of-the-kingdom/The_Depths_Guide_and_Overview
- https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-9-the-legend-of-zelda-tears-of-the-kingdom-part-3
- https://www.mobiusdigitalgames.com/news/our-new-style
- https://www.mobiusdigitalgames.com/news/the-atmosphere-awakens
- https://80.lv/articles/dissecting-the-art-style-of-outer-wilds
- https://www.gamedeveloper.com/marketing/how-shedworks-refined-the-art-of-sable-in-pursuit-of-readability
- https://www.cookandbecker.com/en/article/170/sable-exploration-through-line-art.html
- https://dukope.com/devlogs/obra-dinn/tig-32
- https://cdn.cloudflare.steamstatic.com/apps/valve/2007/NPAR07_IllustrativeRenderingInTeamFortress2.pdf
- https://www.polygon.com/2015/5/26/8663003/guilty-gear-xrd-cel-shading-making-of/
- https://www.gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The
- https://acko.net/blog/teardown-frame-teardown
- https://www.rockpapershotgun.com/how-deep-rock-galactic-mines-fun-from-absolute-darkess

Techniques
- https://roystan.net/articles/toon-shader
- https://roystan.net/articles/toon-water
- https://panthavma.com/articles/shading/toonshading
- https://panthavma.com/articles/lines/deep-overview-extraction
- https://blog.maximeheckel.com/posts/moebius-style-post-processing
- https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders
- https://blog.maximeheckel.com/posts/the-art-of-dithering-and-retro-shading-web/
- https://blog.maximeheckel.com/posts/real-time-cloudscapes-with-volumetric-raymarching
- https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/
- https://github.com/OmarShehata/webgl-outlines
- https://jan.games/personal-work/moebius-style-shading
- https://bgolus.medium.com/the-quest-for-very-wide-outlines-ba82ed442cd9 (Medium 403s to scripts; title confirmed via search)
- https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a (same)
- https://gist.github.com/bgolus/a18c1a3fc9af2d73cc19169a809eb195
- https://gfx.cs.princeton.edu/proj/hatching/
- https://docs.blender.org/manual/en/4.0/compositing/types/filter/kuwahara.html
- https://surma.dev/things/ditherpunk/
- https://iquilezles.org/articles/texturerepetition/
- https://iquilezles.org/articles/smin/
- https://www.boristhebrave.com/2023/05/31/quarter-tile-autotiling/
- https://www.youtube.com/watch?v=jEWFSv3ivTg
- https://github.com/pablogila/TileMapDual
- http://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/blob.html
- https://opengameart.org/content/wang-%E2%80%98blob%E2%80%99-tileset
- https://jamie-wong.com/2014/08/19/metaballs-and-marching-squares/
- https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf
- https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process
- https://www.jdxdev.com/blog/2022/06/08/rts-fog-of-war/
- https://blog.gemserk.com/2018/08/27/implementing-fog-of-war-for-rts-games-in-unity-1-2
- https://blog.gemserk.com/2018/11/20/implementing-fog-of-war-for-rts-games-in-unity-2-2
- https://gameaccessibilityguidelines.com/ensure-no-essential-information-is-conveyed-by-a-fixed-colour-alone
- https://devdocs.xbox.com/build/game-principles/accessibility/xag-deep-dives/xag-103-additional-cues
- https://siegal.bio.nyu.edu/color-palette
- https://journal.r-project.org/articles/RJ-2023-071
- https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html

Three.js
- https://threejs.org/manual/pages/webgpu-postprocessing.html
- https://threejs.org/docs/pages/ToonOutlinePassNode.html
- https://threejs.org/docs/pages/BatchedMesh.html
- https://github.com/mrdoob/three.js/releases/tag/r181
- https://github.com/mrdoob/three.js/releases/tag/r183
- https://github.com/mrdoob/three.js/releases/tag/r187
- https://threejs.org/examples/webgpu_materials_toon.html
- https://threejs.org/examples/webgpu_postprocessing_pixel.html
- https://threejs.org/examples/webgpu_postprocessing_outline.html
- https://threejs.org/examples/webgpu_postprocessing_3dlut.html
- https://threejs.org/examples/webgpu_tsl_occlusion_dither.html
- https://threejs.org/examples/webgpu_tsl_halftone.html
- https://threejs.org/examples/webgpu_materialx_noise.html
- https://threejs.org/examples/webgpu_tsl_procedural_terrain.html
- https://threejs.org/examples/webgpu_mesh_batch.html
- https://threejs.org/examples/webgpu_backdrop_water.html
- https://threejs.org/examples/webgpu_volume_cloud.html
- https://threejs.org/examples/webgpu_volume_perlin.html
- https://threejs.org/examples/webgpu_postprocessing_godrays.html
- https://threejs.org/examples/webgpu_fog_height.html
- https://threejs.org/examples/webgpu_custom_fog.html
- https://threejs.org/examples/webgpu_mrt.html
- https://threejs.org/examples/webgpu_oit.html
- https://threejs.org/examples/?q=webgpu_postprocessing
