/**
 * Which harness an OAuth client is, for the commander UI's icons and setup hints. Detected from the client
 * metadata the authorization server validated:
 *   - Client ID Metadata Documents (`registration: 'cimd'`): the client_id URL's host vouches for the name, so the
 *     host decides (claude.ai → Claude Code, openai.com/chatgpt.com → Codex, opencode.ai → OpenCode, pi.dev → Pi,
 *     nousresearch.com → Hermes).
 *   - Dynamic Client Registration (`'dcr'`): `software_id` / `client_name` are self-asserted. The kind is an icon
 *     hint only; the UI marks such clients unverified (no `domain`).
 */
import type { ClientKind, ConnectionClient } from '@playerthree/connect';
import type { OAuthClientInfo } from 'playerthree/mcp';

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function clientKind(client: OAuthClientInfo): ClientKind {
  const softwareId = client.softwareId ?? '';
  const name = client.name.toLowerCase();
  if (softwareId === 'dev.playerthree.bridge' || name === 'playerthree-mcp') return 'playerthree-bridge';
  if (softwareId === 'dev.playerthree.runner' || name === 'playerthree-run') return 'playerthree-runner';
  if (client.registration === 'cimd') {
    const url = new URL(client.id);
    const host = url.hostname;
    if ((hostIs(host, 'claude.ai') || hostIs(host, 'anthropic.com')) && (url.pathname.includes('claude-code') || name.includes('claude code'))) return 'claude-code';
    if (hostIs(host, 'openai.com') || hostIs(host, 'chatgpt.com')) return 'codex';
    if (hostIs(host, 'opencode.ai')) return 'opencode';
    if (hostIs(host, 'pi.dev')) return 'pi';
    if (hostIs(host, 'nousresearch.com')) return 'hermes';
    return 'generic';
  }
  if (/\bclaude[ -]?code\b/.test(name)) return 'claude-code';
  if (/\bcodex\b/.test(name)) return 'codex';
  if (/\bopencode\b/.test(name)) return 'opencode';
  // oh-my-pi registers dynamically as "oh-my-pi"; check it before plain Pi.
  if (/\boh-my-pi\b/.test(name)) return 'oh-my-pi';
  if (/^pi\b/.test(name)) return 'pi';
  if (/\bhermes\b/.test(name)) return 'hermes';
  return 'generic';
}

/** The client as the commander UI shows it. `domain` only for metadata-document clients (verified host). */
export function connectionClient(client: OAuthClientInfo): ConnectionClient {
  return {
    name: client.name,
    kind: clientKind(client),
    ...(client.uri ? { uri: client.uri } : {}),
    ...(client.logoUri ? { logoUri: client.logoUri } : {}),
    ...(client.registration === 'cimd' ? { domain: new URL(client.id).host } : {}),
  };
}
