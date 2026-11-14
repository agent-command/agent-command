import { endShell, failLoading, finishLoading } from './loading.ts';
import { preparePoster } from './poster.ts';

// The home's backdrop still downloads and decodes alongside the menu's chunks, so both appear together. Every other
// page loads behind the plain loader card instead of the home menu's static shell.
if (location.pathname === '/') preparePoster();
else endShell();

// Keep the HTML loader paintable while the stylesheet and menu arrive; no render-blocking CSS or eager 3D graph.
try {
  await import('./style.css');
  if (location.pathname === '/connect') {
    const { ConnectPage } = await import('./connect-page.ts');
    document.getElementById('app')!.append(new ConnectPage(new URLSearchParams(location.search).get('r')).el);
    finishLoading('connect');
  } else {
    await import('./play.ts');
  }
} catch (error) {
  console.error(error);
  failLoading('Please check your connection and try again.');
}
