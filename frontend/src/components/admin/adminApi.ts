import type { AdminOverviewData } from "./types";

// ---------------------------------------------------------------------------
// Admin endpoints live in auth_server.py — the AUTH service, NOT the feed
// service. Render: the-space-gallery. Local: http://localhost:8000.
// If your app already exposes an auth base (e.g. from api.ts), replace this
// constant with that helper so the fetch shares your existing config.
// ---------------------------------------------------------------------------
const AUTH_API =
  (import.meta.env.VITE_AUTH_API_URL as string | undefined)?.replace(/\/+$/, "") ||
  "http://localhost:8000";

// The backend trusts a `viewer` query string (same model as every other router)
// and enforces admin SERVER-SIDE via ADMIN_USERNAMES / role == "admin". The UI
// gate is convenience; this call is the real boundary.
export async function fetchAdminOverview(
  viewer: string,
  signal?: AbortSignal
): Promise<AdminOverviewData> {
  const url = `${AUTH_API}/admin/overview?viewer=${encodeURIComponent(viewer)}`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") detail = body.error;
    } catch {
      /* non-JSON error body — keep the status text */
    }
    throw new Error(detail);
  }

  return (await res.json()) as AdminOverviewData;
}

import type { AdminHousesResponse, AdminActionResponse } from "./types";

// ... existing AUTH_API constant and fetchAdminOverview stay unchanged ...

export async function fetchAdminHouses(
  viewer: string,
  status: string = "pending",
  signal?: AbortSignal
): Promise<AdminHousesResponse> {
  const url = `${AUTH_API}/admin/houses/applications?viewer=${encodeURIComponent(viewer)}&status=${encodeURIComponent(status)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try { const b = await res.json(); if (b?.error) detail = b.error; } catch {}
    throw new Error(detail);
  }
  return (await res.json()) as AdminHousesResponse;
}

export async function adminApproveApplication(
  viewer: string,
  appId: number
): Promise<AdminActionResponse> {
  const res = await fetch(`${AUTH_API}/admin/houses/applications/${appId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer }),
  });
  return (await res.json()) as AdminActionResponse;
}

export async function adminRejectApplication(
  viewer: string,
  appId: number,
  reason?: string
): Promise<AdminActionResponse> {
  const res = await fetch(`${AUTH_API}/admin/houses/applications/${appId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer, reason: reason || "" }),
  });
  return (await res.json()) as AdminActionResponse;
}

export async function adminRevokeHouse(
  viewer: string,
  username: string
): Promise<AdminActionResponse> {
  const res = await fetch(`${AUTH_API}/admin/houses/${encodeURIComponent(username)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer }),
  });
  return (await res.json()) as AdminActionResponse;
}

import type { AdminUsersResponse } from "./types";

// ... existing AUTH_API + overview/houses functions stay unchanged ...

export async function fetchAdminUsers(
  viewer: string,
  opts: { q?: string; role?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<AdminUsersResponse> {
  const params = new URLSearchParams();
  params.set("viewer", viewer);
  if (opts.q) params.set("q", opts.q);
  if (opts.role && opts.role !== "all") params.set("role", opts.role);
  params.set("limit", String(opts.limit ?? 30));
  params.set("offset", String(opts.offset ?? 0));

  const url = `${AUTH_API}/admin/users?${params.toString()}`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try { const b = await res.json(); if (b?.error) detail = b.error; } catch {}
    throw new Error(detail);
  }
  return (await res.json()) as AdminUsersResponse;
}

import type { AdminReportsResponse, AdminModerationAction } from "./types";

// ... existing AUTH_API + overview/houses/users functions stay unchanged ...

// Moderation lives on the FEED service (art-project-v4u4 / localhost:8001),
// NOT auth. If your app already has a feed base helper (api.ts), use it here.
const FEED_API =
  (import.meta.env.VITE_FEED_API_URL as string | undefined)?.replace(/\/+$/, "") ||
  "http://localhost:8001";

export async function fetchAdminReports(
  viewer: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<AdminReportsResponse> {
  const params = new URLSearchParams();
  params.set("viewer", viewer);
  params.set("status", opts.status || "open");
  params.set("limit", String(opts.limit ?? 30));
  params.set("offset", String(opts.offset ?? 0));

  const url = `${FEED_API}/admin/reports?${params.toString()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try { const b = await res.json(); if (b?.error) detail = b.error; } catch {}
    throw new Error(detail);
  }
  return (await res.json()) as AdminReportsResponse;
}

async function postModerationAction(
  url: string,
  viewer: string,
  extra: Record<string, unknown> = {}
): Promise<AdminModerationAction> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer, ...extra }),
  });
  return (await res.json()) as AdminModerationAction;
}

export const adminResolveReport = (viewer: string, id: number) =>
  postModerationAction(`${FEED_API}/admin/reports/${id}/resolve`, viewer);
export const adminDismissReport = (viewer: string, id: number) =>
  postModerationAction(`${FEED_API}/admin/reports/${id}/dismiss`, viewer);
export const adminRemovePost = (viewer: string, postId: number) =>
  postModerationAction(`${FEED_API}/admin/posts/${postId}/remove`, viewer);
export const adminRemoveComment = (viewer: string, commentId: number) =>
  postModerationAction(`${FEED_API}/admin/comments/${commentId}/remove`, viewer);

import type { AdminSalesResponse, AdminSaleAuditResponse } from "./types";

// ... existing AUTH_API / FEED_API and previous functions stay unchanged ...

export async function fetchAdminSales(
  viewer: string,
  opts: {
    status?: string;
    host?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {},
  signal?: AbortSignal
): Promise<AdminSalesResponse> {
  const params = new URLSearchParams();
  params.set("viewer", viewer);
  params.set("status", opts.status || "all");
  if (opts.host) params.set("host", opts.host);
  if (opts.q) params.set("q", opts.q);
  params.set("limit", String(opts.limit ?? 30));
  params.set("offset", String(opts.offset ?? 0));

  const url = `${FEED_API}/admin/sales?${params.toString()}`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }

  return (await res.json()) as AdminSalesResponse;
}

export async function fetchAdminSaleAudit(
  viewer: string,
  saleId: number,
  signal?: AbortSignal
): Promise<AdminSaleAuditResponse> {
  const url = `${FEED_API}/admin/sales/${saleId}/audit?viewer=${encodeURIComponent(viewer)}`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }

  return (await res.json()) as AdminSaleAuditResponse;
}

import type { AudienceCountResponse, BroadcastResponse } from "./types";

// ... existing AUTH_API / FEED_API and all prior functions stay unchanged ...

export async function fetchAudienceCount(
  viewer: string,
  audience: string,
  username?: string,
  signal?: AbortSignal
): Promise<AudienceCountResponse> {
  const params = new URLSearchParams();
  params.set("viewer", viewer);
  params.set("audience", audience);
  if (username) params.set("username", username);

  const url = `${FEED_API}/admin/system/audience-count?${params.toString()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try { const b = await res.json(); if (b?.error) detail = b.error; } catch {}
    throw new Error(detail);
  }
  return (await res.json()) as AudienceCountResponse;
}

export async function sendBroadcast(
  viewer: string,
  payload: {
    audience: string;
    username?: string;
    title: string;
    body: string;
    broadcast_ref?: string;
  }
): Promise<BroadcastResponse> {
  const res = await fetch(`${FEED_API}/admin/notifications/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer, ...payload }),
  });
  return (await res.json()) as BroadcastResponse;
}