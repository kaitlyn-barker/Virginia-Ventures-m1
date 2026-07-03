import {
  createSystem,
  PanelUI,
  PanelDocument,
  eq,
  UIKitDocument,
  UIKit,
} from "@iwsdk/core";

import { arrivalSequence } from "./game/ArrivalSequence.js";
import { sfx } from "./audio/Sfx.js";

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
        // First user gesture of the session — also unlocks the Web Audio context
        // so later cues (planting, trades, chimes) can play.
        sfx.click();
        if (entity.object3D) entity.object3D.visible = false;
        (document.getElementById("welcome-root") as UIKit.Container | null)
          ?.setProperties({ display: "none" });
        arrivalSequence.emitEnterColony();
      });
    });
  }

  // Keep the welcome card dead-center on screen. ScreenSpace anchors a panel by
  // its TOP-LEFT corner and aspect-fits it inside its box, so on wide desktop
  // viewports the card drifts left and low. Zeroing the camera-space X/Y each
  // frame pins the card's center to the screen center (its depth Z is left
  // untouched; in XR the doc already sits at its parent's origin, so this is a
  // no-op there).
  update() {
    for (const entity of this.queries.welcomePanel.entities) {
      const document = PanelDocument.data.document[entity.index] as
        | UIKitDocument
        | undefined;
      if (document) {
        document.position.x = 0;
        document.position.y = 0;
      }
    }
  }
}
