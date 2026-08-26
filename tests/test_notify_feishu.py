import contextlib
import io
import json
import os
import sys
import unittest
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
            "CI_PROJECT_PATH": "ai/scoringsys",
            "CI_COMMIT_REF_NAME": "main",
            "CI_COMMIT_SHA": "abc123",
            "CI_PIPELINE_URL": "https://gitlab.example/pipelines/42",
        }

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
        card = json.loads(body["content"])
        card_text = json.dumps(card)
        self.assertIn("ai/scoringsys", card_text)
        self.assertIn("https://gitlab.example/pipelines/42", card_text)
        self.assertIn("https://nexus.youdoogo.com/scoringsys", card_text)
        actions = card["elements"][1]["actions"]
        self.assertEqual(
            [action["url"] for action in actions],
            [
                "https://gitlab.example/pipelines/42",
                "https://nexus.youdoogo.com/scoringsys",
            ],
        )
        self.assertTrue(all(isinstance(action["url"], str) for action in actions))

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
