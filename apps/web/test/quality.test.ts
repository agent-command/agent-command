import { describe, expect, it } from 'vitest';
import { QUALITY, backendChoice, qualityTier } from '../src/world/quality.ts';

const query = (search: string) => new URLSearchParams(search);

describe('render quality tier', () => {
  it('gives phones the phone tier and everything else the full tier', () => {
    expect(qualityTier(query(''), true)).toBe('phone');
    expect(qualityTier(query(''), false)).toBe('full');
  });
  it('lets ?quality override either way', () => {
    expect(qualityTier(query('?quality=full'), true)).toBe('full');
    expect(qualityTier(query('?quality=phone'), false)).toBe('phone');
    expect(qualityTier(query('?quality=ultra'), true)).toBe('phone');
  });
  it('cuts pixels and passes on phones', () => {
    const { phone, full } = QUALITY;
    expect(phone.maxPixelRatio).toBeLessThanOrEqual(1.25);
    expect(phone.msaa).toBe(false);
    expect(phone.bloom).toBe(false);
    expect(phone.stormScale).toBeLessThan(full.stormScale);
    expect(full).toMatchObject({ maxPixelRatio: 1.75, msaa: true, bloom: true, grain: true, stormScale: 0.5 });
  });
});

describe('backend choice', () => {
  it('defaults to WebGPU where it exists and takes ?renderer both ways', () => {
    expect(backendChoice(query(''), true)).toBe('webgpu');
    expect(backendChoice(query('?renderer=webgl'), true)).toBe('webgl');
    expect(backendChoice(query('?renderer=webgpu'), true)).toBe('webgpu');
  });
  it('falls back to WebGL2 without navigator.gpu, whatever was asked', () => {
    expect(backendChoice(query('?renderer=webgpu'), false)).toBe('webgl');
    expect(backendChoice(query(''), false)).toBe('webgl');
  });
});
