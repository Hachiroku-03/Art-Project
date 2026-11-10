import { useCallback, useEffect, useState } from "react";
import { fetchAdminOverview } from "./adminApi";
import type { AdminOverviewData, AdminActivityItem } from "./types";
import "./AdminOverview.css";

type StatKey =
  | "users"
  | "houses"
  | "pending_house_applications"
  | "live_sales"
  | "upcoming_sales"
  | "open_reports";

type StatCard = {
  key: StatKey;
  label: string;
  hint: string;
  attention: boolean; // highlights when the count is actionable (> 0)
};

const STATS: StatCard[] = [
  { key: "users", label: "Members", hint: "Total registered accounts", attention: false },
  { key: "houses", label: "Accredited houses", hint: "Role = house", attention: false },
  { key: "pending_house_applications", label: "Pending applications", hint: "Awaiting your review", attention: true },
  { key: "live_sales", label: "Live sales", hint: "On the floor right now", attention: false },
  { key: "upcoming_sales", label: "Upcoming sales", hint: "Scheduled, not yet live", attention: false },
  { key: "open_reports", label: "Open reports", hint: "Flagged content to moderate", attention: true },
];

function timeAgo(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value; // unparseable → show raw, never crash
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

type AdminOverviewProps = { viewer: string };

export default function AdminOverview({ viewer }: AdminOverviewProps) {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!viewer) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAdminOverview(viewer);
      // A non-admin or failed lookup returns {"error": "..."} with 200 in some
      // setups; surface it as an error state rather than rendering zeros.
      if (res && typeof res.error === "string" && res.error.trim()) {
        setError(res.error);
        setData(null);
      } else {
        setData(res ?? {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load overview");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [viewer]);

  useEffect(() => {
    let alive = true;
    if (!viewer) return;
    setLoading(true);
    setError(null);
    fetchAdminOverview(viewer)
      .then((res) => {
        if (!alive) return;
        if (res && typeof res.error === "string" && res.error.trim()) {
          setError(res.error);
          setData(null);
        } else {
          setData(res ?? {});
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "could not load overview");
        setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [viewer]);

  if (!viewer) {
    return (
      <div className="admin-overview-state">
        Sign in to view the platform overview.
      </div>
    );
  }

  // Guarded reads — the whole point. Missing keys become 0 / [] / "—".
  const activity: AdminActivityItem[] = Array.isArray(data?.recent_activity)
    ? data!.recent_activity!
    : [];

  return (
    <section className="admin-overview">
      <div className="admin-overview-toolbar">
        <div>
          <h3>Platform overview</h3>
          <p className="admin-overview-sub">
            Live counts from the auth service. Actionable tiles are flagged.
          </p>
        </div>
        <button
          type="button"
          className="admin-overview-refresh"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="admin-overview-error" role="alert">
          <div>
            <strong>Couldn’t load overview.</strong> {error}
          </div>
          <button type="button" onClick={load}>
            Retry
          </button>
        </div>
      )}

      <div className="admin-overview-grid">
        {STATS.map((s) => {
          const raw = data?.[s.key];
          const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
          const flagged = s.attention && value > 0;
          return (
            <article
              key={s.key}
              className={[
                "admin-stat",
                flagged ? "is-attention" : "",
                loading && !data ? "is-loading" : "",
              ].join(" ")}
            >
              <div className="admin-stat-head">
                <span className="admin-stat-label">{s.label}</span>
                {flagged && <span className="admin-stat-flag">review</span>}
              </div>
              <div className="admin-stat-value">
                {loading && !data ? "—" : value.toLocaleString()}
              </div>
              <div className="admin-stat-hint">{s.hint}</div>
            </article>
          );
        })}
      </div>

      <div className="admin-activity">
        <div className="admin-activity-head">
          <h4>Recent activity</h4>
          <span className="admin-activity-count">
            {activity.length} item{activity.length === 1 ? "" : "s"}
          </span>
        </div>

        {loading && !data ? (
          <ul className="admin-activity-list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="admin-activity-row is-skeleton" aria-hidden="true">
                <span className="admin-activity-dot" />
                <span className="admin-activity-line" />
              </li>
            ))}
          </ul>
        ) : activity.length === 0 ? (
          <p className="admin-activity-empty">No recent activity yet.</p>
        ) : (
          <ul className="admin-activity-list">
            {activity.map((item, i) => (
              <li key={i} className="admin-activity-row">
                <span className="admin-activity-dot" />
                <div className="admin-activity-main">
                  <span className="admin-activity-title">
                    {item?.title || item?.kind || "Event"}
                  </span>
                  <span className="admin-activity-meta">
                    {item?.actor ? `${item.actor} · ` : ""}
                    {timeAgo(item?.created_at)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}