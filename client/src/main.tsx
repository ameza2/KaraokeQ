import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Home from "./features/home/Home.tsx";
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
          <Route path="*" element={<Home />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>,
  );
});
