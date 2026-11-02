from fastapi import HTTPException


ANALYSIS_LIMIT_MESSAGES = {
    'CLASSIC_ANALYSIS_TOO_LARGE': '该图的分析数据超过 5 MiB 上限（不是原图文件大小），已停止处理，不会自动重试。请缩小图片或分段后重新提交。',
    'CLASSIC_REGION_LIMIT_EXCEEDED': '该图识别出的文字区域超过 200 个，已停止处理，不会自动重试。请缩小图片范围后重新提交。',
    'CLASSIC_TEXT_LIMIT_EXCEEDED': '该图某段识别文字超过 4000 字符，已停止处理，不会自动重试。请缩小图片范围后重新提交。',
}


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


def node_error(code: str):
    return ProcessingError(code, ANALYSIS_LIMIT_MESSAGES.get(code, f'计算节点未能完成此页（{code}）'))
