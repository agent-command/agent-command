/** Home-screen flair: optional social badges (Vite env URLs), the PlayerThree credit and a random splash line pinned
 * to the logo. UI only. */
import { h } from "./dom.ts";
import { tip } from "./tooltip.ts";
import { icon, type IconName } from "./icons.ts";
import playerThreeMark from "./brand/playerthree-mark.webp";
import "./home-flair.css";

interface Social {
  url: string | undefined;
  icon: IconName;
  name: string;
}

const SOCIALS: readonly Social[] = [
  {
    url: import.meta.env.VITE_SOCIAL_X_URL as string | undefined,
    icon: "brand_x",
    name: "X",
  },
  {
    url: import.meta.env.VITE_SOCIAL_DISCORD_URL as string | undefined,
    icon: "brand_discord",
    name: "Discord",
  },
  {
    url: import.meta.env.VITE_SOCIAL_PATREON_URL as string | undefined,
    icon: "brand_patreon",
    name: "Patreon",
  },
];

/** RTS callbacks crossed with agent jokes. */
export const SPLASHES: readonly string[] = [
  "You require more inference pylons",
  "Power overwhelming. Budget underwhelming.",
  "My life for the prompt.",
  "Wololo. Alignment updated.",
  "Enemy agent detected in the context window.",
  "Insufficient funds. Switching to Haiku.",
  "Unable to comply. Pathfinding error.",
  "I cannot build there. Invalid JSON.",
  "Your workers are idle. Your agents are thinking.",
  "Nuclear silo ready. Awaiting tool permissions.",
  "Fog of war enabled. Reasoning hidden.",
  "The enemy has researched prompt injection.",
  "Attack move. Tool call denied.",
  "Unit promoted. Model deprecated.",
  "Research complete. Accuracy unchanged.",
  "Building additional pylons. Please hold.",
  "Enemy expansion detected. Scaling inference.",
  "All your tokens are belong to us.",
  "We are under attack. Running evals.",
  "Affirmative. Confidence 0.51.",
  "Establishing battle control. Connecting MCP.",
  "Commander, our API credits are running low.",
  "Insufficient minerals. Try a smaller model.",
  "The spice must flow. The tokens must stream.",
  "Victory achieved. Benchmark contaminated.",
  "Mission failed. Successfully.",
  "Opponent disconnected. Rate limit exceeded.",
  "Awaiting orders. Awaiting tool results.",
  "This is not a drill. This is a benchmark.",
  "The fog of war is just missing context.",
];

/** Only absolute http(s) URLs render; anything else in the env is ignored. */
function safeUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Toon badges for each configured social URL; undefined when none is set. */
export function socialLinks(
  socials: readonly Social[] = SOCIALS,
): HTMLElement | undefined {
  const links = socials.flatMap((s) => {
    const href = safeUrl(s.url);
    return href
      ? [
          h(
            "a",
            {
              class: "home-social-link",
              href,
              target: "_blank",
              rel: "noopener noreferrer",
              "aria-label": `Agent Command on ${s.name} (opens in a new tab)`,
              "data-tip": `Agent Command on ${s.name}`,
            },
            icon(s.icon, 20),
          ),
        ]
      : [];
  });
  return links.length
    ? h(
        "nav",
        { class: "home-social", "aria-label": "Community links" },
        ...links,
      )
    : undefined;
}

/** "Powered by PlayerThree" in Home's bottom-left corner, linking to the SDK site; logo only on narrow screens. */
export function poweredBy(): HTMLElement {
  return h(
    "a",
    {
      class: "home-p3",
      href: "https://playerthree.gg",
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": "Powered by PlayerThree (opens playerthree.gg in a new tab)",
      "data-tip": "Agent Command runs on the PlayerThree SDK · playerthree.gg",
    },
    h("img", { class: "home-p3-mark", src: playerThreeMark, alt: "", width: 115, height: 96, decoding: "async" }),
    h("span", { class: "home-p3-text" }, "Powered by ", h("b", {}, "PlayerThree")),
  );
}

/** Short commit ids shown in the version tag. */
const SHORT_SHA = 7;

/** The build's version in Home's bottom-right corner (bug reports name it); the tip carries both repos' commits. */
export function versionTag(release: typeof __AC_RELEASE__ = __AC_RELEASE__): HTMLElement {
  const short = (sha: string) => sha.slice(0, SHORT_SHA);
  return tip(
    h("span", { class: "home-version" }, `v${release.version} · ${short(release.agentCommand)}`),
    `Agent Command ${short(release.agentCommand)} · PlayerThree ${short(release.playerThree)} · built ${release.builtAt}`,
  );
}

/** Wraps the logo heading so a slanted splash line can sit on its corner without affecting layout. */
export function withSplash(
  title: HTMLElement,
  pick: () => number = Math.random,
): HTMLElement {
  const line = SPLASHES[Math.floor(pick() * SPLASHES.length)] ?? SPLASHES[0]!;
  return h(
    "div",
    { class: "hero-mark" },
    title,
    h(
      "p",
      { class: "home-splash", "aria-hidden": "true" },
      h("span", {}, line),
    ),
  );
}
