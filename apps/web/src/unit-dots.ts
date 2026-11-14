/**
 * Camera distances (tiles; zoom range 12–78, default view 30) where the overlay's unit dots start to fade in and are
 * fully shown, because models get small. Shared by the overlay and the audio engine (close-zoom activity loops fall
 * silent where the dots begin).
 */
export const DOTS_FROM = 48;
export const DOTS_FULL = 58;
