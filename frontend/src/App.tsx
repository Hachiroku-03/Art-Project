import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { LoginPage } from "./auth/LoginPage";
import { SignupPage } from "./auth/SignupPage";

import { LandingPage } from "./pages/LandingPage";
import { FeedPage } from "./pages/FeedPage";
import { PostRoomPage } from "./pages/PostRoomPage";
import { AuctionsPage } from "./pages/AuctionsPage";
import { AuctionRoomPage } from "./pages/AuctionRoomPage";
import { ControlRoomPage } from "./pages/ControlRoomPage";
import { HouseApplicationPage } from "./pages/HouseApplicationPage";
import { PricingPage } from "./pages/PricingPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WalletPage } from "./pages/WalletPage";
import { ChatDebugPage } from "./pages/ChatDebugPage";
import { MessengerPage } from "./pages/MessengerPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CommunityPage } from "./pages/CommunityPage";
import { CallDetailPage } from "./pages/CallDetailPage";
import { AdminPage } from "./pages/AdminPage";
import { SaleDetailPage } from "./pages/SaleDetailPage";
import { WonLotsPage } from "./pages/WonLotsPage";

const env = (import.meta as any).env || {};

const AUTH_API = String(env.VITE_AUTH_API_URL || "http://localhost:8000").replace(
  /\/+$/,
  ""
);

const isLocalHost =
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1"].includes(window.location.hostname);

/**
 * Frontend-only admin fallback for local testing.
 *
 * Real security is still enforced by the backend:
 *   ADMIN_USERNAMES=coura
 *
 * If /me returns is_admin:true, this fallback is not needed.
 * For production, either remove the "coura" default or set:
 *   VITE_ADMIN_USERNAMES=
 */
const FALLBACK_ADMIN_USERNAMES = new Set(
  String(env.VITE_ADMIN_USERNAMES || (isLocalHost ? "coura" : ""))
    .split(",")
    .map((value: string) => value.trim())
    .filter(Boolean)
);

function getStoredToken(): string {
  return localStorage.getItem("space_token") || "";
}

function getStoredUser(): string {
  return (
    localStorage.getItem("space_user") ||
    localStorage.getItem("space_username") ||
    localStorage.getItem("username") ||
    ""
  );
}

function Gate() {
  const token = getStoredToken();
  return <Navigate to={token ? "/feed" : "/login"} replace />;
}

function LandingGate() {
  const token = getStoredToken();
  return token ? <Navigate to="/feed" replace /> : <LandingPage />;
}

function AdminRoute() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    const token = getStoredToken();
    const storedUser = getStoredUser();

    if (!token || !storedUser) {
      if (alive) {
        setIsAdmin(false);
        setLoading(false);
      }
      return;
    }

    fetch(`${AUTH_API}/me?viewer=${encodeURIComponent(storedUser)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;

        const backendAdmin = Boolean(data?.is_admin ?? data?.user?.is_admin);
        const fallbackAdmin = FALLBACK_ADMIN_USERNAMES.has(storedUser);

        setIsAdmin(backendAdmin || fallbackAdmin);
      })
      .catch(() => {
        if (alive) {
          setIsAdmin(FALLBACK_ADMIN_USERNAMES.has(storedUser));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0a0a0a",
          color: "#8a857c",
          fontFamily: "inherit",
          fontSize: "14px",
        }}
      >
        Checking admin access…
      </div>
    );
  }

  const token = getStoredToken();
  const user = getStoredUser();

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <ErrorBoundary>
      <AdminPage viewer={user} isAdmin={isAdmin} />
    </ErrorBoundary>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ErrorBoundary>
              <LandingGate />
            </ErrorBoundary>
          }
        />

        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />

        <Route path="/feed" element={<FeedPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/post/:id" element={<PostRoomPage />} />

        <Route path="/auctions" element={<AuctionsPage />} />

        <Route path="/sales/control" element={<ControlRoomPage />} />
        <Route path="/sales/:saleId" element={<SaleDetailPage />} />
        <Route path="/sales/:id/room" element={<AuctionRoomPage />} />
        <Route path="/sales/:id/control" element={<ControlRoomPage />} />

        <Route path="/house/apply" element={<HouseApplicationPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/messenger" element={<MessengerPage />} />
        <Route path="/chat-debug" element={<ChatDebugPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />

        <Route path="/admin" element={<AdminRoute />} />

        <Route
          path="/wins"
          element={
            <ErrorBoundary>
              <WonLotsPage />
            </ErrorBoundary>
          }
        />

        <Route path="/calls/:id" element={<CallDetailPage />} />

        <Route
          path="/profile"
          element={
            <ErrorBoundary>
              <ProfilePage />
            </ErrorBoundary>
          }
        />

        <Route
          path="/profile/:username"
          element={
            <ErrorBoundary>
              <ProfilePage />
            </ErrorBoundary>
          }
        />

        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;