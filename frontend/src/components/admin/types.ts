// Shape returned by GET /admin/overview (auth service).
// Every field is OPTIONAL on purpose: if the backend drifts or isn't deployed
// yet, the guarded UI renders 0 / "—" instead of white-screening. This is the
// Settings-bug lesson (undefined.in_app) applied before it can happen.

export type AdminActivityItem = {
  kind?: string;
  title?: string;
  actor?: string;
  created_at?: string;     // ISO or ::text from the backend
  source_type?: string;
  source_id?: number | string;
};

export type AdminOverviewData = {
  users?: number;
  houses?: number;
  pending_house_applications?: number;
  live_sales?: number;
  upcoming_sales?: number;
  open_reports?: number;
  recent_activity?: AdminActivityItem[];
  error?: string;          // backend returns {"error": "..."} on non-admin / failure
};

// --- Houses ---

export type HouseApplication = {
  id?: number;
  user_id?: number;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  role?: string;
  house_name?: string;
  description?: string;
  evidence_url?: string;
  status?: string;            // pending | approved | rejected
  created_at?: string;
  decided_at?: string;
  decided_by?: string;
  sales_count?: number;
  admin_note?: string;
};

export type AdminHousesResponse = {
  applications?: HouseApplication[];
  status_filter?: string;
  error?: string;
};

export type AdminActionResponse = {
  message?: string;
  application_id?: number;
  username?: string;
  error?: string;
};

// --- Users (read-only oversight) ---

export type AdminUserRow = {
  id?: number;
  username?: string;
  email?: string;
  role?: string;            // artist | house
  tier?: string;            // standard | vip
  display_name?: string;
  avatar_url?: string;
  bio?: string;
  is_admin?: boolean;       // from ADMIN_USERNAMES, not role
  house_status?: string;    // pending | approved | rejected | revoked | none
  house_name?: string;
  sales_count?: number;     // omitted if auctions table absent
  reports_count?: number;   // omitted if posts/post_reports absent
  followers_count?: number; // omitted if follows absent
};

export type AdminUsersResponse = {
  users?: AdminUserRow[];
  total?: number;
  limit?: number;
  offset?: number;
  error?: string;
};

// --- Moderation (feed service) ---

export type AdminReportRow = {
  id?: number;
  post_id?: number;
  reporter?: string;
  reporter_username?: string;
  reporter_display?: string;
  reason?: string;
  note?: string;
  status?: string;            // open | resolved | dismissed
  created_at?: string;
  post_title?: string;
  post_type?: string;
  post_image?: string;
  post_removed?: boolean;
  author_username?: string;
  author_display?: string;
  author_avatar?: string;
};

export type AdminReportsResponse = {
  reports?: AdminReportRow[];
  total?: number;
  status_filter?: string;
  limit?: number;
  offset?: number;
  error?: string;
};

export type AdminModerationAction = {
  message?: string;
  id?: number;
  error?: string;
};

// --- Sales oversight (feed service) ---

export type AdminSaleRow = {
  id?: number;
  host_username?: string;
  host_display?: string;
  host_avatar?: string;
  title?: string;
  status?: string;
  tier?: string;
  currency?: string;
  starts_at?: string;
  ends_at?: string;
  ended_at?: string;
  settled_at?: string;
  payout_status?: string;
  payout_reference?: string;
  created_at?: string;
  lot_count?: number;
  sold_count?: number;
  paid_count?: number;
  pending_count?: number;
  unpaid_count?: number;
  hammer_total?: string;
  tickets_sold?: number;
};

export type AdminSalesResponse = {
  sales?: AdminSaleRow[];
  total?: number;
  status_filter?: string;
  host_filter?: string | null;
  query?: string | null;
  limit?: number;
  offset?: number;
  note?: string;
  error?: string;
};

export type AdminSaleLot = {
  id?: number;
  position?: number;
  title?: string;
  status?: string;
  currency?: string;
  starting_price?: string;
  estimate_low?: string;
  estimate_high?: string;
  sold_price?: string;
  winner_username?: string;
  payment_status?: string;
  payment_reference?: string;
  payment_updated_at?: string;
  hammer_at?: string;
  current_bid?: string;
  bid_count?: number;
};

export type AdminSaleLedgerEntry = {
  user_name?: string;
  amount?: string;
  currency?: string;
  kind?: string;
  reference?: string;
  ref_table?: string;
  ref_id?: number;
  created_at?: string;
};

export type AdminSalePayoutProfile = {
  business_name?: string;
  account_name?: string;
  bank_code?: string;
  currency?: string;
  status?: string;
  has_recipient?: boolean;
  updated_at?: string;
};

export type AdminSaleChecks = {
  lot_count?: number;
  sold_count?: number;
  paid_count?: number;
  pending_count?: number;
  unpaid_count?: number;
  issues?: string[];
};

export type AdminSaleAuditResponse = {
  sale?: AdminSaleRow & {
    description?: string;
    image_url?: string;
    ticket_currency?: string;
    ticket_price?: string;
    ticket_capacity?: number | null;
  };
  lots?: AdminSaleLot[];
  ledger?: AdminSaleLedgerEntry[];
  payout_profile?: AdminSalePayoutProfile | null;
  checks?: AdminSaleChecks;
  error?: string;
};

// --- System broadcast (feed service) ---

export type AudienceCountResponse = {
  audience?: string;
  username?: string | null;
  count?: number;
  exists?: boolean;        // only meaningful when audience == "single"
  over_cap?: boolean;
  cap?: number;
  error?: string;
};

export type BroadcastResponse = {
  message?: string;
  sent?: number;
  audience?: string;
  category?: string;
  broadcast_ref?: string | null;
  count?: number;          // present on the over-cap refusal
  cap?: number;
  error?: string;
};