/** The HTML-first loader is shared by boot and every match transition; no renderer dependency. */
export type LoadingStage = 'assets' | 'world' | 'connecting' | 'first-frame';
const LABEL: Record<LoadingStage, string> = { assets: 'Loading assets', world: 'Building world', connecting: 'Connecting', 'first-frame': 'Preparing first frame' };
const screen = document.getElementById('loading')!;
const caption = document.getElementById('load-stage')!;
const note = document.getElementById('load-note')!;
const fill = document.getElementById('load-fill')!;
const bar = screen.querySelector('[role="progressbar"]')!;
let progress = 0;
let active = true;

/** index.html boots showing the home menu's static shell; anything but the home menu (a match, a results page, an
 *  error) swaps in the plain loader card. The home keeps the shell through the loader's fade-out; a later loading
 *  screen (a match) begins with this. */
export function endShell(): void {
  delete document.documentElement.dataset.boot;
}

export function beginLoading(): void {
  progress = 0;
  active = true;
  endShell();
  screen.removeAttribute('aria-hidden');
  screen.inert = false;
  document.documentElement.dataset.loading = 'assets';
  setLoading('assets', 0, 'Preparing your battlefield.');
}

export function setLoading(stage: LoadingStage, fraction: number, detail = ''): void {
  if (!active) return;
  progress = Math.max(progress, Math.min(1, Math.max(0, fraction)));
  document.documentElement.dataset.loading = stage;
  screen.dataset.stage = stage;
  caption.textContent = LABEL[stage];
  note.textContent = detail;
  fill.style.width = `${progress * 100}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
}

/** Called only after the home DOM or a complete match frame is ready to be presented. */
export function finishLoading(destination: 'home' | 'match' | 'connect'): void {
  progress = 1;
  fill.style.width = '100%';
  bar.setAttribute('aria-valuenow', '100');
  screen.setAttribute('aria-hidden', 'true');
  screen.inert = true;
  delete document.documentElement.dataset.loading;
  active = false;
  performance.mark(destination === 'match' ? 'ac:match-first-frame' : `ac:${destination}-ready`);
}

/** The loader's failure state: the message, then Try again (when the entry can be retried) and Return home. */
export function failLoading(message: string, retry?: () => void): void {
  active = true;
  endShell();
  screen.removeAttribute('aria-hidden');
  screen.inert = false;
  screen.dataset.stage = 'error';
  document.documentElement.dataset.loading = 'error';
  caption.textContent = 'Could not load';
  note.replaceChildren(document.createTextNode(`${message} `));
  if (retry) {
    const again = document.createElement('a');
    again.href = location.href;
    again.dataset.loadAction = 'retry';
    again.textContent = 'Try again';
    again.addEventListener('click', (event) => { event.preventDefault(); retry(); }, { once: true });
    note.append(again, document.createTextNode(' · '));
  }
  const home = document.createElement('a');
  home.href = location.pathname;
  home.dataset.loadAction = 'home';
  home.textContent = 'Return home';
  note.append(home);
}
