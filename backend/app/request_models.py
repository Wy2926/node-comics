"""Shared validation policy for JSON request bodies; response models stay independent."""
from pydantic import BaseModel, ConfigDict


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
