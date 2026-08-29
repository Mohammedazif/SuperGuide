import {
  ClientCapabilityRegistry,
  NamespacedStorage,
  SuperGuideClient,
  Transport,
  browserStore,
  type CapabilityDefinition,
} from "@superguide/client-core";
import { ActionExecutor, type Navigator as ExecutorNavigator } from "@superguide/executor";
import { PageObserver } from "@superguide/observer";
import { mountWidget, type MountedWidget } from "@superguide/widget-ui";

export const SCRIPT_ELEMENT_ID = "superguide-widget";

export interface BootConfiguration {
  productId: string;
  apiUrl: string;
  title: string;
}

export type QueuedCall = [command: string, ...args: unknown[]];

export interface BootSurfaces {
  document: Document;
  window: Window & typeof globalThis;
  fetchImplementation?: typeof fetch;
}

export function readConfiguration(document: Document): BootConfiguration | null {
  const element = document.getElementById(SCRIPT_ELEMENT_ID);
  if (element === null) return null;

  const productId = element.getAttribute("data-product-id");
  const apiUrl = element.getAttribute("data-api-url");
  if (productId === null || productId.length === 0) return null;
  if (apiUrl === null || apiUrl.length === 0) return null;

  return {
    productId,
    apiUrl,
    title: element.getAttribute("data-title") ?? "SuperGuide",
  };
}

export interface BootedWidget {
  client: SuperGuideClient;
  widget: MountedWidget;
  handle(call: QueuedCall): void;
  teardown(): void;
}

function historyNavigator(view: Window): ExecutorNavigator {
  return {
    navigate(url: string) {
      const resolved = new URL(url, view.location.href).toString();
      view.location.assign(resolved);
    },
    currentUrl() {
      return view.location.href;
    },
  };
}

export function boot(surfaces: BootSurfaces, configuration: BootConfiguration): BootedWidget {
  const observer = new PageObserver();
  const capabilities = new ClientCapabilityRegistry();

  let customNavigate: ((url: string) => void) | null = null;
  const defaultNavigator = historyNavigator(surfaces.window);

  const navigator: ExecutorNavigator = {
    navigate(url: string) {
      if (customNavigate === null) void defaultNavigator.navigate(url);
      else customNavigate(url);
    },
    currentUrl: () => defaultNavigator.currentUrl(),
  };

  const routeTemplates = new Map<string, string>();

  const executor = new ActionExecutor({
    document: surfaces.document,
    observer,
    capabilities,
    navigator,
    routeTemplates,
    groundedActionsEnabled: false,
  });

  const transport = new Transport({
    apiUrl: configuration.apiUrl,
    productId: configuration.productId,
    ...(surfaces.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: surfaces.fetchImplementation }),
  });

  const storage = new NamespacedStorage(
    browserStore(surfaces.window.localStorage),
    configuration.productId,
  );

  const client = new SuperGuideClient({
    transport,
    executor,
    storage,
    capabilities,
    currentDigest: () => observer.observe(surfaces.document, {}),
    currentUrl: () => navigator.currentUrl(),
    onLog: (message, detail) => {
      surfaces.window.dispatchEvent(new CustomEvent("sg:log", { detail: { message, detail } }));
    },
    onNotify: (name, detail) => {
      surfaces.document.dispatchEvent(new CustomEvent(`sg:${name}`, { detail }));
    },
  });

  const widget = mountWidget({
    client,
    title: configuration.title,
    document: surfaces.document,
  });

  const onPageHide = (): void => {
    client.reportNavigation();
  };
  const onOnline = (): void => {
    client.reconnect();
  };

  surfaces.window.addEventListener("pagehide", onPageHide);
  surfaces.window.addEventListener("online", onOnline);

  void client.start().then(() => {
    const config = client.state.config;
    if (config === null) return;
    routeTemplates.clear();
    for (const route of config.routes) routeTemplates.set(route.id, route.template);
    executor.setGroundedActionsEnabled(config.groundedActionsEnabled);
    executor.setObserveOptions({ valueAllowlist: config.redactionAllowlist });
  });

  const handle = (call: QueuedCall): void => {
    const [command, ...args] = call;

    switch (command) {
      case "identify": {
        const token = args[0];
        if (typeof token === "string") void client.identify(token);
        return;
      }
      case "update": {
        return;
      }
      case "registerCapabilities": {
        const definitions = args[0];
        if (Array.isArray(definitions)) {
          client.registerCapabilities(definitions as CapabilityDefinition[]);
        }
        return;
      }
      case "setNavigate": {
        const navigate = args[0];
        if (typeof navigate === "function") {
          customNavigate = navigate as (url: string) => void;
        }
        return;
      }
      case "ask": {
        const text = args[0];
        if (typeof text === "string" && text.trim().length > 0) {
          widget.open();
          void client.send(text);
        }
        return;
      }
      case "open":
        widget.open();
        return;
      case "close":
        widget.close();
        return;
      case "reset":
        client.reset();
        return;
      default:
        return;
    }
  };

  return {
    client,
    widget,
    handle,
    teardown() {
      surfaces.window.removeEventListener("pagehide", onPageHide);
      surfaces.window.removeEventListener("online", onOnline);
      client.stop();
      widget.unmount();
    },
  };
}
