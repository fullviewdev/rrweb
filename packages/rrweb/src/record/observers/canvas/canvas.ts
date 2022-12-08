import type { ICanvas } from '@fullview/rrweb-snapshot';
import type { IWindow, listenerHandler } from '@rrweb/types';
import { isBlocked, patch } from '../../../utils';

export default function initCanvasContextObserver(
  win: IWindow,
  blockSelector?: string,
): listenerHandler {
  const handlers: listenerHandler[] = [];
  try {
    const restoreHandler = patch(
      win.HTMLCanvasElement.prototype,
      'getContext',
      function (
        original: (
          this: ICanvas,
          contextType: string,
          ...args: Array<unknown>
        ) => void,
      ) {
        return function (
          this: ICanvas,
          contextType: string,
          ...args: Array<unknown>
        ) {
          if (!isBlocked(this, blockSelector, true)) {
            if (!('__context' in this)) this.__context = contextType;
          }
          return original.apply(this, [contextType, ...args]);
        };
      },
    );
    handlers.push(restoreHandler);
  } catch {
    console.error('failed to patch HTMLCanvasElement.prototype.getContext');
  }
  return () => {
    handlers.forEach((h) => h());
  };
}
