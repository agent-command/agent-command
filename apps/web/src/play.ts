/** Paint the interactive DOM with the backdrop's still first, then idle-start the shared live backdrop and match world. */
import { Lobby, type LobbyChoice } from './lobby.ts';
import { TerrainChoice } from './terrain-choice.ts';
import { parseFragment } from './net.ts';
import { parseLobbyCode, ProfileApi, type LobbyObserverTicket } from './profile.ts';
import type { ArmyId } from '@agent-command/game/contract';
import { beginLoading, endShell, failLoading, finishLoading, setLoading } from './loading.ts';
import type { ExitRoute, ObserverOptions, SessionOptions } from './game.ts';
import type { MatchRuntime } from './match-runtime.ts';
import type { ArenaResultsOptions, ArenaResultsPanel, SeriesObserverSelection } from './arena.ts';
import { bootAudio } from './audio/index.ts';
import { choicePosterKey, retirePoster, showPoster } from './poster.ts';
import { previewViews } from './preview-client.ts';
import { mountMobileBanner, phoneBannerDue } from './mobile-banner.ts';
/** The bot playlist's release delay (server `FEATURED_DELAY_MS`); a public game on air announces its own (≥ 180 s). */
const FEATURED_DELAY_MS = 3000;

type EntryOptions = SessionOptions | { observe: ObserverOptions };

const app = document.getElementById('app')!;
const terrain = new TerrainChoice();
let lobby: Lobby | undefined;
let runtime: MatchRuntime | undefined;
let active = false;
let results: ArenaResultsPanel | undefined;
let resultsKey: string | undefined;
let runtimeReady: Promise<MatchRuntime> | undefined;

function closeResults(): void {
  results?.dispose();
  results = undefined;
  resultsKey = undefined;
}

async function sharedRuntime(): Promise<MatchRuntime> {
  // This dynamic boundary keeps Three and procedural setup out of the DOM home's first paint.
  runtimeReady ??= import('./match-runtime.ts').then(({ MatchRuntime }) => MatchRuntime.create(app));
  runtime = await runtimeReady;
  return runtime;
}

terrain.onChange(() => {
  if (!active) runtime?.previewMap(terrain.options(), choicePosterKey(terrain.getMap()));
});

/** The floating music player is not part of the menu's first paint: its chunk loads and mounts after it. */
function mountMusicPlayerLater(): void {
  void import('./music-player.ts').then(({ mountMusicPlayer }) => mountMusicPlayer())
    .catch((error: unknown) => console.error('Music player failed to load', error));
}

/** Settles once the live backdrop is up (or could not start). */
function startBackdropAfterPaint(): Promise<void> {
  // The worker builds the map's view while the 3D runtime chunk downloads and initializes (the runtime asks for the
  // same view and gets this cached job). Failures surface through the backdrop chain below.
  terrain.ready.then(() => {
    if (!active) void previewViews.get(terrain.options());
  }).catch(() => {});
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const start = (): void => {
      if (active) return resolve();
      // The 3D runtime downloads and initializes meanwhile a saved-map link's terrain (known once the server catalogue
      // loads) arrives: the catalogue's round trip is never in front of the runtime chunk.
      void Promise.all([sharedRuntime(), terrain.ready]).then(([ready]) => {
        if (!active) return ready.showBackdrop(terrain.options(), choicePosterKey(terrain.getMap()));
      }).catch((error: unknown) => console.error('Backdrop preparation failed', error)).finally(resolve);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(start);
    else setTimeout(start, 0);
  }));
  return promise;
}

function showLobby(): void {
  active = false;
  closeResults();
  runtime?.stop();
  lobby = new Lobby((choice: LobbyChoice) => {
    const observe = choice.observe;
    void enter({ ...choice.ticket, mode: choice.mode, label: choice.label, onExit: exitMatch, ...(observe ? { spectate: (perspective: ArmyId | 'all') => spectate(observe, perspective) } : {}) });
  }, terrain, ({ seriesId, credential }) => {
    const url = new URL(location.href);
    url.hash = `series=${encodeURIComponent(seriesId)}`;
    history.replaceState(null, '', url);
    void enterResults({ kind: 'owner', seriesId, credential: () => credential }, `owner:${seriesId}`);
  }, goWatch, joining);
  app.append(lobby.el);
  if (phoneBannerDue()) mountMobileBanner({ onWatch: goWatch });
  showPoster(app);
  finishLoading('home');
  // (the Lobby sets the music scene for its route: home themes on Home, the lobby tracks in the lobby and Create Game)
  // Audio downloads wait for the backdrop (or the first gesture): they would compete with the 3D chunk.
  bootAudio(startBackdropAfterPaint());
  mountMusicPlayerLater();
}

/** Leave a match or observer for the screen it came from, or `to` the public games list or Home. */
function exitMatch(to?: ExitRoute): void {
  const url = new URL(location.href);
  url.hash = '';
  url.searchParams.delete('watch');
  if (to === 'home') url.searchParams.delete('screen');
  else if (to) url.searchParams.set('screen', to);
  history.replaceState(null, '', url);
  showLobby();
}

/** An eliminated player's observer pass (DESIGN §15.7): the match HUD hands over to the read-only observer on the
 *  chosen perspective. Rejects while the server still counts us as playing; the match HUD stays up then. The loader
 *  shows from the click: the observer ticket, then the observer's first frame. */
async function spectate(observe: () => Promise<LobbyObserverTicket>, perspective: ArmyId | 'all'): Promise<void> {
  beginLoading();
  setLoading('connecting', 0.3, 'Joining as an observer.');
  let ticket: LobbyObserverTicket;
  try { ticket = await observe(); } catch (error) { finishLoading('match'); throw error; }
  runtime?.stop();
  active = false;
  await enter({ observe: { roomId: ticket.roomId, token: ticket.token, grant: ticket.grant, perspective, label: ticket.label, onExit: exitMatch } });
}

/** The Lobby is joining a room or handing off to its started match: the loader holds until the room screen shows. */
function joining(pending: boolean): void {
  if (active) return;
  if (!pending) { finishLoading('home'); return; }
  beginLoading();
  setLoading('connecting', 0.3, 'Joining the game.');
}

/** The loader's Try again: a lobby seat re-enters through its room (a used ticket may not admit twice); any other
 *  entry runs again as it was. */
function retry(options: EntryOptions): void {
  runtime?.stop();
  active = false;
  if (!('observe' in options) && options.lobbyCode) location.reload();
  else void enter(options);
}

function exitResults(): void {
  const url = new URL(location.href);
  url.pathname = '/';
  url.hash = '';
  url.searchParams.delete('watch');
  history.replaceState(null, '', url);
  showLobby();
}

async function enterResults(access: ArenaResultsOptions['access'], key: string): Promise<void> {
  if (resultsKey === key) return;
  closeResults();
  retirePoster();
  endShell();
  resultsKey = key;
  active = false;
  runtime?.stop();
  lobby?.dispose();
  lobby = undefined;
  try {
    // Series results are a code-split screen: their chunk never loads with the home menu.
    const { mountArenaResults } = await import('./arena.ts');
    // Superseded while the results chunk loaded (another route, or closed).
    if (resultsKey !== key) return;
    results = mountArenaResults(app, {
      access, onExit: exitResults,
      onObserve: (selection: SeriesObserverSelection) => {
        void enter({ observe: { source: { kind: 'series', access: selection.access, matchId: selection.matchId }, grant: selection.grant, label: selection.label, onExit: () => void enterResults(access, key) } });
      },
    });
    finishLoading('home');
  } catch (error) {
    console.error(error);
    failLoading('Could not load series results. Reload to try again.');
  }
}

async function enter(options: EntryOptions): Promise<void> {
  if (active) return;
  // A seat on a phone: offer the observer first. The card sits over the loader; nothing heavy starts until it's answered.
  if (!('observe' in options) && phoneBannerDue()) {
    mountMobileBanner({ onWatch: goWatch, onDeploy: () => void enter(options) });
    return;
  }
  active = true;
  closeResults();
  retirePoster();
  beginLoading();
  lobby?.dispose();
  lobby = undefined;
  if (!('observe' in options)) {
    // Lobby codes identify destinations; direct seat links consume their bearer fragment on entry.
    const url = new URL(location.href);
    url.hash = options.lobbyCode ? `l=${encodeURIComponent(options.lobbyCode)}` : '';
    history.replaceState(null, '', url);
  }
  try {
    setLoading('assets', 0.1, 'Loading the battlefield.');
    const ready = await sharedRuntime();
    // A world dropped mid-session (lost snapshot, featured rotation) whose next frame never comes.
    ready.onFail = (message) => { ready.stop(); failLoading(message, () => retry(options)); };
    bootAudio();
    mountMusicPlayerLater();
    if ('observe' in options) await ready.enterObserver(options.observe);
    else await ready.enter(options);
  } catch (error) {
    console.error(error);
    runtime?.stop();
    failLoading(error instanceof Error ? error.message : 'The battlefield could not be loaded.', () => retry(options));
  }
}

/**
 * The featured match (`?watch=live`), from a link or Home's Watch live: the delayed broadcast relay. It shows the
 * newest running public game once its delayed stream starts (announced ahead with a countdown), else the server's
 * featured playlist (duels and four-army FFAs of built-in bots). It opens on All; the relay's announcement names the
 * match's armies (a vision per army) and withdraws All where the match serves none. A signed-in viewer sends its
 * profile credential, so a public game it played shows only its own side.
 */
function watchLive(): void {
  let secret: string | undefined;
  try { secret = ProfileApi.stored()?.profile.secret; } catch { secret = undefined; /* An unreadable saved profile watches anonymously. */ }
  void enter({ observe: { source: { kind: 'featured', ...(secret ? { secret } : {}) }, grant: { kind: 'omniscient', teams: [], delayMs: FEATURED_DELAY_MS }, label: 'Watch live', onExit: exitMatch } });
}

/** Home's Watch live (and the phone banner's): link the featured match, then watch it. */
function goWatch(): void {
  const url = new URL(location.href);
  url.hash = '';
  url.searchParams.delete('screen');
  url.searchParams.set('watch', 'live');
  history.pushState(null, '', url);
  watchLive();
}

function route(): void {
  if (active) return;
  const share = /^\/arena\/share\/([A-Za-z0-9_-]{32})$/.exec(location.pathname);
  if (share) {
    void enterResults({ kind: 'share', token: share[1]! }, `share:${share[1]!}`);
    return;
  }
  const seriesId = new URLSearchParams(location.hash.slice(1)).get('series');
  if (seriesId && /^[A-Za-z0-9_-]{1,128}$/.test(seriesId)) {
    void enterResults({ kind: 'owner', seriesId, credential: () => ProfileApi.stored()?.profile.secret }, `owner:${seriesId}`);
    return;
  }
  if (resultsKey) closeResults();
  const fragment = parseFragment(location.hash);
  const code = parseLobbyCode(location.hash);
  if (fragment) {
    void enter({ ...fragment, label: 'Joined match', onExit: exitMatch });
    return;
  }
  if (new URLSearchParams(location.search).get('watch') === 'live') {
    watchLive();
    return;
  }
  if (!lobby) showLobby();
  if (code) void lobby?.join(code);
}

addEventListener('hashchange', route);
route();

