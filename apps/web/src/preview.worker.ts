/** Builds home-preview maps off the main thread (map generation is 150–250 ms). */
import { buildPreview, buildPreviewView } from './preview-map.ts';
import type { PreviewJob, PreviewReply } from './preview-client.ts';

/** The dedicated-worker global (the app compiles against the DOM lib, where `self` is a Window). */
const scope = self as unknown as { onmessage: ((e: MessageEvent<PreviewJob>) => void) | null; postMessage(m: PreviewReply, transfer?: Transferable[]): void };

scope.onmessage = (e) => {
  const { id, kind, options } = e.data;
  try {
    if (kind === 'view') scope.postMessage({ id, result: buildPreviewView(options) });
    else {
      const map = buildPreview(options);
      scope.postMessage({ id, result: map }, [map.terrain.buffer]);
    }
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
