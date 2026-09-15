from fastapi import HTTPException


def problem(code: str, message: str, status: int = 400, **details):
    raise HTTPException(status_code=status, detail={"code": code, "message": message, **details})


class ProcessingError(Exception):
    def __init__(self, code: str, message: str, *, unknown=False, request_id=None, usage=None):
        self.code = code
        self.message = message
        self.unknown = unknown
        self.request_id = request_id
        self.usage = usage
        super().__init__(code)
