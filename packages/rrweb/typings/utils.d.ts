<<<<<<< HEAD
import { throttleOptions, listenerHandler, hookResetter, blockClass, addedNodeMutation, removedNodeMutation, textMutation, attributeMutation, mutationData, scrollData, inputData, DocumentDimension, IWindow, DeprecatedMirror, eventWithTime } from './types';
import { Mirror } from 'rrweb-snapshot';
=======
import type { throttleOptions, listenerHandler, hookResetter, blockClass, addedNodeMutation, DocumentDimension, IWindow, DeprecatedMirror, textMutation } from './types';
import type { IMirror, Mirror } from 'rrweb-snapshot';
import type { RRNode, RRIFrameElement } from 'rrdom';
>>>>>>> af8ed5513c359b7cda786659514a27bc1346448a
export declare function on(type: string, fn: EventListenerOrEventListenerObject, target?: Document | IWindow): listenerHandler;
export declare let _mirror: DeprecatedMirror;
export declare function throttle<T>(func: (arg: T) => void, wait: number, options?: throttleOptions): (arg: T) => void;
export declare function hookSetter<T>(target: T, key: string | number | symbol, d: PropertyDescriptor, isRevoked?: boolean, win?: Window & typeof globalThis): hookResetter;
export declare function patch(source: {
    [key: string]: any;
}, name: string, replacement: (...args: any[]) => any): () => void;
export declare function getWindowHeight(): number;
export declare function getWindowWidth(): number;
<<<<<<< HEAD
export declare function isBlocked(node: Node | null, blockClass: blockClass): boolean;
=======
export declare function isBlocked(node: Node | null, blockClass: blockClass, checkAncestors: boolean): boolean;
>>>>>>> af8ed5513c359b7cda786659514a27bc1346448a
export declare function isSerialized(n: Node, mirror: Mirror): boolean;
export declare function isIgnored(n: Node, mirror: Mirror): boolean;
export declare function isAncestorRemoved(target: Node, mirror: Mirror): boolean;
export declare function isTouchEvent(event: MouseEvent | TouchEvent): event is TouchEvent;
export declare function polyfill(win?: Window & typeof globalThis): void;
declare type ResolveTree = {
    value: addedNodeMutation;
    children: ResolveTree[];
    parent: ResolveTree | null;
};
export declare function queueToResolveTrees(queue: addedNodeMutation[]): ResolveTree[];
export declare function iterateResolveTree(tree: ResolveTree, cb: (mutation: addedNodeMutation) => unknown): void;
export declare type AppendedIframe = {
    mutationInQueue: addedNodeMutation;
    builtNode: HTMLIFrameElement | RRIFrameElement;
};
export declare function isSerializedIframe<TNode extends Node | RRNode>(n: TNode, mirror: IMirror<TNode>): boolean;
export declare function getBaseDimension(node: Node, rootIframe: Node): DocumentDimension;
export declare function hasShadowRoot<T extends Node | RRNode>(n: T): n is T & {
    shadowRoot: ShadowRoot;
};
<<<<<<< HEAD
export declare function isUserInteraction(event: eventWithTime): boolean;
=======
export declare function getNestedRule(rules: CSSRuleList, position: number[]): CSSGroupingRule;
export declare function getPositionsAndIndex(nestedIndex: number[]): {
    positions: number[];
    index: number | undefined;
};
export declare function uniqueTextMutations(mutations: textMutation[]): textMutation[];
>>>>>>> af8ed5513c359b7cda786659514a27bc1346448a
export {};
