import sys

from db import get_db


def main():
    if len(sys.argv) > 1:
        username = sys.argv[1].strip()
    else:
        username = input("username: ").strip()

    if not username:
        print("username required")
        return

    conn = get_db()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT username, role FROM users WHERE username = %s",
            (username,),
        )
        row = cursor.fetchone()

        if not row:
            print(f"unknown user: {username}")
            return

        old_role = row["role"]

        cursor.execute(
            "UPDATE users SET role = 'house' WHERE username = %s",
            (username,),
        )

        conn.commit()

        print(f"{username}: role changed from '{old_role}' to 'house'")
    finally:
        conn.close()


if __name__ == "__main__":
    main()