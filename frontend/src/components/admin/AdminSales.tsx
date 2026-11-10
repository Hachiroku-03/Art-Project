import { useCallback, useEffect, useState } from "react";
import { fetchAdminSales, fetchAdminSaleAudit } from "./adminApi";
import type {
  AdminSaleRow,
  AdminSaleAuditResponse,
  AdminSaleLot,
  AdminSaleLedgerEntry,
} from "./types";
import styles from "./AdminSales.module.css";

const PAGE = 25;

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "upcoming", label: "Upcoming" },
  { id: "ended", label: "Ended" },
  { id: "settled", label: "Settled" },
  { id: "attention", label: "Needs attention" },
] as const;

type StatusId = (typeof STATUS_FILTERS)[number]["id"];

function formatMoney(value?: string | number | null, currency?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const formatted = n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${formatted}` : formatted;
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function saleStatusClass(status?: string) {
  switch ((status || "").toLowerCase()) {
    case "live":
      return stLive;
    case "upcoming":
      return stUpcoming;
    case "ended":
      return stEnded;
    default:
      return stDefault;
  }
}

function payoutStatusClass(status?: string) {
  switch ((status || "none").toLowerCase()) {
    case "paid":
      return poPaid;
    case "pending":
      return poPending;
    case "none":
      return poNone;
    default:
      return poDefault;
  }
}

function paymentStatusClass(status?: string) {
  switch ((status || "unpaid").toLowerCase()) {
    case "paid":
      return payPaid;
    case "pending":
    case "processing":
      return payPending;
    case "failed":
      return payFailed;
    case "unpaid":
      return payUnpaid;
    default:
      return payDefault;
  }
}

// Local class aliases keep the JSX readable while still using CSS Modules.
const stLive = styles.statusLive;
const stUpcoming = styles.statusUpcoming;
const stEnded = styles.statusEnded;
const stDefault = styles.statusDefault;

const poPaid = styles.payoutPaid;
const poPending = styles.payoutPending;
const poNone = styles.payoutNone;
const poDefault = styles.payoutDefault;

const payPaid = styles.paymentPaid;
const payPending = styles.paymentPending;
const payFailed = styles.paymentFailed;
const payUnpaid = styles.paymentUnpaid;
const payDefault = styles.paymentDefault;

type Props = { viewer: string };

export default function AdminSales({ viewer }: Props) {
  const [status, setStatus] = useState<StatusId>("all");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [host, setHost] = useState("");
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const [rows, setRows] = useState<AdminSaleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [audit, setAudit] = useState<AdminSaleAuditResponse | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const loadSales = useCallback(async () => {
    if (!viewer) return;
    setLoading(true);
    setError(null);
    setNote(null);

    try {
      const res = await fetchAdminSales(viewer, {
        status,
        host,
        q,
        limit: PAGE,
        offset,
      });

      if (res?.error) {
        setError(res.error);
        setRows([]);
        setTotal(0);
      } else {
        setRows(Array.isArray(res?.sales) ? res.sales : []);
        setTotal(typeof res?.total === "number" ? res.total : 0);
        setNote(res?.note || null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load sales");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [viewer, status, host, q, offset]);

  useEffect(() => {
    loadSales();
  }, [loadSales, reloadKey]);

  const openAudit = useCallback(
    async (saleId: number) => {
      if (!viewer) return;
      setSelectedId(saleId);
      setAudit(null);
      setAuditError(null);
      setAuditLoading(true);

      try {
        const res = await fetchAdminSaleAudit(viewer, saleId);
        if (res?.error) {
          setAuditError(res.error);
        } else {
          setAudit(res);
        }
      } catch (e) {
        setAuditError(e instanceof Error ? e.message : "could not load audit");
      } finally {
        setAuditLoading(false);
      }
    },
    [viewer]
  );

  const closeAudit = () => {
    setSelectedId(null);
    setAudit(null);
    setAuditError(null);
  };

  const submitSearch = () => {
    setQ(qInput.trim());
    setOffset(0);
  };

  const clearFilters = () => {
    setQInput("");
    setQ("");
    setHost("");
    setStatus("all");
    setOffset(0);
  };

  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  if (!viewer) {
    return <div className={styles.state}>Sign in to inspect sales.</div>;
  }

  const lots: AdminSaleLot[] = Array.isArray(audit?.lots) ? audit.lots : [];
  const ledger: AdminSaleLedgerEntry[] = Array.isArray(audit?.ledger) ? audit.ledger : [];
  const issues = Array.isArray(audit?.checks?.issues) ? audit.checks.issues : [];

  return (
    <section className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <h3>Sales oversight</h3>
          <p className={styles.sub}>
            Read-only inspection of auction state, collection state, payout state, and related ledger entries.
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className={styles.filtersRow}>
        <div className={styles.filters} role="tablist" aria-label="Sale status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={status === f.id}
              className={[
                styles.filterBtn,
                status === f.id ? styles.filterActive : "",
              ].join(" ")}
              onClick={() => {
                setStatus(f.id);
                setOffset(0);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <form
        className={styles.searchRow}
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
      >
        <input
          className={styles.searchInput}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search sale title, description, or host…"
          aria-label="Search sales"
        />
        <input
          className={styles.hostInput}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="Exact host username"
          aria-label="Host username filter"
        />
        <button type="submit" className={styles.searchBtn}>
          Search
        </button>
        <button type="button" className={styles.clearBtn} onClick={clearFilters}>
          Clear
        </button>
      </form>

      {note && <div className={styles.note}>{note}</div>}

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={styles.skeletonList}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonRow} aria-hidden="true" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>No sales match this filter.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sale</th>
                <th>House</th>
                <th>Status</th>
                <th>Access</th>
                <th className={styles.numCell}>Lots</th>
                <th className={styles.numCell}>Sold</th>
                <th className={styles.numCell}>Paid</th>
                <th className={styles.numCell}>Unpaid</th>
                <th>Hammer</th>
                <th>Payout</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const attention =
                  (typeof s.unpaid_count === "number" && s.unpaid_count > 0) ||
                  (s.status === "ended" && !s.settled_at) ||
                  (s.settled_at && (s.payout_status || "none") === "none");

                return (
                  <tr key={s.id} className={attention ? styles.attentionRow : ""}>
                    <td>
                      <div className={styles.saleCell}>
                        <span className={styles.saleTitle}>{s.title || "Untitled sale"}</span>
                        <span className={styles.saleMeta}>#{s.id}</span>
                      </div>
                    </td>
                    <td>
                      <div className={styles.identity}>
                        {s.host_avatar ? (
                          <img src={s.host_avatar} alt="" className={styles.avatar} />
                        ) : (
                          <span className={styles.avatarFallback}>
                            {(s.host_display || s.host_username || "?").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div>
                          <strong>{s.host_display || s.host_username || "unknown"}</strong>
                          <span className={styles.handle}>@{s.host_username}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`${styles.badge} ${saleStatusClass(s.status)}`}>
                        {s.status || "—"}
                      </span>
                    </td>
                    <td>
                      <span className={styles.tierBadge}>{s.tier || "open"}</span>
                    </td>
                    <td className={styles.numCell}>{s.lot_count ?? 0}</td>
                    <td className={styles.numCell}>{s.sold_count ?? 0}</td>
                    <td className={styles.numCell}>{s.paid_count ?? 0}</td>
                    <td className={styles.numCell}>
                      {typeof s.unpaid_count === "number" && s.unpaid_count > 0 ? (
                        <span className={styles.unpaidFlag}>{s.unpaid_count}</span>
                      ) : (
                        s.unpaid_count ?? 0
                      )}
                    </td>
                    <td>{formatMoney(s.hammer_total, s.currency)}</td>
                    <td>
                      <span className={`${styles.badge} ${payoutStatusClass(s.payout_status)}`}>
                        {s.payout_status || "none"}
                      </span>
                    </td>
                    <td className={styles.dateCell}>
                      {formatDate(s.settled_at || s.ended_at || s.ends_at || s.created_at)}
                    </td>
                    <td className={styles.actionCell}>
                      <button
                        type="button"
                        className={styles.auditBtn}
                        onClick={() => openAudit(s.id!)}
                        disabled={selectedId === s.id && auditLoading}
                      >
                        {selectedId === s.id && auditLoading ? "Loading…" : "Audit"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE && (
        <div className={styles.pager}>
          <span className={styles.range}>
            {from}–{to} of {total}
          </span>
          <div className={styles.pagerBtns}>
            <button
              type="button"
              disabled={offset === 0 || loading}
              className={styles.pageBtn}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Prev
            </button>
            <span className={styles.pageInfo}>
              Page {page} / {pages}
            </span>
            <button
              type="button"
              disabled={to >= total || loading}
              className={styles.pageBtn}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {selectedId !== null && (
        <aside className={styles.auditPanel} aria-label="Sale audit panel">
          <div className={styles.auditHead}>
            <div>
              <h3>Audit · Sale #{selectedId}</h3>
              <p>
                {audit?.sale?.title || "Loading sale…"}
                {audit?.sale?.host_username ? ` · @${audit.sale.host_username}` : ""}
              </p>
            </div>
            <button type="button" className={styles.closeBtn} onClick={closeAudit}>
              Close
            </button>
          </div>

          {auditError && (
            <div className={styles.errorBanner} role="alert">
              <span>{auditError}</span>
              <button type="button" onClick={() => openAudit(selectedId)}>
                Retry
              </button>
            </div>
          )}

          {auditLoading && !audit ? (
            <div className={styles.auditSkeleton}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={styles.auditSkeletonRow} aria-hidden="true" />
              ))}
            </div>
          ) : audit ? (
            <div className={styles.auditBody}>
              <div className={styles.auditGrid}>
                <div className={styles.auditCard}>
                  <h4>Sale state</h4>
                  <dl className={styles.definitionList}>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <span className={`${styles.badge} ${saleStatusClass(audit.sale?.status)}`}>
                          {audit.sale?.status || "—"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Access</dt>
                      <dd>{audit.sale?.tier || "open"}</dd>
                    </div>
                    <div>
                      <dt>Currency</dt>
                      <dd>{audit.sale?.currency || "—"}</dd>
                    </div>
                    <div>
                      <dt>Ends</dt>
                      <dd>{formatDate(audit.sale?.ends_at)}</dd>
                    </div>
                    <div>
                      <dt>Ended</dt>
                      <dd>{formatDate(audit.sale?.ended_at)}</dd>
                    </div>
                    <div>
                      <dt>Settled</dt>
                      <dd>{formatDate(audit.sale?.settled_at)}</dd>
                    </div>
                    <div>
                      <dt>Payout</dt>
                      <dd>
                        <span className={`${styles.badge} ${payoutStatusClass(audit.sale?.payout_status)}`}>
                          {audit.sale?.payout_status || "none"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Payout ref</dt>
                      <dd className={styles.mono}>
                        {audit.sale?.payout_reference || "—"}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className={styles.auditCard}>
                  <h4>Collection checks</h4>
                  <div className={styles.checkGrid}>
                    <div className={styles.checkTile}>
                      <span>Lots</span>
                      <strong>{audit.checks?.lot_count ?? lots.length}</strong>
                    </div>
                    <div className={styles.checkTile}>
                      <span>Sold</span>
                      <strong>{audit.checks?.sold_count ?? 0}</strong>
                    </div>
                    <div className={styles.checkTile}>
                      <span>Paid</span>
                      <strong>{audit.checks?.paid_count ?? 0}</strong>
                    </div>
                    <div className={styles.checkTile}>
                      <span>Pending</span>
                      <strong>{audit.checks?.pending_count ?? 0}</strong>
                    </div>
                    <div className={styles.checkTile}>
                      <span>Unpaid / failed</span>
                      <strong>{audit.checks?.unpaid_count ?? 0}</strong>
                    </div>
                  </div>

                  {issues.length > 0 ? (
                    <ul className={styles.issueList}>
                      {issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.okNote}>No obvious stuck state detected.</p>
                  )}
                </div>

                <div className={styles.auditCard}>
                  <h4>Payout profile</h4>
                  {audit.payout_profile ? (
                    <dl className={styles.definitionList}>
                      <div>
                        <dt>Business</dt>
                        <dd>{audit.payout_profile.business_name || "—"}</dd>
                      </div>
                      <div>
                        <dt>Account name</dt>
                        <dd>{audit.payout_profile.account_name || "—"}</dd>
                      </div>
                      <div>
                        <dt>Bank code</dt>
                        <dd>{audit.payout_profile.bank_code || "—"}</dd>
                      </div>
                      <div>
                        <dt>Currency</dt>
                        <dd>{audit.payout_profile.currency || "—"}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{audit.payout_profile.status || "—"}</dd>
                      </div>
                      <div>
                        <dt>Recipient on file</dt>
                        <dd>{audit.payout_profile.has_recipient ? "Yes" : "No"}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>{formatDate(audit.payout_profile.updated_at)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className={styles.emptySmall}>No payout profile on file.</p>
                  )}
                </div>
              </div>

              <div className={styles.auditSection}>
                <h4>Lots</h4>
                {lots.length === 0 ? (
                  <p className={styles.emptySmall}>No lots recorded for this sale.</p>
                ) : (
                  <div className={styles.innerTableWrap}>
                    <table className={styles.innerTable}>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Winner</th>
                          <th>Sold price</th>
                          <th>Payment</th>
                          <th>Reference</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lots.map((l) => (
                          <tr key={l.id}>
                            <td>{l.position ?? "—"}</td>
                            <td className={styles.lotTitleCell}>{l.title || "Untitled lot"}</td>
                            <td>{l.status || "—"}</td>
                            <td>{l.winner_username || "—"}</td>
                            <td>{formatMoney(l.sold_price, l.currency)}</td>
                            <td>
                              <span className={`${styles.badge} ${paymentStatusClass(l.payment_status)}`}>
                                {l.payment_status || "unpaid"}
                              </span>
                            </td>
                            <td className={styles.monoCell}>{l.payment_reference || "—"}</td>
                            <td>{formatDate(l.payment_updated_at || l.hammer_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className={styles.auditSection}>
                <h4>Ledger trail</h4>
                {ledger.length === 0 ? (
                  <p className={styles.emptySmall}>
                    No ledger entries are linked to this sale yet.
                  </p>
                ) : (
                  <ul className={styles.ledgerList}>
                    {ledger.map((entry, i) => (
                      <li key={i} className={styles.ledgerRow}>
                        <span className={styles.ledgerDot} />
                        <div className={styles.ledgerMain}>
                          <span className={styles.ledgerKind}>
                            {entry.kind || "entry"}
                            {entry.ref_table ? ` · ${entry.ref_table}` : ""}
                            {typeof entry.ref_id === "number" ? ` #${entry.ref_id}` : ""}
                          </span>
                          <span className={styles.ledgerMeta}>
                            {entry.user_name || "—"} · {formatMoney(entry.amount, entry.currency)} ·{" "}
                            {formatDate(entry.created_at)}
                          </span>
                          {entry.reference && (
                            <span className={styles.ledgerRef}>{entry.reference}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </aside>
      )}
    </section>
  );
}