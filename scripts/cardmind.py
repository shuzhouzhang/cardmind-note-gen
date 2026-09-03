from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cardmind_engine import (
    apply_knowledge_payload,
    connect_db,
    default_db_path,
    get_status,
    ingest_path,
    ingest_record,
    list_topics,
    load_knowledge_payload,
    pending_conversations,
)


def json_output(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cardmind",
        description="CardMind 无 UI 知识导入引擎",
    )
    parser.add_argument(
        "--db",
        default=str(default_db_path()),
        help="SQLite 数据库路径，默认指向 CardMind 正式数据库",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("init", help="初始化知识引擎数据表")

    ingest = commands.add_parser("ingest", help="导入 ChatGPT 导出 ZIP、conversations.json 或文本对话")
    ingest.add_argument("path", help="输入文件路径")

    ingest_record_command = commands.add_parser("ingest-record", help="导入 CardMind 已保存的快速记录")
    ingest_record_command.add_argument("id", type=int, help="marks 表中的记录 ID")

    pending = commands.add_parser("pending", help="输出等待 AI 拆分的新消息")
    pending.add_argument("--limit", type=int, default=100, help="最多返回多少条消息")

    apply_command = commands.add_parser("apply", help="应用 AI 生成的结构化知识 JSON")
    apply_command.add_argument("path", help="知识载荷 JSON 路径")

    commands.add_parser("status", help="查看知识库和最近一次导入状态")
    commands.add_parser("topics", help="列出主题及知识点数量")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    db_path = Path(args.db).expanduser().resolve()

    try:
        with connect_db(db_path) as connection:
            if args.command == "init":
                result = {"ok": True, "db": str(db_path)}
            elif args.command == "ingest":
                result = ingest_path(connection, args.path)
            elif args.command == "ingest-record":
                result = ingest_record(connection, args.id)
            elif args.command == "pending":
                result = {
                    "db": str(db_path),
                    "conversations": pending_conversations(connection, max(1, args.limit)),
                }
            elif args.command == "apply":
                result = apply_knowledge_payload(connection, load_knowledge_payload(args.path))
            elif args.command == "status":
                result = {"db": str(db_path), **get_status(connection)}
            elif args.command == "topics":
                result = {"db": str(db_path), "topics": list_topics(connection)}
            else:
                parser.error(f"未知命令: {args.command}")
                return 2
        json_output(result)
        return 0
    except Exception as error:
        json_output({"ok": False, "error": str(error), "db": str(db_path)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
