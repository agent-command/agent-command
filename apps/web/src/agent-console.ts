/**
 * PlayerThree's console in the game's theme. Profile credentials default to a private named roster;
 * a live commander view additionally requires the exact commander/match/team/role target.
 * Human seat capabilities remain exact-seat. Observer sessions never mount this owner console.
 */
import './agent-console.css';
import { createPlayerConsole, mountConsolePanel, type ConsolePanel, type ConsoleActionTarget, type PlayerConsoleTarget } from '@playerthree/console';
import { PLANE_NAME } from './text.ts';
import { CONSOLE_KEY } from './keymap.ts';
import { icon } from './icons.ts';
import { tip } from './tooltip.ts';

/** Reference input price for the cost estimate (USD per million input tokens; frontier-model ballpark). */
const PRICE_PER_MTOK = 3;

export interface AgentConsoleOptions {
  credential: () => string | undefined;
  mount: HTMLElement;
  /** Keyboard toggle; false when the host screen routes the key itself. Default true. */
  key?: boolean;
  target?: PlayerConsoleTarget | (() => PlayerConsoleTarget | undefined);
  resolveApproval?: (target: ConsoleActionTarget, id: string, approve: boolean) => Promise<void>;
  onToggle?: (open: boolean) => void;
}

export function mountAgentConsole(opts: AgentConsoleOptions): ConsolePanel {
  const client = createPlayerConsole({ credential: opts.credential, url: '/playerthree/player', pricePerMTok: PRICE_PER_MTOK, ...(opts.target ? { target: opts.target } : {}) });
  const panel = mountConsolePanel({
    console: client,
    mount: opts.mount,
    toggleKey: opts.key === false ? null : CONSOLE_KEY,
    title: 'Agent console',
    className: 'fj-console',
    currency: '$',
    roleLabel: (role) => (role in PLANE_NAME ? PLANE_NAME[role as keyof typeof PLANE_NAME] : role),
    ...(opts.resolveApproval ? { actions: { resolveApproval: opts.resolveApproval } } : {}),
    ...(opts.onToggle ? { onToggle: opts.onToggle } : {}),
  });
  // Adapt the package's persistent close control to the host's single explanation system.
  const close = panel.el.querySelector<HTMLButtonElement>('.playerthree-console__close');
  if (close) {
    close.removeAttribute('title');
    close.replaceChildren(icon('cancel', 16));
    tip(close, 'Close the agent console');
  }
  return panel;
}
