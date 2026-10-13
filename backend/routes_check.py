from collections import Counter
from main import app

paths = []
for r in app.routes:
    p = getattr(r, "path", None)
    if p:
        paths.append(p)

c = Counter(paths)

dupes = {p: n for p, n in c.items() if n > 1}
print("duplicate paths:", dupes or "none")
print("total distinct paths:", len(c))

groups = [
    "/sales",
    "/lots",
    "/auctions",
    "/webhooks",
    "/community/calls",
    "/notifications",
    "/account/settings",
    "/chat",
]

for g in groups:
    matched = sorted(p for p in c if g in p)
    print(f"\n{g}:")
    if matched:
        for p in matched:
            print(" ", p)
    else:
        print("  none")