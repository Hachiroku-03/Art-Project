import importlib

mods = [
    "routers.feed",
    "routers.sales",
    "routers.profile",
    "routers.chat",
    "routers.chat_features",
    "routers.auctions",
    "routers.settings",
    "routers.notifications",
    "routers.community",
    "routers.webhooks",
    "notification_service",
]

for name in mods:
    try:
        mod = importlib.import_module(name)
        router = getattr(mod, "router", None)
        if router is None:
            print(f"{name}: no router attribute")
            continue

        routes = getattr(router, "routes", [])
        paths = []
        for r in routes:
            p = getattr(r, "path", None)
            if p:
                paths.append(p)

        print(f"{name}: {len(routes)} routes")
        for p in sorted(set(paths))[:20]:
            print("  ", p)
        if len(set(paths)) > 20:
            print("   ...")
    except Exception as e:
        print(f"{name}: ERROR {e}")