import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary";

const env = (import.meta as any).env || {};

const AUTH_API = String(env.VITE_AUTH_API_URL || "http://localhost:8000").replace(
  /\/+$/,
  "",
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
    .filter(Boolean),
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

// ---------------------------------------------------------------------------
// Lazy route pages.
//
// This keeps heavy pages like Feed/Auctions/Messenger/Community from dragging
// the whole app bundle into every route.
// ---------------------------------------------------------------------------

const LoginPage = lazy(() =>
  import("./auth/LoginPage").then((mod) => ({ default: mod.LoginPage })),
);

const SignupPage = lazy(() =>
  import("./auth/SignupPage").then((mod) => ({ default: mod.SignupPage })),
);

const LandingPage = lazy(() =>
  import("./pages/LandingPage").then((mod) => ({ default: mod.LandingPage })),
);

const FeedPage = lazy(() =>
  import("./pages/FeedPage").then((mod) => ({ default: mod.FeedPage })),
);

const PostRoomPage = lazy(() =>
  import("./pages/PostRoomPage").then((mod) => ({ default: mod.PostRoomPage })),
);

const AuctionsPage = lazy(() =>
  import("./pages/AuctionsPage").then((mod) => ({ default: mod.AuctionsPage })),
);

const AuctionRoomPage = lazy(() =>
  import("./pages/AuctionRoomPage").then((mod) => ({
    default: mod.AuctionRoomPage,
  })),
);

const ControlRoomPage = lazy(() =>
  import("./pages/ControlRoomPage").then((mod) => ({
    default: mod.ControlRoomPage,
  })),
);

const HouseApplicationPage = lazy(() =>
  import("./pages/HouseApplicationPage").then((mod) => ({
    default: mod.HouseApplicationPage,
  })),
);

const PricingPage = lazy(() =>
  import("./pages/PricingPage").then((mod) => ({ default: mod.PricingPage })),
);

const ProfilePage = lazy(() =>
  import("./pages/ProfilePage").then((mod) => ({ default: mod.ProfilePage })),
);

const WalletPage = lazy(() =>
  import("./pages/WalletPage").then((mod) => ({ default: mod.WalletPage })),
);

const ChatDebugPage = lazy(() =>
  import("./pages/ChatDebugPage").then((mod) => ({ default: mod.ChatDebugPage })),
);

const MessengerPage = lazy(() =>
  import("./pages/MessengerPage").then((mod) => ({
    default: mod.MessengerPage,
  })),
);

const NotificationsPage = lazy(() =>
  import("./pages/NotificationsPage").then((mod) => ({
    default: mod.NotificationsPage,
  })),
);

const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((mod) => ({ default: mod.SettingsPage })),
);

const CommunityPage = lazy(() =>
  import("./pages/CommunityPage").then((mod) => ({ default: mod.CommunityPage })),
);

const CallDetailPage = lazy(() =>
  import("./pages/CallDetailPage").then((mod) => ({ default: mod.CallDetailPage })),
);

const AdminPage = lazy(() =>
  import("./pages/AdminPage").then((mod) => ({ default: mod.AdminPage })),
);

const SaleDetailPage = lazy(() =>
  import("./pages/SaleDetailPage").then((mod) => ({ default: mod.SaleDetailPage })),
);

const WonLotsPage = lazy(() =>
  import("./pages/WonLotsPage").then((mod) => ({ default: mod.WonLotsPage })),
);

// ---------------------------------------------------------------------------
// Route wrapper.
//
// No skeleton here. Each page will own its own skeleton/loading UI.
// ---------------------------------------------------------------------------

function RouteShell({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function Gate() {
  const token = getStoredToken();
  return <Navigate to={token ? "/feed" : "/login"} replace />;
}

function LandingGate() {
  const token = getStoredToken();

  if (token) {
    return <Navigate to="/feed" replace />;
  }

  return <LandingPage />;
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
    return null;
  }

  const token = getStoredToken();
  const user = getStoredUser();

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <RouteShell>
      <AdminPage viewer={user} isAdmin={isAdmin} />
    </RouteShell>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <RouteShell>
              <LandingGate />
            </RouteShell>
          }
        />

        <Route
          path="/login"
          element={
            <RouteShell>
              <LoginPage />
            </RouteShell>
          }
        />

        <Route
          path="/signup"
          element={
            <RouteShell>
              <SignupPage />
            </RouteShell>
          }
        />

        <Route
          path="/feed"
          element={
            <RouteShell>
              <FeedPage />
            </RouteShell>
          }
        />

        <Route
          path="/community"
          element={
            <RouteShell>
              <CommunityPage />
            </RouteShell>
          }
        />

        <Route
          path="/post/:id"
          element={
            <RouteShell>
              <PostRoomPage />
            </RouteShell>
          }
        />

        <Route
          path="/auctions"
          element={
            <RouteShell>
              <AuctionsPage />
            </RouteShell>
          }
        />

        <Route
          path="/sales/control"
          element={
            <RouteShell>
              <ControlRoomPage />
            </RouteShell>
          }
        />

        <Route
          path="/sales/:saleId"
          element={
            <RouteShell>
              <SaleDetailPage />
            </RouteShell>
          }
        />

        <Route
          path="/sales/:id/room"
          element={
            <RouteShell>
              <AuctionRoomPage />
            </RouteShell>
          }
        />

        <Route
          path="/sales/:id/control"
          element={
            <RouteShell>
              <ControlRoomPage />
            </RouteShell>
          }
        />

        <Route
          path="/house/apply"
          element={
            <RouteShell>
              <HouseApplicationPage />
            </RouteShell>
          }
        />

        <Route
          path="/pricing"
          element={
            <RouteShell>
              <PricingPage />
            </RouteShell>
          }
        />

        <Route
          path="/wallet"
          element={
            <RouteShell>
              <WalletPage />
            </RouteShell>
          }
        />

        <Route
          path="/messenger"
          element={
            <RouteShell>
              <MessengerPage />
            </RouteShell>
          }
        />

        <Route
          path="/chat-debug"
          element={
            <RouteShell>
              <ChatDebugPage />
            </RouteShell>
          }
        />

        <Route
          path="/notifications"
          element={
            <RouteShell>
              <NotificationsPage />
            </RouteShell>
          }
        />

        <Route
          path="/settings"
          element={
            <RouteShell>
              <SettingsPage />
            </RouteShell>
          }
        />

        <Route path="/admin" element={<AdminRoute />} />

        <Route
          path="/wins"
          element={
            <RouteShell>
              <WonLotsPage />
            </RouteShell>
          }
        />

        <Route
          path="/calls/:id"
          element={
            <RouteShell>
              <CallDetailPage />
            </RouteShell>
          }
        />

        <Route
          path="/profile"
          element={
            <RouteShell>
              <ProfilePage />
            </RouteShell>
          }
        />

        <Route
          path="/profile/:username"
          element={
            <RouteShell>
              <ProfilePage />
            </RouteShell>
          }
        />

        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;