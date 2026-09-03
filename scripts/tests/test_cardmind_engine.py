from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from cardmind_engine import (  # noqa: E402
    apply_knowledge_payload,
    connect_db,
    get_status,
    ingest_path,
    ingest_record,
    list_topics,
    pending_conversations,
)


def chat_export(include_follow_up: bool) -> list[dict[str, object]]:
    mapping: dict[str, object] = {
        "root": {"id": "root", "parent": None, "children": ["n1"], "message": None},
        "n1": {
            "id": "n1",
            "parent": "root",
            "children": ["n2"],
            "message": {
                "id": "m1",
                "author": {"role": "user"},
                "create_time": 1,
                "content": {"content_type": "text", "parts": ["线程和进程有什么区别？"]},
                "metadata": {},
            },
        },
        "n2": {
            "id": "n2",
            "parent": "n1",
            "children": ["n3"] if include_follow_up else [],
            "message": {
                "id": "m2",
                "author": {"role": "assistant"},
                "create_time": 2,
                "content": {"content_type": "text", "parts": ["线程共享进程资源，但拥有独立执行上下文。"]},
                "metadata": {},
            },
        },
    }
    current_node = "n2"
    if include_follow_up:
        mapping.update(
            {
                "n3": {
                    "id": "n3",
                    "parent": "n2",
                    "children": ["n4"],
                    "message": {
                        "id": "m3",
                        "author": {"role": "user"},
                        "create_time": 3,
                        "content": {"content_type": "text", "parts": ["互斥锁解决什么问题？"]},
                        "metadata": {},
                    },
                },
                "n4": {
                    "id": "n4",
                    "parent": "n3",
                    "children": [],
                    "message": {
                        "id": "m4",
                        "author": {"role": "assistant"},
                        "create_time": 4,
                        "content": {"content_type": "text", "parts": ["互斥锁保护共享状态，避免数据竞争。"]},
                        "metadata": {},
                    },
                },
            }
        )
        current_node = "n4"

    return [
        {
            "id": "conv-1",
            "title": "C++ 并发编程入门",
            "create_time": 1,
            "update_time": 4 if include_follow_up else 2,
            "current_node": current_node,
            "mapping": mapping,
        }
    ]


class CardMindEngineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.db_path = self.root / "note.db"
        self.connection = connect_db(self.db_path)
        self.connection.execute(
            """
            create table knowledge_cards (
              id integer primary key autoincrement,
              question text not null,
              answer text not null,
              tagsJson text not null default '[]',
              sourceType text not null default 'manual',
              sourceRef text,
              sourceTitle text,
              sourceSnippet text,
              createdAt integer not null,
              updatedAt integer not null,
              deleted integer not null default 0
            )
            """
        )
        self.connection.execute(
            """
            create table marks (
              id integer primary key autoincrement,
              content text,
              desc text,
              url text,
              deleted integer not null default 0
            )
            """
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.temp_dir.cleanup()

    def write_export(self, name: str, include_follow_up: bool) -> Path:
        path = self.root / name
        path.write_text(json.dumps(chat_export(include_follow_up), ensure_ascii=False), encoding="utf-8")
        return path

    def test_incremental_ingest_only_adds_new_messages(self) -> None:
        first = ingest_path(self.connection, self.write_export("first.json", False))
        self.assertEqual(first["inputConversations"], 1)
        self.assertEqual(first["newMessages"], 2)
        self.assertEqual(first["pendingMessages"], 2)

        repeated = ingest_path(self.connection, self.write_export("repeat.json", False))
        self.assertEqual(repeated["newMessages"], 0)
        self.assertEqual(repeated["changedMessages"], 0)
        self.assertEqual(repeated["pendingMessages"], 2)

        follow_up = ingest_path(self.connection, self.write_export("follow-up.json", True))
        self.assertEqual(follow_up["newMessages"], 2)
        self.assertEqual(follow_up["pendingMessages"], 4)

        pending = pending_conversations(self.connection)
        self.assertEqual(len(pending), 1)
        self.assertEqual([message["externalMessageId"] for message in pending[0]["messages"]], ["m1", "m2", "m3", "m4"])

    def test_apply_payload_creates_topic_points_edges_and_legacy_cards(self) -> None:
        ingest_path(self.connection, self.write_export("conversation.json", True))
        payload = {
            "conversationId": "conv-1",
            "topics": [
                {
                    "slug": "cpp-concurrency",
                    "title": "C++ 并发编程",
                    "description": "线程、同步与并发数据结构",
                    "confidence": 0.98,
                    "knowledge": [
                        {
                            "canonicalKey": "线程基础",
                            "title": "线程基础",
                            "question": "线程与进程的核心区别是什么？",
                            "answer": "线程共享进程资源，但拥有独立执行上下文。",
                            "kind": "mainline",
                            "confidence": 0.99,
                            "sortOrder": 1,
                            "sourceMessageIds": ["m1", "m2"],
                        },
                        {
                            "canonicalKey": "互斥锁",
                            "title": "互斥锁",
                            "question": "互斥锁解决什么问题？",
                            "answer": "互斥锁保护共享状态，避免数据竞争。",
                            "kind": "mainline",
                            "confidence": 0.97,
                            "sortOrder": 2,
                            "sourceMessageIds": ["m3", "m4"],
                        },
                    ],
                    "edges": [
                        {"from": "线程基础", "to": "互斥锁", "relation": "mainline-next", "strength": 1}
                    ],
                }
            ],
        }

        first = apply_knowledge_payload(self.connection, payload)
        self.assertEqual(first["createdPoints"], 2)
        self.assertEqual(first["processedMessages"], 4)
        self.assertEqual(first["pendingMessages"], 0)

        status = get_status(self.connection)
        self.assertEqual(status["topics"], 1)
        self.assertEqual(status["knowledgePoints"], 2)
        self.assertEqual(status["edges"], 1)
        self.assertEqual(list_topics(self.connection)[0]["title"], "C++ 并发编程")

        legacy_count = self.connection.execute("select count(*) from knowledge_cards").fetchone()[0]
        self.assertEqual(legacy_count, 2)

        repeated = apply_knowledge_payload(self.connection, payload)
        self.assertEqual(repeated["createdPoints"], 0)
        self.assertEqual(repeated["updatedPoints"], 0)
        self.assertEqual(repeated["skippedPoints"], 2)
        self.assertEqual(self.connection.execute("select count(*) from knowledge_cards").fetchone()[0], 2)

    def test_low_confidence_point_is_quarantined(self) -> None:
        payload = {
            "topics": [
                {
                    "title": "操作系统",
                    "knowledge": [
                        {
                            "title": "不确定结论",
                            "question": "这条结论可靠吗？",
                            "answer": "仍需要更多上下文。",
                            "kind": "derived",
                            "confidence": 0.6,
                        }
                    ],
                }
            ]
        }
        result = apply_knowledge_payload(self.connection, payload)
        self.assertEqual(result["quarantinedPoints"], 1)
        self.assertEqual(get_status(self.connection)["quarantinedPoints"], 1)
        self.assertEqual(self.connection.execute("select count(*) from knowledge_cards where deleted = 0").fetchone()[0], 0)

    def test_text_reimport_updates_stable_message_instead_of_duplicating_it(self) -> None:
        transcript = self.root / "conversation.md"
        transcript.write_text("## 我\n什么是数据竞争？\n\n## GPT\n两个线程并发访问同一数据。", encoding="utf-8")
        first = ingest_path(self.connection, transcript)
        self.assertEqual(first["newMessages"], 2)

        transcript.write_text(
            "## 我\n什么是数据竞争？\n\n## GPT\n两个线程并发访问同一数据，且至少一个线程执行写操作。",
            encoding="utf-8",
        )
        second = ingest_path(self.connection, transcript)
        self.assertEqual(second["newMessages"], 0)
        self.assertEqual(second["changedMessages"], 1)
        self.assertEqual(get_status(self.connection)["conversations"], 1)
        self.assertEqual(get_status(self.connection)["messages"], 2)

    def test_ingest_record_preserves_message_boundaries_and_is_idempotent(self) -> None:
        self.connection.execute(
            "insert into marks (content, desc, url, deleted) values (?, ?, ?, 0)",
            (
                "# 对话\n\n## 我\n线程和进程有什么区别？\n\n## GPT\n线程共享进程资源。",
                "并发编程\nChatGPT 对话 · 2 条可见消息",
                "https://chatgpt.com/share/example",
            ),
        )
        mark_id = int(self.connection.execute("select last_insert_rowid()").fetchone()[0])
        self.connection.commit()

        first = ingest_record(self.connection, mark_id)
        self.assertEqual(first["inputMessages"], 2)
        self.assertEqual(first["newMessages"], 2)
        pending = pending_conversations(self.connection)
        self.assertEqual(pending[0]["title"], "并发编程")
        self.assertEqual([message["role"] for message in pending[0]["messages"]], ["user", "assistant"])

        repeated = ingest_record(self.connection, mark_id)
        self.assertEqual(repeated["newMessages"], 0)
        self.assertEqual(repeated["changedMessages"], 0)
        self.assertEqual(get_status(self.connection)["messages"], 2)


if __name__ == "__main__":
    unittest.main()
