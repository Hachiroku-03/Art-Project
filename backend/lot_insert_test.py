from db import get_db, init_db


def main():
    init_db()

    conn = get_db()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id, host_username, status, currency FROM auctions WHERE id = %s",
            (8,),
        )
        sale = cursor.fetchone()
        print("sale:", dict(sale) if sale else None)

        if not sale:
            print("Sale 8 not found")
            return

        cursor.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lots WHERE sale_id = %s",
            (8,),
        )
        position = int(cursor.fetchone()["p"])
        print("next position:", position)

        cursor.execute(
            """
            INSERT INTO lots (
                sale_id,
                position,
                title,
                description,
                image_url,
                starting_price,
                reserve,
                estimate_low,
                estimate_high,
                currency,
                status
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'sealed')
            RETURNING id, position, title, status, currency
            """,
            (
                8,
                position,
                "Direct DB Test Lot",
                "Inserted by script",
                "",
                1000,
                1500,
                2000,
                3000,
                "NGN",
            ),
        )

        lot = cursor.fetchone()
        print("inserted lot:", dict(lot) if lot else None)

        # Rollback so this test does not create real data.
        conn.rollback()
        print("rollback complete — no permanent row inserted")
    except Exception as e:
        conn.rollback()
        print("ERROR:", e)
    finally:
        conn.close()


if __name__ == "__main__":
    main()