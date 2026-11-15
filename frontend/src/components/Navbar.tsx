import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Home,
  Gavel,
  Crown,
  Menu,
  X,
  User,
  LogOut,
  Ticket,
  MessageCircle,
  Settings,
  Users,
  Trophy,
  Bell,
} from "lucide-react";
import { WalletPanel } from "./WalletPanel";
import { NotificationBell } from "./NotificationBell";
import { ErrorBoundary } from "./ErrorBoundary";
import { API } from "../lib/sales";
import { teardown } from "../lib/chat";
import { AUTH_API as AUTH } from "../lib/config";
import { clearSession, getRole, getTier, getViewer } from "../lib/session";
import styles from "./Navbar.module.css";

const SALES = API;
const API_ORIGINS = [AUTH, SALES];

const REFRESH_EVENTS = [
  "space:user-updated",
  "space:vip-updated",
  "space:profile-updated",
  "space:session-changed",
];

const ME_CACHE_PREFIX = "space_me_cache_v2_";
const ME_CACHE_TTL = 5 * 60_000;

type MeCache = {
  ts: number;
  username: string;
  role: string;
  tier: string;
  avatarCandidates: string[];
};

type MePayload = {
  username: string;
  role?: string;
  tier?: string;
  avatar?: string | null;
};

function normalizeRole(value: unknown): string {
  return String(value ?? "artist").trim().toLowerCase() || "artist";
}

function normalizeTier(value: unknown): string {
  const t = String(value ?? "").trim().toLowerCase();
  if (t === "vip" || t === "vip_only" || t === "vip-only" || t === "premium") {
    return "vip";
  }
  return "standard";
}

function readMeCache(username: string): MeCache | null {
  if (!username) return null;

  try {
    const raw = localStorage.getItem(`${ME_CACHE_PREFIX}${username}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as MeCache;

    if (!parsed || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > ME_CACHE_TTL) return null;

    return parsed;
  } catch {
    return null;
  }
}

function writeMeCache(cache: MeCache) {
  if (!cache?.username) return;

  try {
    localStorage.setItem(
      `${ME_CACHE_PREFIX}${cache.username}`,
      JSON.stringify(cache),
    );
  } catch {
    // ignore quota/private-mode errors
  }
}

function clearMeCache(username?: string) {
  if (!username) return;

  try {
    localStorage.removeItem(`${ME_CACHE_PREFIX}${username}`);
  } catch {
    // ignore
  }
}

function buildAvatarCandidates(
  raw: unknown,
  preferredBase?: string,
): string[] {
  if (raw === undefined || raw === null) return [];

  const v = String(raw).trim();
  if (!v) return [];

  if (
    /^https?:\/\//i.test(v) ||
    v.startsWith("data:") ||
    v.startsWith("blob:")
  ) {
    return [v];
  }

  const suffix = v.startsWith("/") ? v : `/${v}`;

  const bases = [preferredBase, ...API_ORIGINS.filter((b) => b !== preferredBase)]
    .filter((b, i, arr): b is string => !!b && arr.indexOf(b) === i);

  return bases.map((base) => `${base}${suffix}`);
}

function readMePayload(d: any, fallbackUsername: string): MePayload {
  const u = d?.user ?? d?.profile ?? d?.data ?? d ?? {};

  const username =
    u.username ??
    u.user_name ??
    u.userName ??
    d?.username ??
    d?.user_name ??
    fallbackUsername;

  const role = u.role ?? d?.role;

  let tier =
    u.tier ??
    u.membership ??
    u.subscription_tier ??
    u.access_tier ??
    d?.tier ??
    d?.membership;

  if (tier === undefined) {
    const flag =
      u.is_vip === true ||
      u.vip === true ||
      (String(u.subscription_status ?? "").toLowerCase() === "active" &&
        String(u.subscription_plan ?? u.plan ?? "")
          .toLowerCase()
          .includes("vip"));

    if (flag) tier = "vip";
  }

  const avatar =
    u.avatar_url ??
    u.avatarUrl ??
    u.avatar ??
    u.image_url ??
    u.imageUrl ??
    d?.avatar_url ??
    d?.avatarUrl ??
    d?.avatar;

  return {
    username: String(username || fallbackUsername),
    role: role === undefined ? undefined : String(role),
    tier: tier === undefined ? undefined : String(tier),
    avatar: avatar === undefined ? undefined : String(avatar || ""),
  };
}

export function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();

  const initialUser = useMemo(
    () => getViewer() || localStorage.getItem("space_user") || "",
    [],
  );

  const cachedMe = useMemo(
    () => (initialUser ? readMeCache(initialUser) : null),
    [initialUser],
  );

  const [user, setUser] = useState(
    () => cachedMe?.username || initialUser,
  );
  const [role, setRole] = useState(
    () => cachedMe?.role || getRole() || "artist",
  );
  const [tier, setTier] = useState(
    () => cachedMe?.tier || getTier() || "standard",
  );

  const [avatarCandidates, setAvatarCandidates] = useState<string[]>(
    () => cachedMe?.avatarCandidates || [],
  );

  const [avatarIndex, setAvatarIndex] = useState(0);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const walletRef = useRef<HTMLDivElement>(null);

  const userRef = useRef(user);
  const roleRef = useRef(role);
  const tierRef = useRef(tier);
  const avatarCandidatesRef = useRef(avatarCandidates);
  const avatarIndexRef = useRef(avatarIndex);

  const fetchingRef = useRef(false);
  const lastFetchRef = useRef(0);
  const vipCheckedRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    tierRef.current = tier;
  }, [tier]);

  useEffect(() => {
    avatarCandidatesRef.current = avatarCandidates;
  }, [avatarCandidates]);

  useEffect(() => {
    avatarIndexRef.current = avatarIndex;
  }, [avatarIndex]);

  const avatarUrl = avatarCandidates[avatarIndex] || null;
  const initial = (user || "?")[0]?.toUpperCase() || "?";
  const isVip = normalizeTier(tier) === "vip";

  const applySession = useCallback(
    (
      nextUsername: string,
      nextRole: string,
      nextTier: string,
      nextCandidates: string[],
    ) => {
      const changedUser = nextUsername !== userRef.current;
      const changedRole = nextRole !== roleRef.current;
      const changedTier = nextTier !== tierRef.current;
      const changedAvatar =
        JSON.stringify(nextCandidates) !==
        JSON.stringify(avatarCandidatesRef.current);

      if (changedUser) {
        setUser(nextUsername);
        userRef.current = nextUsername;
        localStorage.setItem("space_user", nextUsername);
      }

      if (changedRole) {
        setRole(nextRole);
        roleRef.current = nextRole;
        localStorage.setItem("space_role", nextRole);
      }

      if (changedTier) {
        setTier(nextTier);
        tierRef.current = nextTier;
        localStorage.setItem("space_tier", nextTier);
      }

      if (changedAvatar) {
        setAvatarCandidates(nextCandidates);
        avatarCandidatesRef.current = nextCandidates;
        setAvatarIndex(0);
        avatarIndexRef.current = 0;
        setAvatarFailed(false);
      }

      writeMeCache({
        ts: Date.now(),
        username: nextUsername,
        role: nextRole,
        tier: nextTier,
        avatarCandidates: nextCandidates,
      });

      if (changedUser || changedRole || changedTier || changedAvatar) {
        window.dispatchEvent(
          new CustomEvent("space:session-updated", {
            detail: {
              user: nextUsername,
              role: nextRole,
              tier: nextTier,
              avatarCandidates: nextCandidates,
            },
          }),
        );
      }
    },
    [],
  );

  const logoutLocal = useCallback(() => {
    setMobileOpen(false);
    setMenuOpen(false);
    setWalletOpen(false);

    try {
      teardown();
    } catch {
      // ignore
    }

    const oldUser = userRef.current;

    clearSession();
    clearMeCache(oldUser);

    setUser("");
    userRef.current = "";

    setRole("artist");
    roleRef.current = "artist";

    setTier("standard");
    tierRef.current = "standard";

    setAvatarCandidates([]);
    avatarCandidatesRef.current = [];

    setAvatarIndex(0);
    avatarIndexRef.current = 0;

    setAvatarFailed(false);

    fetchingRef.current = false;
    lastFetchRef.current = 0;
    vipCheckedRef.current = false;

    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const fetchMe = useCallback(
    async (force = false) => {
      const current =
        userRef.current ||
        getViewer() ||
        localStorage.getItem("space_user") ||
        "";

      if (!current) {
        setAvatarCandidates([]);
        avatarCandidatesRef.current = [];
        setAvatarIndex(0);
        avatarIndexRef.current = 0;
        setAvatarFailed(false);
        return;
      }

      if (fetchingRef.current) return;

      const now = Date.now();

      // Throttle repeated non-forced calls.
      if (!force && now - lastFetchRef.current < 20_000) return;

      fetchingRef.current = true;
      lastFetchRef.current = now;

      // Forced refreshes usually happen after login/VIP/profile changes.
      // Reset the VIP watchdog so /vip/status can be checked again if needed.
      if (force) {
        vipCheckedRef.current = false;
      }

      try {
        let base: string | undefined;
        let parsed: MePayload = { username: current };

        // Try auth server first.
        try {
          const res = await fetch(
            `${AUTH}/me?viewer=${encodeURIComponent(current)}`,
          );

          if (res.ok) {
            const d = await res.json().catch(() => null);

            if (d) {
              base = AUTH;
              parsed = readMePayload(d, current);
            }
          }
        } catch {
          // ignore
        }

        // Only call the second backend if the first response is incomplete.
        const needsSales =
          parsed.role === undefined ||
          parsed.tier === undefined ||
          parsed.avatar === undefined ||
          parsed.avatar === null;

        if (needsSales) {
          try {
            const res = await fetch(
              `${SALES}/me?viewer=${encodeURIComponent(current)}`,
            );

            if (res.ok) {
              const d = await res.json().catch(() => null);

              if (d) {
                const p2 = readMePayload(d, current);

                parsed = {
                  username: parsed.username || p2.username,
                  role: parsed.role ?? p2.role,
                  tier: parsed.tier ?? p2.tier,
                  avatar:
                    parsed.avatar === undefined || parsed.avatar === null
                      ? p2.avatar
                      : parsed.avatar,
                };

                if (!base) base = SALES;
              }
            }
          } catch {
            // ignore
          }
        }

        const nextUsername = String(parsed.username || current);
        const nextRole =
          parsed.role === undefined
            ? roleRef.current
            : normalizeRole(parsed.role);

        let nextTier =
          parsed.tier === undefined
            ? tierRef.current
            : normalizeTier(parsed.tier);

        // VIP fallback, but only once unless forced refresh resets it.
        if (nextTier !== "vip" && !vipCheckedRef.current) {
          vipCheckedRef.current = true;

          try {
            const vs = await fetch(
              `${AUTH}/vip/status?viewer=${encodeURIComponent(nextUsername)}`,
            )
              .then((r) => r.json())
              .catch(() => null);

            if (vs) {
              const vsTier = normalizeTier(vs.tier);

              if (vsTier === "vip" || vs.vip === true) {
                nextTier = "vip";
              }
            }
          } catch {
            // ignore
          }
        }

        const nextCandidates =
          parsed.avatar === undefined
            ? avatarCandidatesRef.current
            : buildAvatarCandidates(parsed.avatar, base);

        applySession(nextUsername, nextRole, nextTier, nextCandidates);
      } finally {
        fetchingRef.current = false;
      }
    },
    [applySession],
  );

  const scheduleFetchMe = useCallback(
    (force = false) => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void fetchMe(force);
      }, 250);
    },
    [fetchMe],
  );

  // Hydrate from cache on mount.
  // Fetch only if cache is missing or stale.
  useEffect(() => {
    const current =
      getViewer() || localStorage.getItem("space_user") || "";

    if (!current) return;

    const cache = readMeCache(current);

    if (cache) {
      applySession(
        cache.username,
        cache.role,
        cache.tier,
        cache.avatarCandidates,
      );
    }

    if (!cache || Date.now() - cache.ts > ME_CACHE_TTL) {
      void fetchMe(true);
    }

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [applySession, fetchMe]);

  // IMPORTANT:
  // Do NOT refetch /me on window focus.
  // Do NOT refetch /me on every route change.
  // This was one of the main tab-switch delay sources.

  // Cross-tab storage events.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key) {
        scheduleFetchMe(false);
        return;
      }

      if (e.key === "space_token") {
        if (!e.newValue) {
          logoutLocal();
          navigate("/login", { replace: true });
          return;
        }

        scheduleFetchMe(true);
        return;
      }

      if (e.key === "space_user") {
        const nextUser = e.newValue || "";

        if (nextUser && nextUser !== userRef.current) {
          setUser(nextUser);
          userRef.current = nextUser;
          localStorage.setItem("space_user", nextUser);
          scheduleFetchMe(true);
        }

        return;
      }

      if (e.key === "space_role" || e.key === "space_tier") {
        scheduleFetchMe(false);
        return;
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [logoutLocal, navigate, scheduleFetchMe]);

  // Same-tab refresh events from other pages.
  useEffect(() => {
    const onRefresh = () => scheduleFetchMe(true);

    REFRESH_EVENTS.forEach((name) =>
      window.addEventListener(name, onRefresh),
    );

    return () => {
      REFRESH_EVENTS.forEach((name) =>
        window.removeEventListener(name, onRefresh),
      );
    };
  }, [scheduleFetchMe]);

  // Close desktop account menu on outside click.
  useEffect(() => {
    function outside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  // Close wallet popup on outside click.
  useEffect(() => {
    function outside(e: MouseEvent) {
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) {
        setWalletOpen(false);
      }
    }

    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  function handleLogout() {
    logoutLocal();
    navigate("/login", { replace: true });
  }

  const go = (path: string) => {
    setMobileOpen(false);
    setMenuOpen(false);
    setWalletOpen(false);
    navigate(path);
  };

  const isActive = (path: string) =>
    location.pathname === path ? styles.activeLink : "";

  const handleAvatarError = () => {
    if (avatarIndex + 1 < avatarCandidates.length) {
      const next = avatarIndex + 1;
      setAvatarIndex(next);
      avatarIndexRef.current = next;
      return;
    }

    setAvatarFailed(true);
  };

  const avatarContent =
    avatarUrl && !avatarFailed ? (
      <img
        src={avatarUrl}
        alt=""
        className={styles.avatarImg}
        onError={handleAvatarError}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          borderRadius: "inherit",
          display: "block",
        }}
      />
    ) : (
      initial
    );

  return (
    <>
      <nav className={styles.navbar}>
        <div className={styles.brand} onClick={() => go("/feed")}>
          THE SPACE
        </div>

        {/*
          Desktop nav is intentionally shorter.
          "Won lots" lives in the account dropdown and mobile drawer.
        */}
        <div className={styles.navLinks}>
          <button
            className={`${styles.link} ${isActive("/feed")}`}
            onClick={() => go("/feed")}
          >
            <Home size={16} />
            <span>Feed</span>
          </button>

          <button
            className={`${styles.link} ${isActive("/auctions")}`}
            onClick={() => go("/auctions")}
          >
            <Gavel size={16} />
            <span>Auctions</span>
          </button>

          <button
            className={`${styles.link} ${isActive("/community")}`}
            onClick={() => go("/community")}
          >
            <Users size={16} />
            <span>Community</span>
          </button>

          <button
            className={`${styles.link} ${isActive("/messenger")}`}
            onClick={() => go("/messenger")}
          >
            <MessageCircle size={16} />
            <span>Messenger</span>
          </button>
        </div>

        <div className={styles.userCluster}>
          {/*
            Fixed bell slot + ErrorBoundary fallback.
            Even if NotificationBell crashes or returns nothing, the bell area stays visible.
          */}
          <span className={styles.bellSlot}>
            <ErrorBoundary
              fallback={
                <button
                  className={styles.iconBtn}
                  aria-label="Notifications unavailable"
                  title="Notifications unavailable"
                >
                  <Bell size={18} />
                </button>
              }
            >
              <NotificationBell viewer={user} />
            </ErrorBoundary>
          </span>

          <button
            className={`${styles.iconBtn} ${walletOpen ? styles.iconBtnOn : ""}`}
            onClick={() => setWalletOpen((o) => !o)}
            aria-label="Wallet"
          >
            <Ticket size={18} />
          </button>

          <button
            className={`${styles.vipBtn} ${isVip ? styles.vipBtnOn : ""}`}
            onClick={() => go("/pricing")}
            aria-label={isVip ? "Your VIP membership" : "Go VIP"}
          >
            <Crown size={15} fill={isVip ? "currentColor" : "none"} />
            <span className={styles.vipLabel}>
              {isVip ? "VIP" : "Go VIP"}
            </span>
          </button>

          <div
            className={`${styles.menuWrap} ${styles.desktopOnly}`}
            ref={menuRef}
          >
            <button
              className={`${styles.avatar} ${isVip ? styles.vipRing : ""}`}
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Account menu"
            >
              {avatarContent}
            </button>

            {menuOpen && (
              <div className={styles.menuDropdown}>
                <button
                  className={styles.menuItem}
                  onClick={() => go("/wins")}
                >
                  <Trophy size={15} /> Won lots
                </button>

                <button
                  className={styles.menuItem}
                  onClick={() => go("/settings")}
                >
                  <Settings size={15} /> Settings
                </button>

                <button
                  className={styles.menuItem}
                  onClick={() => go(`/profile/${user}`)}
                >
                  <User size={15} /> Profile
                </button>

                <button
                  className={`${styles.menuItem} ${styles.menuDanger}`}
                  onClick={handleLogout}
                >
                  <LogOut size={15} /> Log out
                </button>
              </div>
            )}
          </div>

          <button
            className={styles.hamburger}
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>
        </div>

        {walletOpen && (
          <div className={styles.walletPop} ref={walletRef}>
            <WalletPanel
              viewer={user}
              onClose={() => setWalletOpen(false)}
            />
          </div>
        )}
      </nav>

      {mobileOpen && (
        <>
          <div
            className={styles.backdrop}
            onClick={() => setMobileOpen(false)}
          />

          <aside className={styles.drawer}>
            <div className={styles.drawerHeader}>
              <div
                className={`${styles.avatar} ${isVip ? styles.vipRing : ""}`}
              >
                {avatarContent}
              </div>

              <div className={styles.drawerUserInfo}>
                <p className={styles.drawerName}>{user}</p>
                <p className={styles.drawerRole}>
                  {role.toUpperCase()}
                  {isVip ? " · VIP" : ""}
                </p>
              </div>

              <button
                className={styles.drawerClose}
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>

            <nav className={styles.drawerLinks}>
              <button
                className={`${styles.drawerVip} ${isVip ? styles.drawerVipOn : ""}`}
                onClick={() => go("/pricing")}
              >
                <Crown
                  size={18}
                  fill={isVip ? "currentColor" : "none"}
                />
                <span>
                  {isVip ? "Your VIP membership" : "Go VIP"}
                </span>
              </button>

              <button onClick={() => go("/wallet")}>
                <Ticket size={18} />
                <span>Wallet</span>
              </button>

              <button onClick={() => go("/messenger")}>
                <MessageCircle size={18} />
                <span>Messenger</span>
              </button>

              <div className={styles.drawerDivider} />

              <button
                className={isActive("/feed")}
                onClick={() => go("/feed")}
              >
                <Home size={18} />
                <span>Feed</span>
              </button>

              <button
                className={isActive("/auctions")}
                onClick={() => go("/auctions")}
              >
                <Gavel size={18} />
                <span>Auctions</span>
              </button>

              <button
                className={isActive("/wins")}
                onClick={() => go("/wins")}
              >
                <Trophy size={18} />
                <span>Won lots</span>
              </button>

              <button
                className={isActive("/community")}
                onClick={() => go("/community")}
              >
                <Users size={18} />
                <span>Community</span>
              </button>

              <div className={styles.drawerDivider} />

              <button onClick={() => go("/settings")}>
                <Settings size={18} />
                <span>Settings</span>
              </button>

              <button onClick={() => go(`/profile/${user}`)}>
                <User size={18} />
                <span>Profile</span>
              </button>

              <button
                className={styles.drawerDanger}
                onClick={handleLogout}
              >
                <LogOut size={18} />
                <span>Log out</span>
              </button>
            </nav>
          </aside>
        </>
      )}
    </>
  );
}