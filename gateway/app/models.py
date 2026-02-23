from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict


class MachineStatus(str, Enum):
    provisioning = "provisioning"
    running = "running"
    suspending = "suspending"
    suspended = "suspended"
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
    provisioning_step: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ProvisionRequest(BaseModel):
    user_id: str
    plan: str = "cmo"
    region: str = "iad"


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    stream: bool = True


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


class UsageEvent(BaseModel):
    user_id: str
    event_type: str  # 'llm_request', 'machine_minute', 'tool_execution'
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_cents: int | None = None
    duration_ms: int | None = None
    metadata: dict | None = None
