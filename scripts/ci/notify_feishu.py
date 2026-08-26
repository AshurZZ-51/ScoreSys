#!/usr/bin/env python3
"""Send a CI status card to a Feishu chat through the App API."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
TOKEN_ENDPOINT = f"{FEISHU_API_BASE}/auth/v3/tenant_access_token/internal"
MESSAGE_ENDPOINT = f"{FEISHU_API_BASE}/im/v1/messages"
APPLICATION_URL = "https://nexus.youdoogo.com/scoringsys"
REQUEST_TIMEOUT_SECONDS = 15
SAFE_IDENTIFIER = re.compile(r"[^A-Za-z0-9_.:-]")


class NotificationError(RuntimeError):
    """An expected failure while creating or sending a notification."""


class ConfigurationError(NotificationError):
    """A required CI configuration value is missing."""


@dataclass(frozen=True)
class NotificationConfig:
    app_id: str
    app_secret: str
    chat_id: str
    status: str
    project: str
    ref: str
    commit: str
    pipeline_url: str


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


def optional_env(name: str, fallback: str = "unknown") -> str:
    return os.environ.get(name, "").strip() or fallback


def make_config(status: str) -> NotificationConfig:
    return NotificationConfig(
        app_id=required_env("FEISHU_APP_ID"),
        app_secret=required_env("FEISHU_APP_SECRET"),
        chat_id=required_env("FEISHU_CHAT_ID"),
        status=status,
        project=optional_env("CI_PROJECT_PATH"),
        ref=optional_env("CI_COMMIT_REF_NAME", optional_env("CI_COMMIT_BRANCH")),
        commit=optional_env("CI_COMMIT_SHA", optional_env("CI_COMMIT_SHORT_SHA")),
        pipeline_url=optional_env("CI_PIPELINE_URL"),
    )


def _post_json(url: str, payload: dict[str, Any], token: str | None = None) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
    except HTTPError as error:
        raise NotificationError(f"Feishu API returned HTTP {error.code}") from None
    except URLError:
        raise NotificationError("Feishu API request failed due to a network error") from None
    except TimeoutError:
        raise NotificationError("Feishu API request timed out") from None

    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise NotificationError("Feishu API returned invalid JSON") from None
    if not isinstance(decoded, dict):
        raise NotificationError("Feishu API returned an unexpected response")
    return decoded


def get_tenant_access_token(config: NotificationConfig) -> str:
    response = _post_json(
        TOKEN_ENDPOINT,
        {"app_id": config.app_id, "app_secret": config.app_secret},
    )
    if response.get("code") != 0:
        raise NotificationError("Feishu token API rejected the request")
    token = response.get("tenant_access_token")
    if not isinstance(token, str) or not token:
        raise NotificationError("Feishu token API returned no access token")
    return token


def build_card(config: NotificationConfig) -> dict[str, Any]:
    status_label = config.status.upper()
    succeeded = config.status == "success"
    title = f"scoringsys pipeline {config.status}"
    details = (
        f"**Status:** {status_label}\n"
        f"**Project:** {config.project}\n"
        f"**Ref:** {config.ref}\n"
        f"**Commit:** {config.commit}\n"
        f"**Pipeline:** {config.pipeline_url}\n"
        f"**Application:** {APPLICATION_URL}"
    )
    elements: list[dict[str, Any]] = [{"tag": "div", "text": {"tag": "lark_md", "content": details}}]
    if config.pipeline_url != "unknown":
        elements.append(
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "Open pipeline"},
                        "type": "primary" if succeeded else "danger",
                        "url": config.pipeline_url,
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "Open application"},
                        "type": "default",
                        "url": APPLICATION_URL,
                    },
                ],
            }
        )
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "green" if succeeded else "red",
            "title": {"tag": "plain_text", "content": title},
        },
        "elements": elements,
    }


def send_card(config: NotificationConfig, token: str) -> str:
    response = _post_json(
        f"{MESSAGE_ENDPOINT}?receive_id_type=chat_id",
        {
            "receive_id": config.chat_id,
            "msg_type": "interactive",
            "content": json.dumps(build_card(config), ensure_ascii=False, separators=(",", ":")),
        },
        token=token,
    )
    if response.get("code") != 0:
        raise NotificationError("Feishu message API rejected the request")
    data = response.get("data")
    message_id = data.get("message_id") if isinstance(data, dict) else None
    if not isinstance(message_id, str) or not message_id:
        raise NotificationError("Feishu message API returned no message id")
    return message_id


def sanitize_identifier(value: str) -> str:
    sanitized = SAFE_IDENTIFIER.sub("_", value)
    return sanitized[:128] or "unknown"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", choices=("success", "failure"), required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        config = make_config(args.status)
        token = get_tenant_access_token(config)
        message_id = send_card(config, token)
    except NotificationError as error:
        print(f"Feishu notification failed: {error}", file=sys.stderr)
        return 1

    print(f"Feishu notification sent: status={config.status} message_id={sanitize_identifier(message_id)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
