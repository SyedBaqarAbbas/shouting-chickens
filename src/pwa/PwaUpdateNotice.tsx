import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { PwaUpdateController, createBrowserPwaUpdateController } from "./PwaUpdateController";

export type PwaUpdateNoticeProps = {
  readonly createController?: () => PwaUpdateController;
  readonly portalTarget?: HTMLElement | null;
  readonly runActive: boolean;
};

export function PwaUpdateNotice({
  createController = createBrowserPwaUpdateController,
  portalTarget,
  runActive,
}: PwaUpdateNoticeProps) {
  const [controller] = useState(createController);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);

  useEffect(() => {
    controller.setRunActive(runActive);
  }, [controller, runActive]);

  if (runActive || (snapshot.status !== "available" && snapshot.status !== "applying")) {
    return null;
  }

  const notice = (
    <section className="pwa-update" role="region" aria-labelledby="pwa-update-title">
      <div>
        <strong id="pwa-update-title">Game update ready</strong>
        <span role="status">Your current version stays active until you choose to reload.</span>
      </div>
      <button
        type="button"
        disabled={!snapshot.canApply}
        onClick={() => {
          controller.applyUpdate();
        }}
      >
        {snapshot.status === "applying" ? "Updating…" : "Update now"}
      </button>
    </section>
  );
  return portalTarget ? createPortal(notice, portalTarget) : notice;
}
