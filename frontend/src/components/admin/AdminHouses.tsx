import { useCallback, useEffect, useState } from "react";
import {
  fetchAdminHouses,
  adminApproveApplication,
  adminRejectApplication,
  adminRevokeHouse,
} from "./adminApi";
import type { HouseApplication, AdminActionResponse } from "./types";
import styles from "./AdminHouses.module.css";

type StatusFilter = "pending" | "approved" | "rejected" | "all";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

type AdminHousesProps = { viewer: string };

export default function AdminHouses({ viewer }: AdminHousesProps) {
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [rows, setRows] = useState<HouseApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!viewer) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAdminHouses(viewer, filter);
      if (res?.error) {
        setError(res.error);
        setRows([]);
      } else {
        setRows(Array.isArray(res?.applications) ? res.applications : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load applications");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [viewer, filter]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchAdminHouses(viewer, filter)
      .then((res) => {
        if (!alive) return;
        if (res?.error) { setError(res.error); setRows([]); }
        else { setRows(Array.isArray(res?.applications) ? res.applications : []); }
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "could not load applications");
        setRows([]);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [viewer, filter]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const doAction = async (
    appId: number,
    fn: () => Promise<AdminActionResponse>,
    successMsg: string
  ) => {
    setActionBusy(appId);
    try {
      const res = await fn();
      if (res?.error) {
        flash(`Error: ${res.error}`);
      } else {
        flash(successMsg);
        load();
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : "action failed");
    } finally {
      setActionBusy(null);
    }
  };

  const handleApprove = (app: HouseApplication) =>
    doAction(app.id!, () => adminApproveApplication(viewer, app.id!), `Approved ${app.username}`);

  const handleReject = (app: HouseApplication) =>
    doAction(app.id!, () => adminRejectApplication(viewer, app.id!), `Rejected ${app.username}`);

  const handleRevoke = (app: HouseApplication) =>
    doAction(app.id!, () => adminRevokeHouse(viewer, app.username!), `Revoked ${app.username}`);

  if (!viewer) {
    return <div className={styles.state}>Sign in to manage houses.</div>;
  }

  return (
    <section className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <h3>House applications</h3>
          <p className={styles.sub}>Review, approve, reject, and revoke house accreditations.</p>
        </div>
        <button type="button" className={styles.refreshBtn} onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className={styles.filters} role="tablist" aria-label="Status filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={[styles.filterBtn, filter === f.id ? styles.filterActive : ""].join(" ")}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" onClick={load}>Retry</button>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}

      {loading && rows.length === 0 ? (
        <div className={styles.skeletonList}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeletonRow} aria-hidden="true" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>No {filter === "all" ? "" : filter + " "}applications found.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((app) => (
            <li key={app.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div className={styles.identity}>
                  {app.avatar_url ? (
                    <img src={app.avatar_url} alt="" className={styles.avatar} />
                  ) : (
                    <span className={styles.avatarFallback}>
                      {(app.display_name || app.username || "?").slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div>
                    <strong>{app.display_name || app.username}</strong>
                    <span className={styles.username}>@{app.username}</span>
                  </div>
                </div>
                <span className={`${styles.statusBadge} ${styles[`status_${app.status}`] || ""}`}>
                  {app.status}
                </span>
              </div>

              <div className={styles.cardBody}>
                <p className={styles.houseName}>{app.house_name || "Unnamed house"}</p>
                {app.description && <p className={styles.desc}>{app.description}</p>}
                <div className={styles.meta}>
                  <span>Submitted {app.created_at ? new Date(app.created_at).toLocaleDateString() : "—"}</span>
                    {app.decided_at && (
                    <span>
                        Decided {new Date(app.decided_at).toLocaleDateString()}
                        {app.admin_note ? ` — ${app.admin_note}` : ""}
                    </span>
                    )}
                  {typeof app.sales_count === "number" && (
                    <span>{app.sales_count} sale{app.sales_count !== 1 ? "s" : ""}</span>
                  )}
                </div>
                {app.evidence_url && (
                  <a href={app.evidence_url} target="_blank" rel="noopener noreferrer" className={styles.evidenceLink}>
                    View evidence ↗
                  </a>
                )}
              </div>

              <div className={styles.actions}>
                {app.status === "pending" && (
                  <>
                    <button
                      type="button"
                      className={styles.approveBtn}
                      onClick={() => handleApprove(app)}
                      disabled={actionBusy === app.id}
                    >
                      {actionBusy === app.id ? "…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      className={styles.rejectBtn}
                      onClick={() => handleReject(app)}
                      disabled={actionBusy === app.id}
                    >
                      {actionBusy === app.id ? "…" : "Reject"}
                    </button>
                  </>
                )}
                {app.status === "approved" && (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    onClick={() => handleRevoke(app)}
                    disabled={actionBusy === app.id}
                  >
                    {actionBusy === app.id ? "…" : "Revoke accreditation"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}