// Beetle 2D page: install the browser bridge first, make sure the director token is available, then mount the studio.
import "./../bridge.ts";
import { createRoot } from "react-dom/client";
import Studio2D from "../ui/Studio2D.tsx";
import { ensureDirectorToken } from "../../shared/token.ts";

void ensureDirectorToken().finally(() => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <div className="s2d-app" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <Studio2D />
    </div>,
  );
});
