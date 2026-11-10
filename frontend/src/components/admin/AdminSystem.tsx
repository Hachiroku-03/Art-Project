import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAudienceCount, sendBroadcast } from "./adminApi";
import type { AudienceCountResponse } from "./types";
import styles from "./AdminSystem.module.css";

const AUDIENCES = [
  { id: "all", label: "Everyone", hint: "All registered members." },
  { id: "houses", label: "Houses", hint: "Accredited houses only (role = house)." },
  { id: "vip", label: "VIP members", hint: "Members on the cached vip tier." },
  { id: "artist", label: "Artists", hint: "Everyone who is not a house." },
  { id: "single", label: "One member", hint: "Target a single username." },
] as const;
type AudienceId = (typeof AUDIENCES)[number]["id"];

const TITLE_MAX = 140;
const BODY_MAX = 1000;

function makeRef(): string {
  // Client trace id. Not a dedupe key (no broadcasts table) — just a handle
  // to correlate a sent notice with the action that produced it.
  return `bc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type Props = { viewer: string };

export default function AdminSystem({ viewer }: Props) {
  const [audience, setAudience] = useState<AudienceId>("all");
  const [username, setUsername] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [preview, setPreview] = useState<AudienceCountResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Clear the blast-radius preview whenever the targeting changes, so you can
  // never send against a stale count.
  const retarget = (fn: () => void) => {
    fn();
    setPreview(null);
    setError(null);
  };

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const runPreview = async () => {
    if (!viewer) return;
    if (audience === "single" && !username.trim()) {
      setError("Enter a username to preview a single-member broadcast.");
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await fetchAudienceCount(viewer, audience, username.trim(), ctrl.signal);
      if (res?.error) { setError(res.error); setPreview(null); }
      else setPreview(res);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "could not count audience");
      setPreview(null);
    } finally {
      if (!ctrl.signal.aborted) setPreviewLoading(false);
    }
  };

  const canSend =
    !!viewer &&
    !sending &&
    !!preview &&
    !previewLoading &&
    (preview.count ?? 0) > 0 &&
    preview.over_cap !== true &&
    !(audience === "single" && preview.exists === false) &&
    title.trim().length > 0 &&
    body.trim().length > 0;

  const handleSend = async () => {
    if (!canSend || !preview) return;
    const n = preview.count ?? 0;
    const ok = window.confirm(
      `Send this system notice to ${n} member${n === 1 ? "" : "s"}?\n\n` +
      `"${title.trim()}"\n\nThis cannot be unsent.`
    );
    if (!ok) return;

    setSending(true);
    setError(null);
    try {
      const res = await sendBroadcast(viewer, {
        audience,
        username: audience === "single" ? username.trim() : undefined,
        title: title.trim(),
        body: body.trim(),
        broadcast_ref: makeRef(),
      });
      if (res?.error) {
        setError(res.error);
      } else {
        flash(`Broadcast sent to ${res.sent ?? 0} member(s).`);
        setTitle("");
        setBody("");
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "broadcast failed");
    } finally {
      setSending(false);
    }
  };

  if (!viewer) {
    return <div className={styles.state}>Sign in to send system notices.</div>;
  }

  const count = preview?.count;
  const overCap = preview?.over_cap === true;
  const singleMissing = audience === "single" && preview?.exists === false;

  return (
    <section className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <h3>System broadcast</h3>
          <p className={styles.sub}>
            Send one platform notice to a member audience. Atomic: every
            recipient gets it or none do. Does not touch money or content.
          </p>
        </div>
      </div>

      {toast && <div className={styles.toast}>{toast}</div>}
      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className={styles.form}>
        <fieldset className={styles.fieldset}>
          <legend>Audience</legend>
          <div className={styles.audienceGrid}>
            {AUDIENCES.map((a) => (
              <label
                key={a.id}
                className={[
                  styles.audienceOption,
                  audience === a.id ? styles.audienceActive : "",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="audience"
                  value={a.id}
                  checked={audience === a.id}
                  onChange={() => retarget(() => setAudience(a.id))}
                />
                <span className={styles.audienceLabel}>{a.label}</span>
                <span className={styles.audienceHint}>{a.hint}</span>
              </label>
            ))}
          </div>

          {audience === "single" && (
            <div className={styles.singleRow}>
              <label className={styles.fieldLabel} htmlFor="bc-username">
                Username
              </label>
              <input
                id="bc-username"
                className={styles.textInput}
                value={username}
                onChange={(e) => retarget(() => setUsername(e.target.value))}
                placeholder="e.g. emma"
                autoComplete="off"
              />
            </div>
          )}
        </fieldset>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="bc-title">
            Title <span className={styles.counter}>{title.length}/{TITLE_MAX}</span>
          </label>
          <input
            id="bc-title"
            className={styles.textInput}
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Scheduled maintenance"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="bc-body">
            Message <span className={styles.counter}>{body.length}/{BODY_MAX}</span>
          </label>
          <textarea
            id="bc-body"
            className={styles.textarea}
            value={body}
            maxLength={BODY_MAX}
            onChange={(e) => setBody(e.target.value)}
            placeholder="The Space will be briefly unavailable tonight while we upgrade the auction floor."
            rows={4}
          />
        </div>

        <div className={styles.previewBox}>
          <div className={styles.previewHead}>
            <span>Blast radius</span>
            <button
              type="button"
              className={styles.previewBtn}
              onClick={runPreview}
              disabled={previewLoading || (audience === "single" && !username.trim())}
            >
              {previewLoading ? "Counting…" : "Preview recipients"}
            </button>
          </div>

          {!preview ? (
            <p className={styles.previewEmpty}>
              Preview first — the Send button stays locked until you can see
              exactly how many members this reaches.
            </p>
          ) : (
            <div className={styles.previewResult}>
              <div className={styles.previewCount}>
                <strong>{count ?? 0}</strong>
                <span>member{count === 1 ? "" : "s"}</span>
              </div>
              {overCap && (
                <p className={styles.previewWarn}>
                  Over the per-send cap ({preview.cap}). Narrow the audience or
                  raise BROADCAST_MAX_RECIPIENTS deliberately. Send is locked.
                </p>
              )}
              {singleMissing && (
                <p className={styles.previewWarn}>
                  That username doesn’t exist. Send is locked.
                </p>
              )}
              {!overCap && !singleMissing && (count ?? 0) === 0 && (
                <p className={styles.previewMuted}>
                  No members match this audience right now.
                </p>
              )}
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!canSend}
          >
            {sending ? "Sending…" : "Send broadcast"}
          </button>
          <span className={styles.actionsHint}>
            Category is fixed to “system”. Recipients see it in their bell.
          </span>
        </div>
      </div>
    </section>
  );
}