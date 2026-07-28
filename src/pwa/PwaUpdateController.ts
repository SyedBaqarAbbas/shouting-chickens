export type PwaUpdateStatus =
  "idle" | "checking" | "current" | "deferred" | "available" | "applying" | "unsupported" | "error";

export type PwaUpdateSnapshot = {
  readonly status: PwaUpdateStatus;
  readonly updateAvailable: boolean;
  readonly canApply: boolean;
};

type EventListenerLike = () => void;

export interface ServiceWorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: EventListenerLike): void;
  removeEventListener(type: "statechange", listener: EventListenerLike): void;
}

export interface ServiceWorkerRegistrationLike {
  readonly installing: ServiceWorkerLike | null;
  readonly waiting: ServiceWorkerLike | null;
  addEventListener(type: "updatefound", listener: EventListenerLike): void;
  removeEventListener(type: "updatefound", listener: EventListenerLike): void;
}

export interface ServiceWorkerContainerLike {
  readonly controller: ServiceWorkerLike | null;
  register(
    scriptUrl: string,
    options: { scope: string; updateViaCache: "none" },
  ): Promise<ServiceWorkerRegistrationLike>;
  addEventListener(type: "controllerchange", listener: EventListenerLike): void;
  removeEventListener(type: "controllerchange", listener: EventListenerLike): void;
}

export type PwaUpdateEnvironment = {
  readonly baseUrl: string;
  readonly reload: () => void;
  readonly serviceWorkers: ServiceWorkerContainerLike | null;
};

const INITIAL_SNAPSHOT: PwaUpdateSnapshot = Object.freeze({
  status: "idle",
  updateAvailable: false,
  canApply: false,
});

export class PwaUpdateController {
  private readonly listeners = new Set<() => void>();
  private readonly environment: PwaUpdateEnvironment;
  private snapshot: PwaUpdateSnapshot = INITIAL_SNAPSHOT;
  private registration: ServiceWorkerRegistrationLike | null = null;
  private installing: ServiceWorkerLike | null = null;
  private waiting: ServiceWorkerLike | null = null;
  private runActive = false;
  private applying = false;
  private generation = 0;

  constructor(environment: PwaUpdateEnvironment) {
    this.environment = environment;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  start() {
    const serviceWorkers = this.environment.serviceWorkers;
    if (!serviceWorkers) {
      this.updateSnapshot("unsupported");
      return;
    }

    const generation = ++this.generation;
    this.updateSnapshot("checking");
    serviceWorkers.addEventListener("controllerchange", this.handleControllerChange);
    const scriptUrl = new URL("./service-worker.js", this.environment.baseUrl);
    const scopeUrl = new URL("./", this.environment.baseUrl);

    void serviceWorkers
      .register(scriptUrl.href, {
        scope: scopeUrl.pathname,
        updateViaCache: "none",
      })
      .then((registration) => {
        if (generation !== this.generation) {
          return;
        }
        this.registration = registration;
        registration.addEventListener("updatefound", this.handleUpdateFound);
        if (registration.waiting) {
          this.setWaiting(registration.waiting);
        } else {
          this.watchInstalling(registration.installing);
          this.updateSnapshot("current");
        }
      })
      .catch(() => {
        if (generation !== this.generation) {
          return;
        }
        this.updateSnapshot(serviceWorkers.controller ? "current" : "error");
      });
  }

  stop() {
    this.generation += 1;
    this.registration?.removeEventListener("updatefound", this.handleUpdateFound);
    this.installing?.removeEventListener("statechange", this.handleInstallingState);
    this.environment.serviceWorkers?.removeEventListener(
      "controllerchange",
      this.handleControllerChange,
    );
    this.registration = null;
    this.installing = null;
    this.waiting = null;
    this.applying = false;
    this.updateSnapshot("idle");
  }

  setRunActive(active: boolean) {
    if (this.runActive === active) {
      return;
    }
    this.runActive = active;
    if (this.waiting && !this.applying) {
      this.updateSnapshot(active ? "deferred" : "available");
    }
  }

  applyUpdate() {
    if (this.runActive || !this.waiting || this.applying) {
      return false;
    }
    this.applying = true;
    this.updateSnapshot("applying");
    this.waiting.postMessage({ type: "APPLY_UPDATE" });
    return true;
  }

  private readonly handleUpdateFound = () => {
    this.watchInstalling(this.registration?.installing ?? null);
  };

  private watchInstalling(worker: ServiceWorkerLike | null) {
    this.installing?.removeEventListener("statechange", this.handleInstallingState);
    this.installing = worker;
    worker?.addEventListener("statechange", this.handleInstallingState);
  }

  private readonly handleInstallingState = () => {
    if (this.installing?.state !== "installed") {
      return;
    }
    const waiting = this.registration?.waiting ?? this.installing;
    this.installing.removeEventListener("statechange", this.handleInstallingState);
    this.installing = null;
    if (this.environment.serviceWorkers?.controller) {
      this.setWaiting(waiting);
    } else {
      this.updateSnapshot("current");
    }
  };

  private setWaiting(worker: ServiceWorkerLike) {
    this.waiting = worker;
    this.updateSnapshot(this.runActive ? "deferred" : "available");
  }

  private readonly handleControllerChange = () => {
    if (!this.applying) {
      return;
    }
    this.applying = false;
    this.environment.reload();
  };

  private updateSnapshot(status: PwaUpdateStatus) {
    const updateAvailable =
      status === "deferred" || status === "available" || status === "applying";
    const next = Object.freeze({
      status,
      updateAvailable,
      canApply: status === "available",
    });
    if (
      this.snapshot.status === next.status &&
      this.snapshot.updateAvailable === next.updateAvailable &&
      this.snapshot.canApply === next.canApply
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createBrowserPwaUpdateController() {
  const serviceWorkers =
    import.meta.env.PROD && "serviceWorker" in navigator
      ? (navigator.serviceWorker as unknown as ServiceWorkerContainerLike)
      : null;
  return new PwaUpdateController({
    baseUrl: document.baseURI,
    reload: () => {
      window.location.reload();
    },
    serviceWorkers,
  });
}
