import { useCallback, useEffect, useState } from "react";
import { fetchAdminUsers } from "./adminApi";
import type { AdminUserRow } from "./types";
import styles from "./AdminUsers.module.css";

const PAGE = 25;

const ROLES = [
  { id: "all", label: "All" },
  { id: "artist", label: "Artists" },
  { id: "house", label: "Houses" },
] as const;
type RoleId = (typeof ROLES)[number]["id"];

function roleBadgeClass(role?: string) {
  return role === "house" ? styles.badgeHouse : styles.badgeArtist;
}
function tierBadgeClass(tier?: string) {
  return (tier || "standard").toLowerCase() === "vip"
    ? styles.badgeVip
    : styles.badgeStandard;
}
function houseBadgeClass(status?: string) {
  switch ((status || "none").toLowerCase()) {
    case "approved": return styles.hsApproved;
    case "pending":  return styles.hsPending;
    case "rejected": return styles.hsRejected;
    case "revoked":  return styles.hsRevoked;
    default:         return styles.hsNone;
  }
}
function houseLabel(status?: string) {
  const s = (status || "none").toLowerCase();
  return s === "none" ? "—" : s;
}

type Props = { viewer: string };

export default function AdminUsers({ viewer }: Props) {
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<RoleId>("all");
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewer) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchAdminUsers(viewer, { q, role, limit: PAGE, offset })
      .then((res) => {
        if (!alive) return;
        if (res?.error) { setError(res.error); setRows([]); setTotal(0); }
        else {
          setRows(Array.isArray(res?.users) ? res.users : []);
          setTotal(typeof res?.total === "number" ? res.total : 0);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "could not load members");
        setRows([]); setTotal(0);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [viewer, q, role, offset, reloadKey]);

  const submitSearch = useCallback(() => { setQ(qInput.trim()); setOffset(0); }, [qInput]);
  const changeRole = (id: RoleId) => { setRole(id); setOffset(0); };
  const refresh = () => setReloadKey((k) => k + 1);

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  if (!viewer) return <div className={styles.state}>Sign in to browse members.</div>;

  return (
    <section className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <h3>Members</h3>
          <p className={styles.sub}>Read-only oversight. Content removal lives in the Moderation tab.</p>
        </div>
        <button type="button" className={styles.refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <form className={styles.searchRow} onSubmit={(e) => { e.preventDefault(); submitSearch(); }}>
        <input
          className={styles.searchInput}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search username, name, or email…"
          aria-label="Search members"
        />
        <button type="submit" className={styles.searchBtn}>Search</button>
        {q && (
          <button type="button" className={styles.clearBtn}
            onClick={() => { setQInput(""); setQ(""); setOffset(0); }}>
            Clear
          </button>
        )}
      </form>

      <div className={styles.filters} role="tablist" aria-label="Role filter">
        {ROLES.map((r) => (
          <button key={r.id} type="button" role="tab" aria-selected={role === r.id}
            className={[styles.filterBtn, role === r.id ? styles.filterActive : ""].join(" ")}
            onClick={() => changeRole(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" onClick={refresh}>Retry</button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={styles.skeletonList}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonRow} aria-hidden="true" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>No members match this filter.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Tier</th>
                <th>House</th>
                <th className={styles.numCell}>Sales</th>
                <th className={styles.numCell}>Reports</th>
                <th className={styles.numCell}>Followers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id ?? u.username}>
                  <td>
                    <div className={styles.identity}>
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt="" className={styles.avatar} />
                      ) : (
                        <span className={styles.avatarFallback}>
                          {(u.display_name || u.username || "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <div className={styles.nameBlock}>
                        <span className={styles.displayName}>{u.display_name || u.username}</span>
                        <span className={styles.handle}>
                          @{u.username}
                          {u.is_admin && <span className={styles.badgeAdmin}>admin</span>}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td><span className={`${styles.badge} ${roleBadgeClass(u.role)}`}>{u.role || "artist"}</span></td>
                  <td><span className={`${styles.badge} ${tierBadgeClass(u.tier)}`}>{u.tier || "standard"}</span></td>
                  <td>
                    <span className={`${styles.badge} ${houseBadgeClass(u.house_status)}`}>
                      {houseLabel(u.house_status)}
                    </span>
                    {u.house_name && <span className={styles.houseName}>{u.house_name}</span>}
                  </td>
                  <td className={styles.numCell}>
                    {typeof u.sales_count === "number" ? u.sales_count : "—"}
                  </td>
                  <td className={styles.numCell}>
                    {typeof u.reports_count === "number"
                      ? (u.reports_count > 0
                          ? <span className={styles.reportFlag}>{u.reports_count}</span>
                          : 0)
                      : "—"}
                  </td>
                  <td className={styles.numCell}>
                    {typeof u.followers_count === "number" ? u.followers_count : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className={styles.pager}>
          <span className={styles.range}>{from}–{to} of {total}</span>
          <div className={styles.pagerBtns}>
            <button type="button" disabled={offset === 0 || loading}
              className={styles.pageBtn}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</button>
            <span className={styles.pageInfo}>Page {page} / {pages}</span>
            <button type="button" disabled={to >= total || loading}
              className={styles.pageBtn}
              onClick={() => setOffset(offset + PAGE)}>Next</button>
          </div>
        </div>
      )}
    </section>
  );
}