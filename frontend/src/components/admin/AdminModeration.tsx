import { useCallback, useEffect, useState } from "react";
import {
  fetchAdminReports,
  adminResolveReport,
  adminDismissReport,
  adminRemovePost,
} from "./adminApi";
import type { AdminReportRow, AdminModerationAction } from "./types";
import styles from "./AdminModeration.module.css";

const PAGE = 20;

const FILTERS = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

function statusClass(status?: string) {
  switch ((status || "open").toLowerCase()) {
    case "resolved":  return styles.stResolved;
    case "dismissed": return styles.stDismissed;
    default:          return styles.stOpen;
  }
}

function timeAgo(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
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

type Props = { viewer: string };

export default function AdminModeration({ viewer }: Props) {
  const [filter, setFilter] = useState<FilterId>("open");
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const [rows, setRows] = useState<AdminReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!viewer) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAdminReports(viewer, { status: filter, limit: PAGE, offset });
      if (res?.error) { setError(res.error); setRows([]); setTotal(0); }
      else {
        setRows(Array.isArray(res?.reports) ? res.reports : []);
        setTotal(typeof res?.total === "number" ? res.total : 0);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load reports");
      setRows([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [viewer, filter, offset]);

  useEffect(() => { load(); }, [load, reloadKey]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const run = async (id: number, fn: () => Promise<AdminModerationAction>, ok: string) => {
    setBusyId(id);
    try {
      const res = await fn();
      if (res?.error) flash(`Error: ${res.error}`);
      else { flash(res?.message || ok); setReloadKey((k) => k + 1); }
    } catch (e) {
      flash(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusyId(null);
    }
  };

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  if (!viewer) return <div className={styles.state}>Sign in to moderate reports.</div>;

  return (
    <section className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <h3>Moderation</h3>
          <p className={styles.sub}>
            Reported posts. Remove soft-deletes the post and resolves its open reports.
          </p>
        </div>
        <button type="button" className={styles.refreshBtn} onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className={styles.filters} role="tablist" aria-label="Report status">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id}
            className={[styles.filterBtn, filter === f.id ? styles.filterActive : ""].join(" ")}
            onClick={() => { setFilter(f.id); setOffset(0); }}>
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}

      {loading && rows.length === 0 ? (
        <div className={styles.skeletonList}>
          {[0, 1, 2].map((i) => <div key={i} className={styles.skeletonRow} aria-hidden="true" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>No {filter === "all" ? "" : filter + " "}reports.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((r) => {
            const busy = busyId === r.id;
            const isOpen = (r.status || "open").toLowerCase() === "open";
            return (
              <li key={r.id} className={styles.card}>
                <div className={styles.cardTop}>
                  {r.post_image ? (
                    <img src={r.post_image} alt="" className={styles.thumb} />
                  ) : (
                    <span className={styles.thumbFallback}>
                      {(r.post_title || "?").slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div className={styles.postBlock}>
                    <span className={styles.postTitle}>
                      {r.post_title || "Untitled post"}
                      {r.post_removed && <span className={styles.removedTag}>removed</span>}
                    </span>
                    <span className={styles.byline}>
                      by {r.author_display || r.author_username || "unknown"}
                      {r.post_type ? ` · ${r.post_type}` : ""}
                    </span>
                  </div>
                  <span className={`${styles.statusBadge} ${statusClass(r.status)}`}>{r.status || "open"}</span>
                </div>

                <div className={styles.reportMeta}>
                  <span>
                    Reported by <strong>{r.reporter_display || r.reporter_username || r.reporter || "unknown"}</strong>
                  </span>
                  <span>Reason: <strong>{r.reason || "—"}</strong></span>
                  <span>{timeAgo(r.created_at)}</span>
                </div>
                {r.note && <p className={styles.note}>“{r.note}”</p>}

                <div className={styles.actions}>
                  {!r.post_removed && (
                    <button type="button" className={styles.removeBtn} disabled={busy}
                      onClick={() => run(r.id!, () => adminRemovePost(viewer, r.post_id!), "Post removed")}>
                      {busy ? "…" : "Remove post"}
                    </button>
                  )}
                  {isOpen && (
                    <>
                      <button type="button" className={styles.resolveBtn} disabled={busy}
                        onClick={() => run(r.id!, () => adminResolveReport(viewer, r.id!), "Report resolved")}>
                        {busy ? "…" : "Resolve"}
                      </button>
                      <button type="button" className={styles.dismissBtn} disabled={busy}
                        onClick={() => run(r.id!, () => adminDismissReport(viewer, r.id!), "Report dismissed")}>
                        {busy ? "…" : "Dismiss"}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {total > PAGE && (
        <div className={styles.pager}>
          <span className={styles.range}>{from}–{to} of {total}</span>
          <div className={styles.pagerBtns}>
            <button type="button" disabled={offset === 0 || loading} className={styles.pageBtn}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</button>
            <span className={styles.pageInfo}>Page {page} / {pages}</span>
            <button type="button" disabled={to >= total || loading} className={styles.pageBtn}
              onClick={() => setOffset(offset + PAGE)}>Next</button>
          </div>
        </div>
      )}
    </section>
  );
}