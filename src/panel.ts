import {
  createSystem,
  PanelUI,
  PanelDocument,
  eq,
  VisibilityState,
  UIKitDocument,
  UIKit,
} from "@iwsdk/core";

import { arrivalSequence } from "./game/ArrivalSequence.js";

export class PanelSystem extends createSystem({
  welcomePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/welcome.json")],
  },
}) {
  init() {
    this.queries.welcomePanel.subscribe("qualify", (entity) => {
      const document = PanelDocument.data.document[
        entity.index
      ] as UIKitDocument;
      if (!document) {
        return;
      }

      // Primary CTA: hide the intro panel and kick off the arrival orientation
      // cinematic (ArrivalCinematic listens on arrivalSequence.onEnterColony).
      const enterColony = document.getElementById("enter-colony") as UIKit.Text;
      enterColony?.addEventListener("click", () => {
        if (entity.object3D) entity.object3D.visible = false;
        (document.getElementById("welcome-root") as UIKit.Container | null)
          ?.setProperties({ display: "none" });
        arrivalSequence.emitEnterColony();
      });

      // Secondary: toggle the immersive VR session. Kept available so the
      // experience can still be entered in a headset (the cinematic plays there
      // too, as a world-space title card).
      const xrButton = document.getElementById("xr-button") as UIKit.Text;
      xrButton?.addEventListener("click", () => {
        if (this.world.visibilityState.value === VisibilityState.NonImmersive) {
          this.world.launchXR();
        } else {
          this.world.exitXR();
        }
      });
      this.world.visibilityState.subscribe((visibilityState) => {
        if (visibilityState === VisibilityState.NonImmersive) {
          xrButton?.setProperties({ text: "Enter VR" });
        } else {
          xrButton?.setProperties({ text: "Return to Browser" });
        }
      });
    });
  }
}
