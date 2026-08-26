#!/usr/bin/env python3
"""Send a CI status card to a Feishu chat through the App API."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
TOKEN_ENDPOINT = f"{FEISHU_API_BASE}/auth/v3/tenant_access_token/internal"
MESSAGE_ENDPOINT = f"{FEISHU_API_BASE}/im/v1/messages"
APPLICATION_URL = "https://nexus.youdoogo.com/scoringsys"
REQUEST_TIMEOUT_SECONDS = 15
SAFE_IDENTIFIER = re.compile(r"[^A-Za-z0-9_.:-]")
UTC_PLUS_8 = timezone(timedelta(hours=8))
FAILURE_EXPLANATION = "verify / build / deploy 任一阶段失败都会触发此红卡，请点流水线查看失败任务。"


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
    pipeline_id: str
    pipeline_url: str
    ref: str
    commit: str
    commit_title: str
    triggered_by: str
    commit_timestamp: str
    job_started_at: str
    pipeline_created_at: str
    job_name: str


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


def optional_env(name: str, fallback: str = "unknown") -> str:
    return os.environ.get(name, "").strip() or fallback


def make_config(status: str) -> NotificationConfig:
    full_commit = optional_env("CI_COMMIT_SHA")
    short_commit = optional_env("CI_COMMIT_SHORT_SHA", full_commit[:8])
    return NotificationConfig(
        app_id=required_env("FEISHU_APP_ID"),
        app_secret=required_env("FEISHU_APP_SECRET"),
        chat_id=required_env("FEISHU_CHAT_ID"),
        status=status,
        pipeline_id=optional_env("CI_PIPELINE_ID"),
        pipeline_url=optional_env("CI_PIPELINE_URL"),
        ref=optional_env("CI_COMMIT_BRANCH", optional_env("CI_COMMIT_REF_NAME")),
        commit=short_commit,
        commit_title=optional_env("CI_COMMIT_TITLE"),
        triggered_by=optional_env("GITLAB_USER_NAME"),
        commit_timestamp=optional_env("CI_COMMIT_TIMESTAMP"),
        job_started_at=optional_env("CI_JOB_STARTED_AT"),
        pipeline_created_at=optional_env("CI_PIPELINE_CREATED_AT"),
        job_name=optional_env("CI_JOB_NAME"),
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


def parse_time(value: str) -> datetime | None:
    value = value.strip()
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value).astimezone(UTC_PLUS_8)
    except ValueError:
        return None


def format_time(value: str) -> str:
    parsed = parse_time(value)
    if parsed is None:
        return "-"
    return parsed.strftime("%Y-%m-%d %H:%M:%S")


def format_duration(seconds: float) -> str:
    if seconds < 0:
        return "-"
    rounded_seconds = int(round(seconds))
    minutes, seconds = divmod(rounded_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}小时{minutes}分{seconds}秒"
    if minutes:
        return f"{minutes}分{seconds}秒"
    return f"{seconds}秒"


def elapsed_since(value: str, completed_at: datetime) -> str:
    started_at = parse_time(value)
    if started_at is None:
        return "-"
    return format_duration((completed_at - started_at).total_seconds())


def build_card(config: NotificationConfig, *, now: datetime | None = None) -> dict[str, Any]:
    succeeded = config.status == "success"
    completed_at = (now or datetime.now(UTC_PLUS_8)).astimezone(UTC_PLUS_8)
    completed_at_text = completed_at.strftime("%Y-%m-%d %H:%M:%S")
    commit = f"{config.commit} {config.commit_title}"
    if succeeded:
        title = f"✅ 立项评审在线打分系统部署成功 #{config.pipeline_id}"
        fields = [
            ("流水线", config.pipeline_url),
            ("分支", config.ref),
            ("提交", commit),
            ("触发者", config.triggered_by),
            ("提交时间", format_time(config.commit_timestamp)),
            ("部署完成", completed_at_text),
            ("耗时", elapsed_since(config.job_started_at, completed_at)),
            ("访问地址", APPLICATION_URL),
        ]
    else:
        title = f"❌ 立项评审在线打分系统流水线失败 #{config.pipeline_id}"
        fields = [
            ("通知任务", config.job_name),
            ("流水线", config.pipeline_url),
            ("分支", config.ref),
            ("提交", commit),
            ("触发者", config.triggered_by),
            ("提交时间", format_time(config.commit_timestamp)),
            ("通知时间", completed_at_text),
            ("耗时", elapsed_since(config.pipeline_created_at, completed_at)),
            ("说明", FAILURE_EXPLANATION),
            ("访问地址", APPLICATION_URL),
        ]
    details = "\n".join(f"**{label}**：{value}" for label, value in fields)
    elements: list[dict[str, Any]] = [{"tag": "div", "text": {"tag": "lark_md", "content": details}}]
    if config.pipeline_url != "unknown":
        elements.append(
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "查看流水线"},
                        "type": "primary" if succeeded else "danger",
                        "url": config.pipeline_url,
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "访问系统"},
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
