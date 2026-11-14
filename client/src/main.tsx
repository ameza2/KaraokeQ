import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Home from "./pages/Home.tsx";
import Room from "./pages/Room.tsx";
import ScreenLanding from "./pages/Screen.tsx";
import { adoptCarriedIdentity, moveOffIpAddress } from "./lib/hostRedirect.ts";
import "./styles.css";

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
          <Route path="/r/:code" element={<Room />} />
          <Route path="/r/:code/screen" element={<Room screenMode />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>,
  );
});
