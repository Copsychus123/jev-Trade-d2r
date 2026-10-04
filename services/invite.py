"""Admin CLI: uv run python services/invite.py add|list|revoke."""

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from jev_ultrafast.config import load_dotenv  # noqa: E402
from jevsvc import invites  # noqa: E402
from jevsvc.store import Store  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="管理邀請碼")
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="新增邀請碼")
    add.add_argument("name")
    add.add_argument("--limit", type=int, default=invites.DAILY_LIMIT)
    add.add_argument("--expires", help="YYYY-MM-DD")
    sub.add_parser("list", help="列出邀請碼")
    revoke = sub.add_parser("revoke", help="停用邀請碼")
    revoke.add_argument("name")
    args = parser.parse_args(argv)
    if args.command == "add" and args.expires:
        try:
            datetime.strptime(args.expires, "%Y-%m-%d")
        except ValueError:
            print("到期日格式必須是 YYYY-MM-DD")
            return 1
    load_dotenv()
    url, token = os.environ.get("KV_REST_API_URL"), os.environ.get("KV_REST_API_TOKEN")
    if not url or not token:
        print("請在 .env 設定 KV_REST_API_URL 與 KV_REST_API_TOKEN")
        return 1
    store = Store(url, token)
    try:
        if args.command == "add":
            code = invites.add(store, args.name, limit=args.limit, expires=args.expires)
            print(f"邀請碼：{code}")
            print("這組碼只會顯示一次，請直接傳給對方")
        elif args.command == "revoke":
            invites.revoke(store, args.name)
            print(f"已停用：{args.name}")
        else:
            print(f"{'名字':<16}{'每日上限':>8}  {'到期日':<12}{'狀態':<6}{'今天已用':>8}")
            for row in invites.list_invites(store, datetime.now(timezone.utc)):
                state = "已停用" if row["disabled"] else "使用中"
                expires = row["expires"] or "-"
                print(f"{row['name']:<16}{row['limit']:>8}  {expires:<12}{state:<6}{row['used_today']:>8}")
    except ValueError as exc:
        print(exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
