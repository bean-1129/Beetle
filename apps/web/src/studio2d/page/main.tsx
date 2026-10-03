// Beetle 2D page: install the browser bridge first, then mount the studio full page.
import "./../bridge.ts";
import { createRoot } from "react-dom/client";
import Studio2D from "../ui/Studio2D.tsx";

createRoot(document.getElementById("root") as HTMLElement).render(
  <div className="s2d-app" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
    <Studio2D />
  </div>,
);
