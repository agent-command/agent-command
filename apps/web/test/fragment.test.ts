import { describe, expect, it } from 'vitest';
import { fragmentFor, parseFragment } from '../src/net.ts';

const TOKEN = 'xvKhKNHqXlSgBphL9CmvsLnwk-9DSaqu';

describe('join fragment', () => {
  it('round-trips the #r=…&t=… form the client writes', () => {
    expect(parseFragment(`#${fragmentFor('e1_7VOoqt', TOKEN)}`)).toEqual({ roomId: 'e1_7VOoqt', token: TOKEN });
  });

  it('rejects removed room/token aliases', () => {
    expect(parseFragment(`#room=abc123&token=${TOKEN}`)).toBeUndefined();
  });

  it('rejects anything that is not an opaque 32-char base64url token', () => {
    expect(parseFragment(`#r=abc&t=${TOKEN.slice(1)}`)).toBeUndefined();
    expect(parseFragment(`#r=abc&t=${TOKEN.slice(1)}!`)).toBeUndefined();
    expect(parseFragment(`#r=abc&t=${TOKEN}${TOKEN}`)).toBeUndefined();
  });

  it('rejects room ids with path or query characters', () => {
    expect(parseFragment(`#r=../matchmake&t=${TOKEN}`)).toBeUndefined();
    expect(parseFragment(`#r=a%2Fb&t=${TOKEN}`)).toBeUndefined();
    expect(parseFragment('#r=abc')).toBeUndefined();
    expect(parseFragment('')).toBeUndefined();
  });
});
