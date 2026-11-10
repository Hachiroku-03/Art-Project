import { useState, type ReactNode } from "react";
import "./AdminShell.css";

export type AdminTab =
  | "overview"
  | "houses"
  | "users"
  | "moderation"
  | "sales"
  | "system";

export type AdminTabMeta = {
  id: AdminTab;
  label: string;
  hint: string;
  available: boolean;
};

export const ADMIN_TABS: AdminTabMeta[] = [
  {
    id: "overview",
    label: "Overview",
    hint: "Platform health, counts, pending actions, and recent activity.",
    available: true,
  },
  {
    id: "houses",
    label: "Houses",
    hint: "Approve, reject, and revoke accredited houses.",
    available: true,
  },
  {
    id: "users",
    label: "Users",
    hint: "Search members and inspect moderation-relevant profile state.",
    available: true,
  },
  {
    id: "moderation",
    label: "Moderation",
    hint: "Reported posts, comments, and removal actions.",
    available: true,
  },
  {
    id: "sales",
    label: "Sales",
    hint: "Inspect live, ended, unsettled, and payout-pending sales.",
    available: true,
  },
  {
    id: "system",
    label: "System",
    hint: "Broadcast notices and platform-level controls.",
    available: true,
  },
];

type AdminShellProps = {
  viewer: string;
  isAdmin: boolean;
  activeTab?: AdminTab;
  onTabChange?: (tab: AdminTab) => void;
  children: ReactNode;
};

export default function AdminShell({
  viewer,
  isAdmin,
  activeTab,
  onTabChange,
  children,
}: AdminShellProps) {
  const [internalTab, setInternalTab] = useState<AdminTab>("overview");

  const tab = activeTab ?? internalTab;
  const currentTab =
    ADMIN_TABS.find((item) => item.id === tab) ?? ADMIN_TABS[0];

  const changeTab = (nextTab: AdminTab) => {
    const meta = ADMIN_TABS.find((item) => item.id === nextTab);

    if (!meta?.available) {
      return;
    }

    if (onTabChange) {
      onTabChange(nextTab);
    }

    if (activeTab === undefined) {
      setInternalTab(nextTab);
    }
  };

  if (!viewer) {
    return (
      <section className="admin-shell-state">
        <div className="admin-shell-state-card">
          <h1>Admin Control Room</h1>
          <p>Checking your session...</p>
        </div>
      </section>
    );
  }

  if (!isAdmin) {
    return (
      <section className="admin-shell-state">
        <div className="admin-shell-state-card admin-shell-denied">
          <h1>Restricted</h1>
          <p>
            This area is reserved for platform administrators. The backend will
            reject non-admin requests to <code>/admin/*</code> endpoints even if
            someone tries to access them directly.
          </p>
        </div>
      </section>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-shell-header">
        <div className="admin-shell-title-block">
          <p className="admin-shell-kicker">The Space</p>
          <h1>Admin Control Room</h1>
          <p className="admin-shell-subtitle">
            Signed in as <strong>{viewer}</strong>. This interface only exposes
            actions backed by admin-protected endpoints.
          </p>
        </div>

        <div className="admin-shell-badge">Admin</div>
      </header>

      <nav className="admin-shell-nav" aria-label="Admin sections">
        {ADMIN_TABS.map((item) => {
          const isActive = item.id === tab;
          const isDisabled = !item.available;

          return (
            <button
              key={item.id}
              type="button"
              className={[
                "admin-shell-tab",
                isActive ? "is-active" : "",
                isDisabled ? "is-disabled" : "",
              ].join(" ")}
              onClick={() => changeTab(item.id)}
              disabled={isDisabled}
              aria-current={isActive ? "page" : undefined}
              title={
                isDisabled
                  ? `${item.label} - backend endpoint not wired yet`
                  : item.hint
              }
            >
              <span className="admin-shell-tab-label">{item.label}</span>

              {isDisabled && (
                <span className="admin-shell-tab-flag">soon</span>
              )}
            </button>
          );
        })}
      </nav>

      <main className="admin-shell-main">
        <div className="admin-shell-panel-head">
          <h2>{currentTab.label}</h2>
          <p>{currentTab.hint}</p>
        </div>

        <div className="admin-shell-panel-body">{children}</div>
      </main>
    </div>
  );
}