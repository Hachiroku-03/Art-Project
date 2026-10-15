from db import get_db


def main():
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'lots'
            ORDER BY ordinal_position
            """
        )
        rows = cursor.fetchall()

        print("lots columns:")
        for r in rows:
            print(
                f"{r['column_name']:25} "
                f"{r['data_type']:20} "
                f"nullable={r['is_nullable']:5} "
                f"default={r['column_default']}"
            )
    finally:
        conn.close()


if __name__ == "__main__":
    main()