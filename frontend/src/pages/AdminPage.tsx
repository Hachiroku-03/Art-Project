import { useState } from "react";
import AdminShell, { ADMIN_TABS, type AdminTab } from "../components/admin/AdminShell";
import AdminOverview from "../components/admin/AdminOverview";
import AdminHouses from "../components/admin/AdminHouses";
import AdminUsers from "../components/admin/AdminUsers";
import AdminModeration from "../components/admin/AdminModeration";
import AdminSales from "../components/admin/AdminSales";
import AdminSystem from "../components/admin/AdminSystem";

type AdminPageProps = {
  viewer: string;
  isAdmin: boolean;
};

export function AdminPage({ viewer, isAdmin }: AdminPageProps) {
  const [tab, setTab] = useState<AdminTab>("overview");

  const availableTabs = ADMIN_TABS.filter((t) => t.available);
  const safeTab = availableTabs.some((t) => t.id === tab) ? tab : "overview";

  return (
    <AdminShell
      viewer={viewer}
      isAdmin={isAdmin}
      activeTab={safeTab}
      onTabChange={setTab}
    >
      {safeTab === "overview" && <AdminOverview viewer={viewer} />}
      {safeTab === "houses" && <AdminHouses viewer={viewer} />}
      {safeTab === "users" && <AdminUsers viewer={viewer} />}
      {safeTab === "moderation" && <AdminModeration viewer={viewer} />}
      {safeTab === "sales" && <AdminSales viewer={viewer} />}
      {safeTab === "system" && <AdminSystem viewer={viewer} />}
    </AdminShell>
  );
}

export default AdminPage;