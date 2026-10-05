from collections import Counter
from main import app

c = Counter()
for r in app.routes:
    p = getattr(r, "path", None)
    if p:
        c[p] += 1

dupes = {p: n for p, n in c.items() if n > 1}
print("duplicate paths:", dupes or "none")
print("call routes:", sorted(p for p in c if "/community/calls" in p))
print("total distinct paths:", len(c))