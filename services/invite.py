"""Admin CLI: uv run python services/invite.py add|list|revoke|enable|topup|reissue|delete|pause|resume."""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jev_ultrafast.config import load_dotenv  # noqa: E402
from jevsvc import invites  # noqa: E402
from jevsvc.store import Store  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="管理邀請碼")
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="新增邀請碼")
    add.add_argument("name")
    add.add_argument("--limit", type=int, default=invites.DEFAULT_LIMIT, help="這組邀請碼最多可查詢幾次（總共）")
    add.add_argument("--expires", help="YYYY-MM-DD")
    sub.add_parser("list", help="列出邀請碼、已用次數與 Jev 用量")
    for name, help_text in (
        ("revoke", "停用邀請碼"),
        ("enable", "重新啟用被停用的邀請碼"),
        ("reissue", "換一組新的邀請碼（舊的立刻失效，次數沿用）"),
        ("delete", "刪除這個人的邀請碼與紀錄"),
    ):
        sub.add_parser(name, help=help_text).add_argument("name")
    topup = sub.add_parser("topup", help="增加總次數上限")
    topup.add_argument("name")
    topup.add_argument("amount", type=int, help="增加幾次")
    sub.add_parser("pause", help="全部暫停服務（所有人的請求都會被拒絕）")
    sub.add_parser("resume", help="恢復服務")
    return parser


def run(args, store) -> None:
    if args.command == "add":
        code = invites.add(store, args.name, limit=args.limit, expires=args.expires)
        print(f"邀請碼：{code}")
        print("這組碼只會顯示一次，請直接傳給對方")
    elif args.command == "revoke":
        invites.revoke(store, args.name)
        print(f"已停用：{args.name}")
    elif args.command == "enable":
        invites.enable(store, args.name)
        print(f"已重新啟用：{args.name}")
    elif args.command == "topup":
        print(f"{args.name} 的總次數上限現在是 {invites.topup(store, args.name, args.amount)}")
    elif args.command == "reissue":
        print(f"新的邀請碼：{invites.reissue(store, args.name)}")
        print("舊的邀請碼已失效；這組碼只會顯示一次，請直接傳給對方")
    elif args.command == "delete":
        invites.delete(store, args.name)
        print(f"已刪除：{args.name}")
    elif args.command in ("pause", "resume"):
        invites.set_paused(store, args.command == "pause")
        print("已暫停全部服務，用 resume 恢復" if args.command == "pause" else "已恢復服務")
    else:
        print(f"{'名字':<16}{'總次數上限':>8}  {'到期日':<12}{'狀態':<6}{'已用':>8}{'Jev呼叫':>9}{'輸入token':>12}")
        for row in invites.list_invites(store):
            state = "已停用" if row["disabled"] else "使用中"
            expires = row["expires"] or "-"
            print(
                f"{row['name']:<16}{row['limit']:>8}  {expires:<12}{state:<6}{row['used']:>8}"
                f"{row['calls']:>9}{row['input_tokens']:>12}"
            )


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "add":  # check the input before asking for the database
        try:
            invites.parse_expires(args.expires)
            invites.check_limit(args.limit)
        except ValueError as exc:
            print(exc)
            return 1
    load_dotenv()
    url, token = os.environ.get("KV_REST_API_URL"), os.environ.get("KV_REST_API_TOKEN")
    if not url or not token:
        print("請在 .env 設定 KV_REST_API_URL 與 KV_REST_API_TOKEN")
        return 1
    try:
        run(args, Store(url, token))
    except ValueError as exc:
        print(exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
