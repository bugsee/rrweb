import type { Mirror } from 'rrweb-snapshot';
import { genId } from 'rrweb-snapshot';
import type { CrossOriginIframeMessageEvent } from '../types';
import CrossOriginIframeMirror from './cross-origin-iframe-mirror';
import { EventType, NodeType, IncrementalSource } from '@rrweb/types';
import type {
  eventWithTime,
  eventWithoutTime,
  serializedNodeWithId,
  mutationCallBack,
  listenerHandler,
  IWindow,
} from '@rrweb/types';
import type { StylesheetManager } from './stylesheet-manager';
import { on } from '../utils';

export class IframeManager {
  private iframes: WeakMap<HTMLIFrameElement, true> = new WeakMap();
  private crossOriginIframeMap: WeakMap<MessageEventSource, HTMLIFrameElement> =
    new WeakMap();
  public crossOriginIframeMirror = new CrossOriginIframeMirror(genId);
  public crossOriginIframeStyleMirror: CrossOriginIframeMirror;
  public crossOriginIframeRootIdMap: WeakMap<HTMLIFrameElement, number> =
    new WeakMap();
  private mirror: Mirror;
  private mutationCb: mutationCallBack;
  private wrappedEmit: (e: eventWithoutTime, isCheckout?: boolean) => void;
  private loadListener?: (iframeEl: HTMLIFrameElement) => unknown;
  private unloadListener?: (doc: Document) => unknown;
  // Windows of attached same-origin iframes, with the handler that stops listening to them.
  private attachedWindows: Map<Window, listenerHandler> = new Map();
  // One handler for all windows, so that attaching an iframe again (e.g. on every full snapshot) doesn't add another.
  private messageHandler = (message: Event) =>
    this.handleMessage(message as MessageEvent);
  private stylesheetManager: StylesheetManager;
  private recordCrossOriginIframes: boolean;
  private isIframeBlocked: (iframeEl: HTMLIFrameElement) => boolean;
  // The iframe element whose same-origin document is being recorded, by document.
  private docOwners: WeakMap<Document, HTMLIFrameElement> = new WeakMap();
  // Documents whose recording was released because their iframe became blocked. They stay gated, even if the
  // iframe is unblocked again, until a new full snapshot attaches them again: resuming mid-stream would leave
  // a hole (and the observers that would resume are gone).
  private releasedDocs: WeakSet<Document> = new WeakSet();
  // The iframes that are being recorded right now (attached, not released). Only used to react to the block
  // state of an iframe, or of one of its containers, changing; empty (so free) when nothing is attached.
  private attachedIframes: Set<HTMLIFrameElement> = new Set();
  // The document being recorded: never gated, whatever frame it happens to be embedded in.
  private rootDocument: Document;

  constructor(options: {
    mirror: Mirror;
    mutationCb: mutationCallBack;
    stylesheetManager: StylesheetManager;
    recordCrossOriginIframes: boolean;
    wrappedEmit: (e: eventWithoutTime, isCheckout?: boolean) => void;
    /** Whether an iframe element itself is blocked (a blocked iframe is never recorded). Defaults to never. */
    isIframeBlocked?: (iframeEl: HTMLIFrameElement) => boolean;
    /** The recorded (top) document. Defaults to the global `document`. */
    rootDocument?: Document;
  }) {
    this.rootDocument = options.rootDocument ?? document;
    this.isIframeBlocked = options.isIframeBlocked ?? (() => false);
    this.mutationCb = options.mutationCb;
    this.wrappedEmit = options.wrappedEmit;
    this.stylesheetManager = options.stylesheetManager;
    this.recordCrossOriginIframes = options.recordCrossOriginIframes;
    this.crossOriginIframeStyleMirror = new CrossOriginIframeMirror(
      this.stylesheetManager.styleMirror.generateId.bind(
        this.stylesheetManager.styleMirror,
      ),
    );
    this.mirror = options.mirror;
    if (this.recordCrossOriginIframes) {
      window.addEventListener('message', this.messageHandler);
    }
  }

  /** The iframe element a same-origin document lives in, whether or not it was attached to the recording. */
  private ownerOf(doc: Document): HTMLIFrameElement | undefined {
    if (doc === this.rootDocument) return undefined;
    const registered = this.docOwners.get(doc);
    if (registered) return registered;
    try {
      const frame = doc.defaultView?.frameElement;
      return frame && frame.nodeName === 'IFRAME'
        ? (frame as HTMLIFrameElement)
        : undefined;
    } catch {
      return undefined; // a cross-origin parent
    }
  }

  /**
   * Whether the iframe, or any iframe it is nested in, is blocked. Evaluated against the live DOM every time,
   * so an iframe that became blocked after it was first recorded is caught too.
   */
  public isBlocked(iframeEl: HTMLIFrameElement): boolean {
    let el: HTMLIFrameElement | undefined = iframeEl;
    while (el) {
      if (this.isIframeBlocked(el)) return true;
      el = this.ownerOf(el.ownerDocument);
    }
    return false;
  }

  /**
   * Whether `doc` is the document of an iframe that is (now) blocked, attached to the recording or not. If so
   * the recording of that iframe is released here and the caller must drop whatever it was about to emit. The
   * recorded document and documents of iframes that are not blocked are never affected.
   */
  public isDocBlocked(doc: Document): boolean {
    if (this.releasedDocs.has(doc)) return true;
    const owner = this.ownerOf(doc);
    if (!owner || !this.isBlocked(owner)) return false;
    this.releaseIframe(owner);
    this.releasedDocs.add(doc);
    return true;
  }

  /** The id of the document of the iframe `nodeId`, or of the node itself if it is a document: blocked or not. */
  public isNodeDocBlocked(nodeId: number): boolean {
    const node = this.mirror.getNode(nodeId);
    if (!node) return false;
    const doc =
      node.nodeType === Node.DOCUMENT_NODE
        ? (node as Document)
        : node.ownerDocument;
    return doc ? this.isDocBlocked(doc) : false;
  }

  /**
   * An attribute of `target` changed and `target` is blocked or unchanged for rrweb's purposes: if it is an
   * attached iframe that is now blocked, or contains one, stop recording those iframes at once and say so with a
   * placeholder marker (`rr_width`/`rr_height`) on the iframe, so the stream shows the iframe turned into a
   * placeholder. (`Node.contains` includes the node itself.) Free when no iframe is attached.
   */
  public releaseBlockedIframes(target: Node) {
    for (const iframeEl of [...this.attachedIframes]) {
      if (!iframeEl.isConnected) {
        this.attachedIframes.delete(iframeEl);
      } else if (target.contains(iframeEl) && this.isBlocked(iframeEl)) {
        this.releaseIframe(iframeEl);
      }
    }
  }

  /** Stops recording an attached iframe and emits the placeholder marker for it. */
  private releaseIframe(iframeEl: HTMLIFrameElement) {
    const wasAttached = this.attachedIframes.has(iframeEl);
    this.detachIframe(iframeEl);
    const id = this.mirror.getId(iframeEl);
    if (!wasAttached || id === -1) return;
    let size = { width: 0, height: 0 };
    try {
      size = iframeEl.getBoundingClientRect();
    } catch {
      // keep the zero size
    }
    this.mutationCb({
      adds: [],
      removes: [],
      texts: [],
      attributes: [
        {
          id,
          attributes: {
            rr_width: `${size.width}px`,
            rr_height: `${size.height}px`,
          },
        },
      ],
    });
  }

  /** Stops recording an attached iframe (observers, shadow roots, window listeners, message routing). */
  public detachIframe(iframeEl: HTMLIFrameElement) {
    this.attachedIframes.delete(iframeEl);
    const win = iframeEl.contentWindow;
    let doc: Document | null = null;
    try {
      doc = iframeEl.contentDocument;
    } catch {
      // navigated to a cross-origin page
    }
    if (win) {
      this.crossOriginIframeMap.delete(win);
      const stop = this.attachedWindows.get(win);
      if (stop) stop();
    }
    if (doc) {
      this.releasedDocs.add(doc);
      this.unloadListener?.(doc);
    }
  }

  public addIframe(iframeEl: HTMLIFrameElement) {
    if (this.isBlocked(iframeEl)) return;
    this.iframes.set(iframeEl, true);
    if (iframeEl.contentWindow)
      this.crossOriginIframeMap.set(iframeEl.contentWindow, iframeEl);
  }

  public addLoadListener(cb: (iframeEl: HTMLIFrameElement) => unknown) {
    this.loadListener = cb;
  }

  public addUnloadListener(cb: (doc: Document) => unknown) {
    this.unloadListener = cb;
  }

  /**
   * Attach the serialized document of a same-origin iframe. Returns whether the iframe was accepted: a blocked
   * iframe (or one nested in a blocked iframe) is refused, and nothing may be observed in it.
   */
  public attachIframe(
    iframeEl: HTMLIFrameElement,
    childSn: serializedNodeWithId,
  ): boolean {
    // Defence in depth: the snapshot already refuses to serialize a blocked iframe's document.
    if (this.isBlocked(iframeEl)) return false;
    this.attachedIframes.add(iframeEl);
    if (iframeEl.contentDocument) {
      this.docOwners.set(iframeEl.contentDocument, iframeEl);
      this.releasedDocs.delete(iframeEl.contentDocument);
    }
    this.mutationCb({
      adds: [
        {
          parentId: this.mirror.getId(iframeEl),
          nextId: null,
          node: childSn,
        },
      ],
      removes: [],
      texts: [],
      attributes: [],
      isAttachIframe: true,
    });

    this.watchIframeWindow(iframeEl);

    this.loadListener?.(iframeEl);

    if (
      iframeEl.contentDocument &&
      iframeEl.contentDocument.adoptedStyleSheets &&
      iframeEl.contentDocument.adoptedStyleSheets.length > 0
    )
      this.stylesheetManager.adoptStyleSheets(
        iframeEl.contentDocument.adoptedStyleSheets,
        this.mirror.getId(iframeEl.contentDocument),
      );
    return true;
  }

  public destroy() {
    window.removeEventListener('message', this.messageHandler);
    this.attachedWindows.forEach((stop) => stop());
  }

  private watchIframeWindow(iframeEl: HTMLIFrameElement) {
    const win = iframeEl.contentWindow as IWindow | null;
    if (!win || this.attachedWindows.has(win)) return;
    const handlers: listenerHandler[] = [];
    const stop = () => {
      this.attachedWindows.delete(win);
      handlers.forEach((handler) => {
        try {
          handler();
        } catch {
          // the iframe may have navigated to a cross-origin page by now
        }
      });
    };
    this.attachedWindows.set(win, stop);

    // Receive messages (events) coming from cross-origin iframes that are nested in this same-origin iframe.
    if (this.recordCrossOriginIframes) {
      handlers.push(on('message', this.messageHandler, win));
    }
    handlers.push(
      on(
        'pagehide',
        (event) => {
          // A persisted page is kept in the back/forward cache and may be shown again.
          if ((event as PageTransitionEvent).persisted) return;
          const doc = win.document;
          stop();
          this.unloadListener?.(doc);
        },
        win,
      ),
    );
  }

  private handleMessage(message: MessageEvent | CrossOriginIframeMessageEvent) {
    const crossOriginMessageEvent = message as CrossOriginIframeMessageEvent;
    if (
      crossOriginMessageEvent.data.type !== 'rrweb' ||
      // To filter out the rrweb messages which are forwarded by some sites.
      crossOriginMessageEvent.origin !== crossOriginMessageEvent.data.origin
    )
      return;

    const iframeSourceWindow = message.source;
    if (!iframeSourceWindow) return;

    const iframeEl = this.crossOriginIframeMap.get(message.source);
    if (!iframeEl) return;
    // a blocked iframe (or one nested in a blocked iframe) can't inject events either
    if (this.isBlocked(iframeEl)) return;

    const transformedEvent = this.transformCrossOriginEvent(
      iframeEl,
      crossOriginMessageEvent.data.event,
    );

    if (transformedEvent)
      this.wrappedEmit(
        transformedEvent,
        crossOriginMessageEvent.data.isCheckout,
      );
  }

  private transformCrossOriginEvent(
    iframeEl: HTMLIFrameElement,
    e: eventWithTime,
  ): eventWithTime | false {
    switch (e.type) {
      case EventType.FullSnapshot: {
        this.crossOriginIframeMirror.reset(iframeEl);
        this.crossOriginIframeStyleMirror.reset(iframeEl);
        /**
         * Replaces the original id of the iframe with a new set of unique ids
         */
        this.replaceIdOnNode(e.data.node, iframeEl);
        const rootId = e.data.node.id;
        this.crossOriginIframeRootIdMap.set(iframeEl, rootId);
        this.patchRootIdOnNode(e.data.node, rootId);
        return {
          timestamp: e.timestamp,
          type: EventType.IncrementalSnapshot,
          data: {
            source: IncrementalSource.Mutation,
            adds: [
              {
                parentId: this.mirror.getId(iframeEl),
                nextId: null,
                node: e.data.node,
              },
            ],
            removes: [],
            texts: [],
            attributes: [],
            isAttachIframe: true,
          },
        };
      }
      case EventType.Meta:
      case EventType.Load:
      case EventType.DomContentLoaded: {
        return false;
      }
      case EventType.Annotation:
      case EventType.Plugin: {
        return e;
      }
      case EventType.Custom: {
        this.replaceIds(
          e.data.payload as {
            id?: unknown;
            parentId?: unknown;
            previousId?: unknown;
            nextId?: unknown;
          },
          iframeEl,
          ['id', 'parentId', 'previousId', 'nextId'],
        );
        return e;
      }
      case EventType.IncrementalSnapshot: {
        switch (e.data.source) {
          case IncrementalSource.Mutation: {
            e.data.adds.forEach((n) => {
              this.replaceIds(n, iframeEl, [
                'parentId',
                'nextId',
                'previousId',
              ]);
              this.replaceIdOnNode(n.node, iframeEl);
              const rootId = this.crossOriginIframeRootIdMap.get(iframeEl);
              rootId && this.patchRootIdOnNode(n.node, rootId);
            });
            e.data.removes.forEach((n) => {
              this.replaceIds(n, iframeEl, ['parentId', 'id']);
            });
            e.data.attributes.forEach((n) => {
              this.replaceIds(n, iframeEl, ['id']);
            });
            e.data.texts.forEach((n) => {
              this.replaceIds(n, iframeEl, ['id']);
            });
            return e;
          }
          case IncrementalSource.Drag:
          case IncrementalSource.TouchMove:
          case IncrementalSource.MouseMove: {
            e.data.positions.forEach((p) => {
              this.replaceIds(p, iframeEl, ['id']);
            });
            return e;
          }
          case IncrementalSource.ViewportResize: {
            // can safely ignore these events
            return false;
          }
          case IncrementalSource.MediaInteraction:
          case IncrementalSource.MouseInteraction:
          case IncrementalSource.Scroll:
          case IncrementalSource.CanvasMutation:
          case IncrementalSource.Input: {
            this.replaceIds(e.data, iframeEl, ['id']);
            return e;
          }
          case IncrementalSource.StyleSheetRule:
          case IncrementalSource.StyleDeclaration: {
            this.replaceIds(e.data, iframeEl, ['id']);
            this.replaceStyleIds(e.data, iframeEl, ['styleId']);
            return e;
          }
          case IncrementalSource.Font: {
            // fine as-is no modification needed
            return e;
          }
          case IncrementalSource.Selection: {
            e.data.ranges.forEach((range) => {
              this.replaceIds(range, iframeEl, ['start', 'end']);
            });
            return e;
          }
          case IncrementalSource.AdoptedStyleSheet: {
            this.replaceIds(e.data, iframeEl, ['id']);
            this.replaceStyleIds(e.data, iframeEl, ['styleIds']);
            e.data.styles?.forEach((style) => {
              this.replaceStyleIds(style, iframeEl, ['styleId']);
            });
            return e;
          }
        }
      }
    }
    return false;
  }

  private replace<T extends Record<string, unknown>>(
    iframeMirror: CrossOriginIframeMirror,
    obj: T,
    iframeEl: HTMLIFrameElement,
    keys: Array<keyof T>,
  ): T {
    for (const key of keys) {
      if (!Array.isArray(obj[key]) && typeof obj[key] !== 'number') continue;
      if (Array.isArray(obj[key])) {
        obj[key] = iframeMirror.getIds(
          iframeEl,
          obj[key] as number[],
        ) as T[keyof T];
      } else {
        (obj[key] as number) = iframeMirror.getId(iframeEl, obj[key] as number);
      }
    }

    return obj;
  }

  private replaceIds<T extends Record<string, unknown>>(
    obj: T,
    iframeEl: HTMLIFrameElement,
    keys: Array<keyof T>,
  ): T {
    return this.replace(this.crossOriginIframeMirror, obj, iframeEl, keys);
  }

  private replaceStyleIds<T extends Record<string, unknown>>(
    obj: T,
    iframeEl: HTMLIFrameElement,
    keys: Array<keyof T>,
  ): T {
    return this.replace(this.crossOriginIframeStyleMirror, obj, iframeEl, keys);
  }

  private replaceIdOnNode(
    node: serializedNodeWithId,
    iframeEl: HTMLIFrameElement,
  ) {
    this.replaceIds(node, iframeEl, ['id', 'rootId']);
    if ('childNodes' in node) {
      node.childNodes.forEach((child) => {
        this.replaceIdOnNode(child, iframeEl);
      });
    }
  }

  private patchRootIdOnNode(node: serializedNodeWithId, rootId: number) {
    if (node.type !== NodeType.Document && !node.rootId) node.rootId = rootId;
    if ('childNodes' in node) {
      node.childNodes.forEach((child) => {
        this.patchRootIdOnNode(child, rootId);
      });
    }
  }
}
