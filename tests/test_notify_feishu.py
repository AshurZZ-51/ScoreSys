import contextlib
import io
import json
import os
import re
import sys
import unittest
from datetime import datetime
from unittest.mock import patch


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scripts.ci import notify_feishu


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.payload


class NotifyFeishuTest(unittest.TestCase):
    def setUp(self):
        self.environment = {
            "FEISHU_APP_ID": "app-id-secret",
            "FEISHU_APP_SECRET": "app-secret-value",
            "FEISHU_CHAT_ID": "oc_chat",
            "CI_PIPELINE_ID": "42",
            "CI_PIPELINE_URL": "https://gitlab.example/pipelines/42",
            "CI_COMMIT_BRANCH": "main",
            "CI_COMMIT_SHORT_SHA": "abc12345",
            "CI_COMMIT_TITLE": "Add deployment notifications",
            "GITLAB_USER_NAME": "Pipeline User",
            "CI_COMMIT_TIMESTAMP": "2026-08-26T01:02:03Z",
            "CI_JOB_STARTED_AT": "2026-08-26T08:00:00+08:00",
            "CI_PIPELINE_CREATED_AT": "2026-08-26T07:30:00+08:00",
            "CI_JOB_NAME": "notify-failure",
        }
        self.now = datetime.fromisoformat("2026-08-26T09:02:03+08:00")

    def build_card(self, status):
        with patch.dict(os.environ, self.environment, clear=True):
            config = notify_feishu.make_config(status)
        return notify_feishu.build_card(config, now=self.now)

    def assert_card_contract(self, card, *, title, labels):
        self.assertEqual(card["header"]["title"]["content"], title)
        content = card["elements"][0]["text"]["content"]
        self.assertEqual(re.findall(r"^\*\*(.+?)\*\*：", content, re.MULTILINE), labels)

        actions = card["elements"][1]["actions"]
        self.assertEqual(
            [action["text"]["content"] for action in actions],
            ["查看流水线", "访问系统"],
        )
        self.assertEqual(
            [action["url"] for action in actions],
            [
                "https://gitlab.example/pipelines/42",
                "https://nexus.youdoogo.com/scoringsys",
            ],
        )
        self.assertTrue(all(type(action["url"]) is str for action in actions))

    def test_success_card_matches_nexus_field_order(self):
        card = self.build_card("success")

        self.assert_card_contract(
            card,
            title="✅ 立项评审在线打分系统部署成功 #42",
            labels=["流水线", "分支", "提交", "触发者", "提交时间", "部署完成", "耗时", "访问地址"],
        )
        self.assertEqual(card["header"]["template"], "green")
        self.assertEqual(
            card["elements"][0]["text"]["content"].splitlines(),
            [
                "**流水线**：https://gitlab.example/pipelines/42",
                "**分支**：main",
                "**提交**：abc12345 Add deployment notifications",
                "**触发者**：Pipeline User",
                "**提交时间**：2026-08-26 09:02:03",
                "**部署完成**：2026-08-26 09:02:03",
                "**耗时**：1小时2分3秒",
                "**访问地址**：https://nexus.youdoogo.com/scoringsys",
            ],
        )

    def test_failure_card_matches_nexus_field_order(self):
        card = self.build_card("failure")

        self.assert_card_contract(
            card,
            title="❌ 立项评审在线打分系统流水线失败 #42",
            labels=[
                "通知任务",
                "流水线",
                "分支",
                "提交",
                "触发者",
                "提交时间",
                "通知时间",
                "耗时",
                "说明",
                "访问地址",
            ],
        )
        self.assertEqual(card["header"]["template"], "red")
        self.assertEqual(
            card["elements"][0]["text"]["content"].splitlines(),
            [
                "**通知任务**：notify-failure",
                "**流水线**：https://gitlab.example/pipelines/42",
                "**分支**：main",
                "**提交**：abc12345 Add deployment notifications",
                "**触发者**：Pipeline User",
                "**提交时间**：2026-08-26 09:02:03",
                "**通知时间**：2026-08-26 09:02:03",
                "**耗时**：1小时32分3秒",
                f"**说明**：{notify_feishu.FAILURE_EXPLANATION}",
                "**访问地址**：https://nexus.youdoogo.com/scoringsys",
            ],
        )

    def test_main_sends_interactive_card_without_printing_token(self):
        responses = iter(
            [
                FakeResponse({"code": 0, "tenant_access_token": "tenant-secret-token"}),
                FakeResponse({"code": 0, "data": {"message_id": "om_42"}}),
            ]
        )

        with patch.dict(os.environ, self.environment, clear=True), patch(
            "scripts.ci.notify_feishu.urlopen", side_effect=lambda *args, **kwargs: next(responses)
        ) as urlopen, contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = notify_feishu.main(["--status", "success"])

        self.assertEqual(result, 0)
        self.assertNotIn("tenant-secret-token", stdout.getvalue())
        self.assertIn("status=success message_id=om_42", stdout.getvalue())
        request = urlopen.call_args_list[1].args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["msg_type"], "interactive")
        self.assertEqual(body["receive_id"], "oc_chat")
        card = json.loads(body["content"])
        card_text = json.dumps(card)
        self.assertIn("https://gitlab.example/pipelines/42", card_text)
        self.assertIn("https://nexus.youdoogo.com/scoringsys", card_text)

    def test_nonzero_feishu_code_fails_without_exposing_response(self):
        with patch.dict(os.environ, self.environment, clear=True), patch(
            "scripts.ci.notify_feishu.urlopen",
            return_value=FakeResponse({"code": 999, "msg": "contains-app-secret-value"}),
        ), contextlib.redirect_stderr(io.StringIO()) as stderr:
            result = notify_feishu.main(["--status", "failure"])

        self.assertEqual(result, 1)
        self.assertEqual(
            stderr.getvalue(),
            "Feishu notification failed: Feishu token API rejected the request\n",
        )
        self.assertNotIn("app-secret-value", stderr.getvalue())

    def test_missing_required_variable_fails_clearly(self):
        environment = dict(self.environment)
        environment.pop("FEISHU_CHAT_ID")
        with patch.dict(os.environ, environment, clear=True), contextlib.redirect_stderr(io.StringIO()) as stderr:
            result = notify_feishu.main(["--status", "success"])

        self.assertEqual(result, 1)
        self.assertIn("FEISHU_CHAT_ID is required", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
