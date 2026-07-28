import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PwaUpdateController,
  type ServiceWorkerContainerLike,
  type ServiceWorkerLike,
  type ServiceWorkerRegistrationLike,
} from "./PwaUpdateController";
import { PwaUpdateNotice } from "./PwaUpdateNotice";

function waitingController() {
  const listeners = new Map<string, Set<() => void>>();
  const waiting: ServiceWorkerLike = {
    state: "installed",
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const registration: ServiceWorkerRegistrationLike = {
    installing: null,
    waiting,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const container: ServiceWorkerContainerLike = {
    controller: waiting,
    register: vi.fn(async () => registration),
    addEventListener: (type, listener) => {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const controller = new PwaUpdateController({
    baseUrl: "https://example.test/shouting-chickens/",
    reload: vi.fn(),
    serviceWorkers: container,
  });
  return { controller, waiting };
}

describe("PwaUpdateNotice", () => {
  it("keeps the update hidden until an active run ends", async () => {
    const fixture = waitingController();
    const view = render(
      <PwaUpdateNotice createController={() => fixture.controller} runActive={true} />,
    );

    await vi.waitFor(() => expect(fixture.controller.getSnapshot().status).toBe("deferred"));
    expect(screen.queryByText("Game update ready")).not.toBeInTheDocument();

    view.rerender(
      <PwaUpdateNotice createController={() => fixture.controller} runActive={false} />,
    );
    expect(await screen.findByText("Game update ready")).toBeVisible();
  });

  it("activates only from the explicit update button", async () => {
    const user = userEvent.setup();
    const fixture = waitingController();
    render(<PwaUpdateNotice createController={() => fixture.controller} runActive={false} />);

    await user.click(await screen.findByRole("button", { name: "Update now" }));

    expect(fixture.waiting.postMessage).toHaveBeenCalledWith({ type: "APPLY_UPDATE" });
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("removes an already-visible prompt synchronously when a run starts", async () => {
    const fixture = waitingController();
    const view = render(
      <PwaUpdateNotice createController={() => fixture.controller} runActive={false} />,
    );
    expect(await screen.findByText("Game update ready")).toBeVisible();
    vi.spyOn(fixture.controller, "setRunActive").mockImplementation(() => undefined);

    view.rerender(<PwaUpdateNotice createController={() => fixture.controller} runActive={true} />);

    expect(screen.queryByText("Game update ready")).not.toBeInTheDocument();
    expect(fixture.waiting.postMessage).not.toHaveBeenCalled();
  });

  it("ports the prompt into an active modal host so its focus trap can include the action", async () => {
    const fixture = waitingController();
    const host = document.createElement("div");
    document.body.append(host);
    render(
      <PwaUpdateNotice
        createController={() => fixture.controller}
        portalTarget={host}
        runActive={false}
      />,
    );

    expect(await within(host).findByRole("button", { name: "Update now" })).toBeVisible();
    expect(host.firstElementChild).toHaveClass("pwa-update");

    host.remove();
  });
});
