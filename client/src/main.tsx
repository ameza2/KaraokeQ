import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Home from "./features/home/Home.tsx";
import RoomPage from "./features/room/RoomPage.tsx";
import ScreenLanding from "./features/screen/ScreenLanding.tsx";
// Only the admin needs these (and the performance charts), so phones never download them.
const Admin = lazy(() => import("./features/admin/AdminPage.tsx"));
import { adoptCarriedIdentity, moveOffIpAddress } from "./lib/hostRedirect.ts";
import "./styles/index.css";

adoptCarriedIdentity();
// On a raw-IP address, hop to the hostname first (YouTube blocks many videos on IP pages).
void moveOffIpAddress().then((moving) => {
  if (moving) return;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/screen" element={<ScreenLanding />} />
          <Route path="/r/:code" element={<RoomPage />} />
          <Route path="/r/:code/screen" element={<RoomPage screenMode />} />
          <Route path="/admin" element={<Suspense fallback={<main className="home muted">Loading…</main>}><Admin /></Suspense>} />
          <Route path="*" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>,
  );
});
