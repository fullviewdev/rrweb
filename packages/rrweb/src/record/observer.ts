import { MaskInputOptions, maskInputValue, Mirror } from '@fullview/rrweb-snapshot';
import type { FontFaceSet } from 'css-font-loading-module';
import {
  throttle,
  on,
  hookSetter,
  getWindowHeight,
  getWindowWidth,
  isBlocked,
  isTouchEvent,
  patch,
  StyleSheetMirror,
} from '../utils';
import type { observerParam, MutationBufferParam } from '../types';
import {
  mutationCallBack,
  mousemoveCallBack,
  mousePosition,
  mouseInteractionCallBack,
  MouseInteractions,
  listenerHandler,
  scrollCallback,
  styleSheetRuleCallback,
  viewportResizeCallback,
  inputValue,
  inputCallback,
  hookResetter,
  IncrementalSource,
  hooksParam,
  Arguments,
  mediaInteractionCallback,
  MediaInteractions,
  canvasMutationCallback,
  fontCallback,
  fontParam,
  styleDeclarationCallback,
  IWindow,
  SelectionRange,
  selectionCallback,
} from '@rrweb/types';
import MutationBuffer from './mutation';

type WindowWithStoredMutationObserver = IWindow & {
  __rrMutationObserver?: MutationObserver;
};
type WindowWithAngularZone = IWindow & {
  Zone?: {
    __symbol__?: (key: string) => string;
  };
};

export const mutationBuffers: MutationBuffer[] = [];

const isCSSGroupingRuleSupported = typeof CSSGroupingRule !== 'undefined';
const isCSSMediaRuleSupported = typeof CSSMediaRule !== 'undefined';
const isCSSSupportsRuleSupported = typeof CSSSupportsRule !== 'undefined';
const isCSSConditionRuleSupported = typeof CSSConditionRule !== 'undefined';

// Event.path is non-standard and used in some older browsers
type NonStandardEvent = Omit<Event, 'composedPath'> & {
  path: EventTarget[];
};

function getEventTarget(event: Event | NonStandardEvent): EventTarget | null {
  try {
    if ('composedPath' in event) {
      const path = event.composedPath();
      if (path.length) {
        return path[0];
      }
    } else if ('path' in event && event.path.length) {
      return event.path[0];
    }
    return event.target;
  } catch {
    return event.target;
  }
}

export function initMutationObserver(
  options: MutationBufferParam,
  rootEl: Node,
): MutationObserver {
  const mutationBuffer = new MutationBuffer();
  mutationBuffers.push(mutationBuffer);
  // see mutation.ts for details
  mutationBuffer.init(options);
  let mutationObserverCtor =
    window.MutationObserver ||
    /**
     * Some websites may disable MutationObserver by removing it from the window object.
     * If someone is using rrweb to build a browser extention or things like it, they
     * could not change the website's code but can have an opportunity to inject some
     * code before the website executing its JS logic.
     * Then they can do this to store the native MutationObserver:
     * window.__rrMutationObserver = MutationObserver
     */
    (window as WindowWithStoredMutationObserver).__rrMutationObserver;
  const angularZoneSymbol = (window as WindowWithAngularZone)?.Zone?.__symbol__?.(
    'MutationObserver',
  );
  if (
    angularZoneSymbol &&
    ((window as unknown) as Record<string, typeof MutationObserver>)[
      angularZoneSymbol
    ]
  ) {
    mutationObserverCtor = ((window as unknown) as Record<
      string,
      typeof MutationObserver
    >)[angularZoneSymbol];
  }
  const observer = new (mutationObserverCtor as new (
    callback: MutationCallback,
  ) => MutationObserver)(mutationBuffer.processMutations.bind(mutationBuffer));
  observer.observe(rootEl, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
    childList: true,
    subtree: true,
  });
  return observer;
}

function initMoveObserver({
  mousemoveCb,
  sampling,
  doc,
  mirror,
}: observerParam): listenerHandler {
  if (sampling.mousemove === false) {
    return () => {
      //
    };
  }

  const threshold =
    typeof sampling.mousemove === 'number' ? sampling.mousemove : 50;
  const callbackThreshold =
    typeof sampling.mousemoveCallback === 'number'
      ? sampling.mousemoveCallback
      : 500;

  let positions: mousePosition[] = [];
  let timeBaseline: number | null;
  const wrappedCb = throttle(
    (
      source:
        | IncrementalSource.MouseMove
        | IncrementalSource.TouchMove
        | IncrementalSource.Drag,
    ) => {
      const totalOffset = Date.now() - timeBaseline!;
      mousemoveCb(
        positions.map((p) => {
          p.timeOffset -= totalOffset;
          return p;
        }),
        source,
      );
      positions = [];
      timeBaseline = null;
    },
    callbackThreshold,
  );
  const updatePosition = throttle<MouseEvent | TouchEvent | DragEvent>(
    (evt) => {
      const target = getEventTarget(evt);
      const { clientX, clientY } = isTouchEvent(evt)
        ? evt.changedTouches[0]
        : evt;
      if (!timeBaseline) {
        timeBaseline = Date.now();
      }
      positions.push({
        x: clientX,
        y: clientY,
        id: mirror.getId(target as Node),
        timeOffset: Date.now() - timeBaseline,
      });
      // it is possible DragEvent is undefined even on devices
      // that support event 'drag'
      wrappedCb(
        typeof DragEvent !== 'undefined' && evt instanceof DragEvent
          ? IncrementalSource.Drag
          : evt instanceof MouseEvent
          ? IncrementalSource.MouseMove
          : IncrementalSource.TouchMove,
      );
    },
    threshold,
    {
      trailing: false,
    },
  );
  const handlers = [
    on('mousemove', updatePosition, doc),
    on('touchmove', updatePosition, doc),
    on('drag', updatePosition, doc),
  ];
  return () => {
    handlers.forEach((h) => h());
  };
}

function initMouseInteractionObserver({
  mouseInteractionCb,
  doc,
  mirror,
  blockSelector,
  sampling,
}: observerParam): listenerHandler {
  if (sampling.mouseInteraction === false) {
    return () => {
      //
    };
  }
  const disableMap: Record<string, boolean | undefined> =
    sampling.mouseInteraction === true ||
    sampling.mouseInteraction === undefined
      ? {}
      : sampling.mouseInteraction;

  const handlers: listenerHandler[] = [];
  const getHandler = (eventKey: keyof typeof MouseInteractions) => {
    return (event: MouseEvent | TouchEvent) => {
      const target = getEventTarget(event) as Node;
      if (isBlocked(target, blockSelector, true)) {
        return;
      }
      const e = isTouchEvent(event) ? event.changedTouches[0] : event;
      if (!e) {
        return;
      }
      const id = mirror.getId(target);
      const { clientX, clientY } = e;
      mouseInteractionCb({
        type: MouseInteractions[eventKey],
        id,
        x: clientX,
        y: clientY,
      });
    };
  };
  Object.keys(MouseInteractions)
    .filter(
      (key) =>
        Number.isNaN(Number(key)) &&
        !key.endsWith('_Departed') &&
        disableMap[key] !== false,
    )
    .forEach((eventKey: keyof typeof MouseInteractions) => {
      const eventName = eventKey.toLowerCase();
      const handler = getHandler(eventKey);
      handlers.push(on(eventName, handler, doc));
    });
  return () => {
    handlers.forEach((h) => h());
  };
}

export function initScrollObserver({
  scrollCb,
  doc,
  mirror,
  blockSelector,
  sampling,
}: Pick<
  observerParam,
  'scrollCb' | 'doc' | 'mirror' | 'blockSelector' | 'sampling'
>): listenerHandler {
  const updatePosition = throttle<UIEvent>((evt) => {
    const target = getEventTarget(evt);
    if (!target || isBlocked(target as Node, blockSelector, true)) {
      return;
    }
    const id = mirror.getId(target as Node);
    if (target === doc) {
      const scrollEl = (doc.scrollingElement || doc.documentElement)!;
      scrollCb({
        id,
        x: scrollEl.scrollLeft,
        y: scrollEl.scrollTop,
      });
    } else {
      scrollCb({
        id,
        x: (target as HTMLElement).scrollLeft,
        y: (target as HTMLElement).scrollTop,
      });
    }
  }, sampling.scroll || 100);
  return on('scroll', updatePosition, doc);
}

function initViewportResizeObserver({
  viewportResizeCb,
}: observerParam): listenerHandler {
  let lastH = -1;
  let lastW = -1;
  const updateDimension = throttle(() => {
    const height = getWindowHeight();
    const width = getWindowWidth();
    if (lastH !== height || lastW !== width) {
      viewportResizeCb({
        width: Number(width),
        height: Number(height),
      });
      lastH = height;
      lastW = width;
    }
  }, 200);
  return on('resize', updateDimension, window);
}

function wrapEventWithUserTriggeredFlag(
  v: inputValue,
  enable: boolean,
): inputValue {
  const value = { ...v };
  if (!enable) delete value.userTriggered;
  return value;
}

export const INPUT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
const lastInputValueMap: WeakMap<EventTarget, inputValue> = new WeakMap();
function initInputObserver({
  inputCb,
  doc,
  mirror,
  blockSelector,
  ignoreClass,
  maskInputOptions,
  maskInputFn,
  sampling,
  userTriggeredOnInput,
}: observerParam): listenerHandler {
  function eventHandler(event: Event) {
    let target = getEventTarget(event);
    const userTriggered = event.isTrusted;
    /**
     * If a site changes the value 'selected' of an option element, the value of its parent element, usually a select element, will be changed as well.
     * We can treat this change as a value change of the select element the current target belongs to.
     */
    if (target && (target as Element).tagName === 'OPTION')
      target = (target as Element).parentElement;
    if (
      !target ||
      !(target as Element).tagName ||
      INPUT_TAGS.indexOf((target as Element).tagName) < 0 ||
      isBlocked(target as Node, blockSelector, true)
    ) {
      return;
    }
    const type: string | undefined = (target as HTMLInputElement).type;
    if ((target as HTMLElement).classList.contains(ignoreClass)) {
      return;
    }
    let text = (target as HTMLInputElement).value;
    let isChecked = false;
    if (type === 'radio' || type === 'checkbox') {
      isChecked = (target as HTMLInputElement).checked;
    } else if (
      maskInputOptions[
        (target as Element).tagName.toLowerCase() as keyof MaskInputOptions
      ] ||
      maskInputOptions[type as keyof MaskInputOptions]
    ) {
      text = maskInputValue({
        maskInputOptions,
        tagName: (target as HTMLElement).tagName,
        type,
        value: text,
        maskInputFn,
      });
    }
    cbWithDedup(
      target,
      wrapEventWithUserTriggeredFlag(
        { text, isChecked, userTriggered },
        userTriggeredOnInput,
      ),
    );
    // if a radio was checked
    // the other radios with the same name attribute will be unchecked.
    const name: string | undefined = (target as HTMLInputElement).name;
    if (type === 'radio' && name && isChecked) {
      doc
        .querySelectorAll(`input[type="radio"][name="${name}"]`)
        .forEach((el) => {
          if (el !== target) {
            cbWithDedup(
              el,
              wrapEventWithUserTriggeredFlag(
                {
                  text: (el as HTMLInputElement).value,
                  isChecked: !isChecked,
                  userTriggered: false,
                },
                userTriggeredOnInput,
              ),
            );
          }
        });
    }
  }
  function cbWithDedup(target: EventTarget, v: inputValue) {
    const lastInputValue = lastInputValueMap.get(target);
    if (
      !lastInputValue ||
      lastInputValue.text !== v.text ||
      lastInputValue.isChecked !== v.isChecked
    ) {
      lastInputValueMap.set(target, v);
      const id = mirror.getId(target as Node);
      inputCb({
        ...v,
        id,
      });
    }
  }
  const events = sampling.input === 'last' ? ['change'] : ['input', 'change'];
  const handlers: Array<
    listenerHandler | hookResetter
  > = events.map((eventName) => on(eventName, eventHandler, doc));
  const currentWindow = doc.defaultView;
  if (!currentWindow) {
    return () => {
      handlers.forEach((h) => h());
    };
  }
  const propertyDescriptor = currentWindow.Object.getOwnPropertyDescriptor(
    currentWindow.HTMLInputElement.prototype,
    'value',
  );
  const hookProperties: Array<[HTMLElement, string]> = [
    [currentWindow.HTMLInputElement.prototype, 'value'],
    [currentWindow.HTMLInputElement.prototype, 'checked'],
    [currentWindow.HTMLSelectElement.prototype, 'value'],
    [currentWindow.HTMLTextAreaElement.prototype, 'value'],
    // Some UI library use selectedIndex to set select value
    [currentWindow.HTMLSelectElement.prototype, 'selectedIndex'],
    [currentWindow.HTMLOptionElement.prototype, 'selected'],
  ];
  if (propertyDescriptor && propertyDescriptor.set) {
    handlers.push(
      ...hookProperties.map((p) =>
        hookSetter<HTMLElement>(
          p[0],
          p[1],
          {
            set() {
              // mock to a normal event
              eventHandler({ target: this as EventTarget } as Event);
            },
          },
          false,
          currentWindow,
        ),
      ),
    );
  }
  return () => {
    handlers.forEach((h) => h());
  };
}

type GroupingCSSRule =
  | CSSGroupingRule
  | CSSMediaRule
  | CSSSupportsRule
  | CSSConditionRule;
type GroupingCSSRuleTypes =
  | typeof CSSGroupingRule
  | typeof CSSMediaRule
  | typeof CSSSupportsRule
  | typeof CSSConditionRule;

function getNestedCSSRulePositions(rule: CSSRule): number[] {
  const positions: number[] = [];
  function recurse(childRule: CSSRule, pos: number[]) {
    if (
      (isCSSGroupingRuleSupported &&
        childRule.parentRule instanceof CSSGroupingRule) ||
      (isCSSMediaRuleSupported &&
        childRule.parentRule instanceof CSSMediaRule) ||
      (isCSSSupportsRuleSupported &&
        childRule.parentRule instanceof CSSSupportsRule) ||
      (isCSSConditionRuleSupported &&
        childRule.parentRule instanceof CSSConditionRule)
    ) {
      const rules = Array.from(
        (childRule.parentRule as GroupingCSSRule).cssRules,
      );
      const index = rules.indexOf(childRule);
      pos.unshift(index);
    } else if (childRule.parentStyleSheet) {
      const rules = Array.from(childRule.parentStyleSheet.cssRules);
      const index = rules.indexOf(childRule);
      pos.unshift(index);
    }
    return pos;
  }
  return recurse(rule, positions);
}

/**
 * For StyleSheets in Element, this function retrieves id of its host element.
 * For adopted StyleSheets, this function retrieves its styleId from a styleMirror.
 */
function getIdAndStyleId(
  sheet: CSSStyleSheet | undefined | null,
  mirror: Mirror,
  styleMirror: StyleSheetMirror,
): {
  styleId?: number;
  id?: number;
} {
  let id, styleId;
  if (!sheet) return {};
  if (sheet.ownerNode) id = mirror.getId(sheet.ownerNode as Node);
  else styleId = styleMirror.getId(sheet);
  return {
    styleId,
    id,
  };
}

function initStyleSheetObserver(
  { styleSheetRuleCb, mirror, stylesheetManager }: observerParam,
  { win }: { win: IWindow },
): listenerHandler {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const insertRule = win.CSSStyleSheet.prototype.insertRule;
  win.CSSStyleSheet.prototype.insertRule = function (
    this: CSSStyleSheet,
    rule: string,
    index?: number,
  ) {
    const { id, styleId } = getIdAndStyleId(
      this,
      mirror,
      stylesheetManager.styleMirror,
    );

    if ((id && id !== -1) || (styleId && styleId !== -1)) {
      styleSheetRuleCb({
        id,
        styleId,
        adds: [{ rule, index }],
      });
    }
    return insertRule.apply(this, [rule, index]);
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const deleteRule = win.CSSStyleSheet.prototype.deleteRule;
  win.CSSStyleSheet.prototype.deleteRule = function (
    this: CSSStyleSheet,
    index: number,
  ) {
    const { id, styleId } = getIdAndStyleId(
      this,
      mirror,
      stylesheetManager.styleMirror,
    );

    if ((id && id !== -1) || (styleId && styleId !== -1)) {
      styleSheetRuleCb({
        id,
        styleId,
        removes: [{ index }],
      });
    }
    return deleteRule.apply(this, [index]);
  };

  let replace: (text: string) => Promise<CSSStyleSheet>;
  if (win.CSSStyleSheet.prototype.replace) {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    replace = win.CSSStyleSheet.prototype.replace;
    win.CSSStyleSheet.prototype.replace = function (
      this: CSSStyleSheet,
      text: string,
    ) {
      const { id, styleId } = getIdAndStyleId(
        this,
        mirror,
        stylesheetManager.styleMirror,
      );

      if ((id && id !== -1) || (styleId && styleId !== -1)) {
        styleSheetRuleCb({
          id,
          styleId,
          replace: text,
        });
      }
      return replace.apply(this, [text]);
    };
  }

  let replaceSync: (text: string) => void;
  if (win.CSSStyleSheet.prototype.replaceSync) {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    replaceSync = win.CSSStyleSheet.prototype.replaceSync;
    win.CSSStyleSheet.prototype.replaceSync = function (
      this: CSSStyleSheet,
      text: string,
    ) {
      const { id, styleId } = getIdAndStyleId(
        this,
        mirror,
        stylesheetManager.styleMirror,
      );

      if ((id && id !== -1) || (styleId && styleId !== -1)) {
        styleSheetRuleCb({
          id,
          styleId,
          replaceSync: text,
        });
      }
      return replaceSync.apply(this, [text]);
    };
  }

  const supportedNestedCSSRuleTypes: {
    [key: string]: GroupingCSSRuleTypes;
  } = {};
  if (isCSSGroupingRuleSupported) {
    supportedNestedCSSRuleTypes.CSSGroupingRule = win.CSSGroupingRule;
  } else {
    // Some browsers (Safari) don't support CSSGroupingRule
    // https://caniuse.com/?search=cssgroupingrule
    // fall back to monkey patching classes that would have inherited from CSSGroupingRule

    if (isCSSMediaRuleSupported) {
      supportedNestedCSSRuleTypes.CSSMediaRule = win.CSSMediaRule;
    }
    if (isCSSConditionRuleSupported) {
      supportedNestedCSSRuleTypes.CSSConditionRule = win.CSSConditionRule;
    }
    if (isCSSSupportsRuleSupported) {
      supportedNestedCSSRuleTypes.CSSSupportsRule = win.CSSSupportsRule;
    }
  }

  const unmodifiedFunctions: {
    [key: string]: {
      insertRule: (rule: string, index?: number) => number;
      deleteRule: (index: number) => void;
    };
  } = {};

  Object.entries(supportedNestedCSSRuleTypes).forEach(([typeKey, type]) => {
    unmodifiedFunctions[typeKey] = {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      insertRule: type.prototype.insertRule,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      deleteRule: type.prototype.deleteRule,
    };

    type.prototype.insertRule = function (
      this: CSSGroupingRule,
      rule: string,
      index?: number,
    ) {
      const { id, styleId } = getIdAndStyleId(
        this.parentStyleSheet,
        mirror,
        stylesheetManager.styleMirror,
      );

      if ((id && id !== -1) || (styleId && styleId !== -1)) {
        styleSheetRuleCb({
          id,
          styleId,
          adds: [
            {
              rule,
              index: [
                ...getNestedCSSRulePositions(this as CSSRule),
                index || 0, // defaults to 0
              ],
            },
          ],
        });
      }
      return unmodifiedFunctions[typeKey].insertRule.apply(this, [rule, index]);
    };

    type.prototype.deleteRule = function (
      this: CSSGroupingRule,
      index: number,
    ) {
      const { id, styleId } = getIdAndStyleId(
        this.parentStyleSheet,
        mirror,
        stylesheetManager.styleMirror,
      );

      if ((id && id !== -1) || (styleId && styleId !== -1)) {
        styleSheetRuleCb({
          id,
          styleId,
          removes: [
            { index: [...getNestedCSSRulePositions(this as CSSRule), index] },
          ],
        });
      }
      return unmodifiedFunctions[typeKey].deleteRule.apply(this, [index]);
    };
  });

  return () => {
    win.CSSStyleSheet.prototype.insertRule = insertRule;
    win.CSSStyleSheet.prototype.deleteRule = deleteRule;
    replace && (win.CSSStyleSheet.prototype.replace = replace);
    replaceSync && (win.CSSStyleSheet.prototype.replaceSync = replaceSync);
    Object.entries(supportedNestedCSSRuleTypes).forEach(([typeKey, type]) => {
      type.prototype.insertRule = unmodifiedFunctions[typeKey].insertRule;
      type.prototype.deleteRule = unmodifiedFunctions[typeKey].deleteRule;
    });
  };
}

export function initAdoptedStyleSheetObserver(
  {
    mirror,
    stylesheetManager,
  }: Pick<observerParam, 'mirror' | 'stylesheetManager'>,
  host: Document | ShadowRoot,
): listenerHandler {
  let hostId: number | null = null;
  // host of adoptedStyleSheets is outermost document or IFrame's document
  if (host.nodeName === '#document') hostId = mirror.getId(host);
  // The host is a ShadowRoot.
  else hostId = mirror.getId((host as ShadowRoot).host);

  const patchTarget =
    host.nodeName === '#document'
      ? (host as Document).defaultView?.Document
      : host.ownerDocument?.defaultView?.ShadowRoot;
  const originalPropertyDescriptor = Object.getOwnPropertyDescriptor(
    patchTarget?.prototype,
    'adoptedStyleSheets',
  );
  if (
    hostId === null ||
    hostId === -1 ||
    !patchTarget ||
    !originalPropertyDescriptor
  )
    return () => {
      //
    };

  // Patch adoptedStyleSheets by overriding the original one.
  Object.defineProperty(host, 'adoptedStyleSheets', {
    configurable: originalPropertyDescriptor.configurable,
    enumerable: originalPropertyDescriptor.enumerable,
    get(): CSSStyleSheet[] {
      return originalPropertyDescriptor.get?.call(this) as CSSStyleSheet[];
    },
    set(sheets: CSSStyleSheet[]) {
      const result = originalPropertyDescriptor.set?.call(this, sheets);
      if (hostId !== null && hostId !== -1) {
        try {
          stylesheetManager.adoptStyleSheets(sheets, hostId);
        } catch (e) {
          // for safety
        }
      }
      return result;
    },
  });

  return () => {
    Object.defineProperty(host, 'adoptedStyleSheets', {
      configurable: originalPropertyDescriptor.configurable,
      enumerable: originalPropertyDescriptor.enumerable,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      get: originalPropertyDescriptor.get,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      set: originalPropertyDescriptor.set,
    });
  };
}

function initStyleDeclarationObserver(
  {
    styleDeclarationCb,
    mirror,
    ignoreCSSAttributes,
    stylesheetManager,
  }: observerParam,
  { win }: { win: IWindow },
): listenerHandler {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setProperty = win.CSSStyleDeclaration.prototype.setProperty;
  win.CSSStyleDeclaration.prototype.setProperty = function (
    this: CSSStyleDeclaration,
    property: string,
    value: string,
    priority: string,
  ) {
    // ignore this mutation if we do not care about this css attribute
    if (ignoreCSSAttributes.has(property)) {
      return setProperty.apply(this, [property, value, priority]);
    }
    const { id, styleId } = getIdAndStyleId(
      this.parentRule?.parentStyleSheet,
      mirror,
      stylesheetManager.styleMirror,
    );
    if ((id && id !== -1) || (styleId && styleId !== -1)) {
      styleDeclarationCb({
        id,
        styleId,
        set: {
          property,
          value,
          priority,
        },
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        index: getNestedCSSRulePositions(this.parentRule!),
      });
    }
    return setProperty.apply(this, [property, value, priority]);
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const removeProperty = win.CSSStyleDeclaration.prototype.removeProperty;
  win.CSSStyleDeclaration.prototype.removeProperty = function (
    this: CSSStyleDeclaration,
    property: string,
  ) {
    // ignore this mutation if we do not care about this css attribute
    if (ignoreCSSAttributes.has(property)) {
      return removeProperty.apply(this, [property]);
    }
    const { id, styleId } = getIdAndStyleId(
      this.parentRule?.parentStyleSheet,
      mirror,
      stylesheetManager.styleMirror,
    );
    if ((id && id !== -1) || (styleId && styleId !== -1)) {
      styleDeclarationCb({
        id,
        styleId,
        remove: {
          property,
        },
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        index: getNestedCSSRulePositions(this.parentRule!),
      });
    }
    return removeProperty.apply(this, [property]);
  };

  return () => {
    win.CSSStyleDeclaration.prototype.setProperty = setProperty;
    win.CSSStyleDeclaration.prototype.removeProperty = removeProperty;
  };
}

function initMediaInteractionObserver({
  mediaInteractionCb,
  blockSelector,
  mirror,
  sampling,
}: observerParam): listenerHandler {
  const handler = (type: MediaInteractions) =>
    throttle((event: Event) => {
      const target = getEventTarget(event);
      if (
        !target ||
        isBlocked(target as Node, blockSelector, true)
      ) {
        return;
      }
      const {
        currentTime,
        volume,
        muted,
        playbackRate,
      } = target as HTMLMediaElement;
      mediaInteractionCb({
        type,
        id: mirror.getId(target as Node),
        currentTime,
        volume,
        muted,
        playbackRate,
      });
    }, sampling.media || 500);
  const handlers = [
    on('play', handler(MediaInteractions.Play)),
    on('pause', handler(MediaInteractions.Pause)),
    on('seeked', handler(MediaInteractions.Seeked)),
    on('volumechange', handler(MediaInteractions.VolumeChange)),
    on('ratechange', handler(MediaInteractions.RateChange)),
  ];
  return () => {
    handlers.forEach((h) => h());
  };
}

function initFontObserver({ fontCb, doc }: observerParam): listenerHandler {
  const win = doc.defaultView as IWindow;
  if (!win) {
    return () => {
      //
    };
  }

  const handlers: listenerHandler[] = [];

  const fontMap = new WeakMap<FontFace, fontParam>();

  const originalFontFace = win.FontFace;
  win.FontFace = (function FontFace(
    family: string,
    source: string | ArrayBufferLike,
    descriptors?: FontFaceDescriptors,
  ) {
    const fontFace = new originalFontFace(family, source, descriptors);
    fontMap.set(fontFace, {
      family,
      buffer: typeof source !== 'string',
      descriptors,
      fontSource:
        typeof source === 'string'
          ? source
          : JSON.stringify(Array.from(new Uint8Array(source))),
    });
    return fontFace;
  } as unknown) as typeof FontFace;

  const restoreHandler = patch(
    doc.fonts,
    'add',
    function (original: (font: FontFace) => void) {
      return function (this: FontFaceSet, fontFace: FontFace) {
        setTimeout(() => {
          const p = fontMap.get(fontFace);
          if (p) {
            fontCb(p);
            fontMap.delete(fontFace);
          }
        }, 0);
        return original.apply(this, [fontFace]);
      };
    },
  );

  handlers.push(() => {
    win.FontFace = originalFontFace;
  });
  handlers.push(restoreHandler);

  return () => {
    handlers.forEach((h) => h());
  };
}

function initSelectionObserver(param: observerParam): listenerHandler {
  const { doc, mirror, blockClass, blockSelector, selectionCb } = param;
  let collapsed = true;

  const updateSelection = () => {
    const selection = doc.getSelection();

    if (!selection || (collapsed && selection?.isCollapsed)) return;

    collapsed = selection.isCollapsed || false;

    const ranges: SelectionRange[] = [];
    const count = selection.rangeCount || 0;

    for (let i = 0; i < count; i++) {
      const range = selection.getRangeAt(i);

      const { startContainer, startOffset, endContainer, endOffset } = range;

      const blocked =
        isBlocked(startContainer, blockSelector, true) ||
        isBlocked(endContainer, blockSelector, true);

      if (blocked) continue;

      ranges.push({
        start: mirror.getId(startContainer),
        startOffset,
        end: mirror.getId(endContainer),
        endOffset,
      });
    }

    selectionCb({ ranges });
  };

  updateSelection();

  return on('selectionchange', updateSelection);
}

function mergeHooks(o: observerParam, hooks: hooksParam) {
  const {
    mutationCb,
    mousemoveCb,
    mouseInteractionCb,
    scrollCb,
    viewportResizeCb,
    inputCb,
    mediaInteractionCb,
    styleSheetRuleCb,
    styleDeclarationCb,
    canvasMutationCb,
    fontCb,
    selectionCb,
  } = o;
  o.mutationCb = (...p: Arguments<mutationCallBack>) => {
    if (hooks.mutation) {
      hooks.mutation(...p);
    }
    mutationCb(...p);
  };
  o.mousemoveCb = (...p: Arguments<mousemoveCallBack>) => {
    if (hooks.mousemove) {
      hooks.mousemove(...p);
    }
    mousemoveCb(...p);
  };
  o.mouseInteractionCb = (...p: Arguments<mouseInteractionCallBack>) => {
    if (hooks.mouseInteraction) {
      hooks.mouseInteraction(...p);
    }
    mouseInteractionCb(...p);
  };
  o.scrollCb = (...p: Arguments<scrollCallback>) => {
    if (hooks.scroll) {
      hooks.scroll(...p);
    }
    scrollCb(...p);
  };
  o.viewportResizeCb = (...p: Arguments<viewportResizeCallback>) => {
    if (hooks.viewportResize) {
      hooks.viewportResize(...p);
    }
    viewportResizeCb(...p);
  };
  o.inputCb = (...p: Arguments<inputCallback>) => {
    if (hooks.input) {
      hooks.input(...p);
    }
    inputCb(...p);
  };
  o.mediaInteractionCb = (...p: Arguments<mediaInteractionCallback>) => {
    if (hooks.mediaInteaction) {
      hooks.mediaInteaction(...p);
    }
    mediaInteractionCb(...p);
  };
  o.styleSheetRuleCb = (...p: Arguments<styleSheetRuleCallback>) => {
    if (hooks.styleSheetRule) {
      hooks.styleSheetRule(...p);
    }
    styleSheetRuleCb(...p);
  };
  o.styleDeclarationCb = (...p: Arguments<styleDeclarationCallback>) => {
    if (hooks.styleDeclaration) {
      hooks.styleDeclaration(...p);
    }
    styleDeclarationCb(...p);
  };
  o.canvasMutationCb = (...p: Arguments<canvasMutationCallback>) => {
    if (hooks.canvasMutation) {
      hooks.canvasMutation(...p);
    }
    canvasMutationCb(...p);
  };
  o.fontCb = (...p: Arguments<fontCallback>) => {
    if (hooks.font) {
      hooks.font(...p);
    }
    fontCb(...p);
  };
  o.selectionCb = (...p: Arguments<selectionCallback>) => {
    if (hooks.selection) {
      hooks.selection(...p);
    }
    selectionCb(...p);
  };
}

export function initObservers(
  o: observerParam,
  hooks: hooksParam = {},
): listenerHandler {
  const currentWindow = o.doc.defaultView; // basically document.window
  if (!currentWindow) {
    return () => {
      //
    };
  }

  mergeHooks(o, hooks);
  const mutationObserver = initMutationObserver(o, o.doc);
  const mousemoveHandler = initMoveObserver(o);
  const mouseInteractionHandler = initMouseInteractionObserver(o);
  const scrollHandler = initScrollObserver(o);
  const viewportResizeHandler = initViewportResizeObserver(o);
  const inputHandler = initInputObserver(o);
  const mediaInteractionHandler = initMediaInteractionObserver(o);

  const styleSheetObserver = initStyleSheetObserver(o, { win: currentWindow });
  const adoptedStyleSheetObserver = initAdoptedStyleSheetObserver(o, o.doc);
  const styleDeclarationObserver = initStyleDeclarationObserver(o, {
    win: currentWindow,
  });
  const fontObserver = o.collectFonts
    ? initFontObserver(o)
    : () => {
        //
      };
  const selectionObserver = initSelectionObserver(o);

  // plugins
  const pluginHandlers: listenerHandler[] = [];
  for (const plugin of o.plugins) {
    pluginHandlers.push(
      plugin.observer(plugin.callback, currentWindow, plugin.options),
    );
  }

  return () => {
    mutationBuffers.forEach((b) => b.reset());
    mutationObserver.disconnect();
    mousemoveHandler();
    mouseInteractionHandler();
    scrollHandler();
    viewportResizeHandler();
    inputHandler();
    mediaInteractionHandler();
    styleSheetObserver();
    adoptedStyleSheetObserver();
    styleDeclarationObserver();
    fontObserver();
    selectionObserver();
    pluginHandlers.forEach((h) => h());
  };
}
