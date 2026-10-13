#!/usr/bin/env bash
set -e

echo "Current directory:"
pwd

echo
echo "Checking backend files..."

if [ ! -f routers/sales.py ]; then
  echo "ERROR: routers/sales.py not found"
  exit 1
fi

if [ ! -f routers/webhooks.py ]; then
  echo "ERROR: routers/webhooks.py not found"
  exit 1
fi

if [ ! -f main.py ]; then
  echo "ERROR: main.py not found"
  exit 1
fi

echo
echo "--- sales.py money logic ---"
grep -n "initialize_charge\|_attempt_settle_charges\|payout_status\|payment_status='pending'" routers/sales.py

echo
echo "--- sales.py collect endpoint ---"
grep -n "collect" routers/sales.py

echo
echo "--- webhooks.py escrow + per-lot paid flip ---"
grep -n "ESCROW\|payment_status='paid' WHERE id" routers/webhooks.py

echo
echo "--- main.py router imports/includes ---"
grep -n "from routers import\|include_router" main.py

echo
echo "--- import main ---"
python -c "import main; print('main import ok')"

echo
echo "--- route dump ---"
python routes_check.py

echo
echo "Backend verification complete."