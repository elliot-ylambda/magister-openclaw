from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict


class MachineStatus(str, Enum):
    provisioning = "provisioning"
    running = "running"
    suspending = "suspending"
    suspended = "suspended"
    stopping = "stopping"
    stopped = "stopped"
    failed = "failed"
    destroying = "destroying"
    destroyed = "destroyed"


class UserMachine(BaseModel):
    id: str
    user_id: str
    fly_app_name: str
    fly_machine_id: str | None = None
    fly_volume_id: str | None = None
    fly_region: str = "iad"
    status: MachineStatus = MachineStatus.provisioning
    last_activity: datetime | None = None
    plan: str = "cmo"
    max_agents: int = 1
    gateway_token: str | None = None
    gateway_token_hash: str | None = None
    pending_image: str | None = None
    current_image: str | None = None
    preferred_model: str = "anthropic/claude-opus-4-6"
    email_address: str | None = None
    provisioning_step: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SetModelRequest(BaseModel):
    model: str


class ProvisionRequest(BaseModel):
    user_id: str
    plan: str = "cmo"
    region: str = "iad"


class Attachment(BaseModel):
    name: str
    type: str  # MIME type
    data: str  # base64-encoded content


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    agent_id: str | None = None
    stream: bool = True
    attachments: list[Attachment] | None = None


class LLMCompletionRequest(BaseModel):
    """OpenAI-compatible chat completion request.

    Uses extra="allow" because the Gateway acts as a pass-through proxy.
    OpenClaw sends many OpenAI-compatible fields (top_p, tools, tool_choice,
    response_format, etc.) that litellm needs to receive.
    """

    model: str
    messages: list[dict]
    stream: bool = False
    temperature: float | None = None
    max_tokens: int | None = None

    model_config = ConfigDict(extra="allow")


class SlackConnection(BaseModel):
    id: str
    user_id: str
    team_id: str
    team_name: str = ""
    bot_user_id: str = ""
    app_id: str = ""
    bot_token: str = ""
    scope: str = ""
    status: str = "active"
    created_at: datetime | None = None
    updated_at: datetime | None = None


class UserApiKey(BaseModel):
    id: str
    user_id: str
    provider: str  # openrouter, anthropic, openai, gemini
    api_key: str
    key_suffix: str = ""
    status: str = "active"
    created_at: datetime | None = None
    updated_at: datetime | None = None


class FeedbackMessage(BaseModel):
    role: str
    content: str


class FeedbackRequest(BaseModel):
    session_id: str | None = None
    category: str  # bug, wrong_answer, slow, other, contact_support
    description: str = ""
    messages: list[FeedbackMessage] = []


class UsageEvent(BaseModel):
    user_id: str
    event_type: str  # 'llm_request', 'machine_minute', 'tool_execution'
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_cents: int | None = None
    duration_ms: int | None = None
    metadata: dict | None = None


class EmailDraftRequest(BaseModel):
    """Agent requests to send an email (requires user approval)."""
    to: str
    subject: str
    body_html: str
    body_text: str | None = None
    cc: list[str] | None = None
    bcc: list[str] | None = None
    reply_to: str | None = None
    in_reply_to: str | None = None
    attachments: list[dict] | None = None


class EmailApprovalRequest(BaseModel):
    """User approves, rejects, edits, or requests rewrite of a pending outbound email."""
    email_id: str
    action: Literal["approve", "reject", "rewrite", "edit"]
    rejection_reason: str | None = None
    rewrite_note: str | None = None
    edited_subject: str | None = None
    edited_body_html: str | None = None
    edited_body_text: str | None = None
