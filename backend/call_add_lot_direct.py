import traceback

import routers.sales as sales
from db import get_db as real_get_db


class TestConn:
    def __init__(self, conn):
        self._conn = conn

    def cursor(self):
        return self._conn.cursor()

    def commit(self):
        # Do not persist the test lot.
        self._conn.rollback()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


def main():
    original_get_db = sales.get_db

    sales.get_db = lambda: TestConn(original_get_db())

    try:
        result = sales.add_lot(
            8,
            {
                "viewer": "amanai",
                "title": "Direct Route Test Lot",
                "description": "Called directly, not through HTTP.",
                "starting_price": 1000,
                "reserve": 1500,
                "estimate_low": 2000,
                "estimate_high": 3000,
                "currency": "NGN",
            },
        )
        print("DIRECT RESULT:")
        print(result)
    except Exception:
        print("DIRECT EXCEPTION:")
        traceback.print_exc()
    finally:
        sales.get_db = original_get_db


if __name__ == "__main__":
    main()
