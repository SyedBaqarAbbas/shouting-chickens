import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PwaUpdateController,
  type ServiceWorkerContainerLike,
  type ServiceWorkerLike,
  type ServiceWorkerRegistrationLike,
} from "./PwaUpdateController";

class FakeEvents {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

class FakeWorker extends FakeEvents implements ServiceWorkerLike {
  state = "installed";
  readonly postMessage = vi.fn();
}

class FakeRegistration extends FakeEvents implements ServiceWorkerRegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
}

class FakeContainer extends FakeEvents implements ServiceWorkerContainerLike {
  controller: FakeWorker | null = new FakeWorker();
  readonly register = vi.fn(async () => this.registration);

  constructor(readonly registration: FakeRegistration) {
    super();
  }
}

describe("PwaUpdateController", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports unsupported environments without registering", () => {
    const controller = new PwaUpdateController({
      baseUrl: "https://example.test/shouting-chickens/",
      reload: vi.fn(),
      serviceWorkers: null,
    });

    controller.start();

    expect(controller.getSnapshot()).toEqual({
      status: "unsupported",
      updateAvailable: false,
      canApply: false,
    });
  });

  it("registers a Pages-relative worker with cache bypass", async () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer(registration);
    const controller = createController(container);

    controller.start();
    await vi.waitFor(() => expect(container.register).toHaveBeenCalledOnce());

    expect(container.register).toHaveBeenCalledWith(
      "https://example.test/shouting-chickens/service-worker.js",
      {
        scope: "/shouting-chickens/",
        updateViaCache: "none",
      },
    );
    expect(controller.getSnapshot().status).toBe("current");
  });

  it("defers a waiting worker through a run and reloads only after explicit confirmation", async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker();
    registration.waiting = waiting;
    const container = new FakeContainer(registration);
    const reload = vi.fn();
    const controller = createController(container, reload);
    controller.setRunActive(true);

    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("deferred"));
    expect(controller.applyUpdate()).toBe(false);
    expect(waiting.postMessage).not.toHaveBeenCalled();
    container.dispatch("controllerchange");
    expect(reload).not.toHaveBeenCalled();

    controller.setRunActive(false);
    expect(controller.getSnapshot()).toEqual({
      status: "available",
      updateAvailable: true,
      canApply: true,
    });
    expect(controller.applyUpdate()).toBe(true);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "APPLY_UPDATE" });
    expect(controller.getSnapshot().status).toBe("applying");
    expect(reload).not.toHaveBeenCalled();

    container.dispatch("controllerchange");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("observes an installed update without prompting on first install", async () => {
    const registration = new FakeRegistration();
    const installing = new FakeWorker();
    installing.state = "installing";
    registration.installing = installing;
    const container = new FakeContainer(registration);
    const controller = createController(container);

    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("current"));
    installing.state = "installed";
    registration.waiting = installing;
    installing.dispatch("statechange");

    expect(controller.getSnapshot().status).toBe("available");

    const firstInstall = new FakeRegistration();
    const firstWorker = new FakeWorker();
    firstWorker.state = "installing";
    firstInstall.installing = firstWorker;
    const uncontrolledContainer = new FakeContainer(firstInstall);
    uncontrolledContainer.controller = null;
    const firstController = createController(uncontrolledContainer);
    firstController.start();
    await vi.waitFor(() => expect(firstController.getSnapshot().status).toBe("current"));
    firstWorker.state = "installed";
    firstInstall.waiting = firstWorker;
    firstWorker.dispatch("statechange");
    expect(firstController.getSnapshot().status).toBe("current");
  });
});

function createController(container: FakeContainer, reload = vi.fn()) {
  return new PwaUpdateController({
    baseUrl: "https://example.test/shouting-chickens/",
    reload,
    serviceWorkers: container,
  });
}
