"""Control-plane text stages, fenced checkpoints and strict image validation."""
import base64
from io import BytesIO
import json
import math
import time
from PIL import Image, ImageChops
from sqlalchemy import func, or_, select
from .adapters.text import TextError, call_text, groups, input_bound, parse_translations
from .assets import available, inspect_image
from .db import session_factory
from .errors import ProcessingError
from .models import Asset, ClassicState, Job, TextCall, now, uid

MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 24 * 1024 * 1024


def decode_bounded(value, limit=MAX_IMAGE_BYTES):
    if not isinstance(value, str) or len(value) > ((limit + 2) // 3) * 4:
        raise ValueError('Invalid encoded image size')
    raw = base64.b64decode(value, validate=True)
    if len(raw) > limit:
        raise ValueError('Invalid image size')
    return raw


def current(db, job_id, lease_id):
    from .scheduler import current_lease, lock_scheduler
    lock_scheduler(db)
    lease, stage, job = current_lease(db, lease_id)
    if job.id != job_id or stage.name != 'text':
        raise ProcessingError('LEASE_EXPIRED', '文本执行租约已失效')
    if job.cancel_requested or job.discard_output or not available(db.get(Asset, job.input_asset_id)):
        raise ProcessingError('ASSET_EXPIRED', '原图已删除、过期或任务已取消')
    return job


def text_remaining(db, job):
    started = db.scalar(select(func.min(TextCall.started_at)).where(TextCall.job_id == job.id,
        or_(TextCall.error_code.is_(None), TextCall.error_code != 'TEXT_PROVIDER_DISABLED')))
    elapsed = (now() - started).total_seconds() if started else 0
    return job.config['provider']['timeout_seconds'] - elapsed


def validate_analysis(result, width, height):
    try:
        if len(json.dumps(result, allow_nan=False).encode()) > MAX_CHECKPOINT_BYTES:
            raise ValueError()
        segments = result['segments']
        if result['width'] != width or result['height'] != height or not isinstance(segments, list) or len(segments) > 200:
            raise ValueError()
        if len(result['regions']) != len(segments):
            raise ValueError()
        seen = set()
        for segment in segments:
            if set(segment) != {'id', 'source'} or not isinstance(segment['id'], str) or not 1 <= len(segment['id']) <= 80 or segment['id'] in seen:
                raise ValueError()
            if not isinstance(segment['source'], str) or not segment['source'].strip() or len(segment['source']) > 4000:
                raise ValueError()
            seen.add(segment['id'])
        if segments:
            mask_bytes = decode_bounded(result['mask'], MAX_CHECKPOINT_BYTES)
            with Image.open(BytesIO(mask_bytes)) as mask:
                if mask.format != 'PNG' or mask.size != (width, height) or not mask.convert('L').getbbox():
                    raise ValueError()
            for region in result['regions']:
                lines = region['lines']
                if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
                    raise ValueError()
                for polygon in lines:
                    if not isinstance(polygon, list) or len(polygon) != 4:
                        raise ValueError()
                    for point in polygon:
                        if len(point) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point):
                            raise ValueError()
                        if not (-width <= point[0] <= 2 * width and -height <= point[1] <= 2 * height):
                            raise ValueError()
        elif result.get('mask') is not None:
            raise ValueError()
    except (KeyError, ValueError, TypeError, OSError, Image.DecompressionBombError):
        raise ProcessingError('CLASSIC_OCR_INVALID', 'OCR 区域或掩膜无效，未调用文本服务') from None


def reserve_call(job_id, lease_id, group_index, segments, language):
    with session_factory()() as db:
        job = current(db, job_id, lease_id)
        profile = job.config['text']
        from .translation_providers import require_enabled
        provider = require_enabled(db, profile)
        if text_remaining(db, job) < profile['timeout_seconds']:
            raise TextError('TEXT_DEADLINE_EXCEEDED', '此页已达到文本处理总时限')
        pending = db.scalar(select(TextCall.id).where(TextCall.job_id == job_id, TextCall.group_index == group_index,
                                                      TextCall.execution_lease_id == lease_id, TextCall.completed_at.is_(None)))
        if pending:
            raise TextError('TEXT_CALL_IN_FLIGHT', '当前文本组已经在执行')
        from datetime import timedelta
        cutoff = now() - timedelta(seconds=60)
        recent = db.scalars(select(TextCall.started_at).where(TextCall.provider_id == provider.id,
                                                              or_(TextCall.error_code.is_(None), TextCall.error_code != 'TEXT_PROVIDER_DISABLED'),
                                                              TextCall.started_at > cutoff).order_by(TextCall.started_at)).all()
        if len(recent) >= provider.requests_per_minute:
            delay = max(0.1, 60 - (now() - recent[0]).total_seconds())
            raise TextError('TEXT_RATE_LIMITED', '文本服务已达到本分钟调用上限', retryable=True, retry_after=delay)
        count, sequence = db.execute(select(
            func.count().filter(or_(TextCall.error_code.is_(None), TextCall.error_code != 'TEXT_PROVIDER_DISABLED')),
            func.coalesce(func.max(TextCall.sequence), 0)).where(TextCall.job_id == job_id, TextCall.group_index == group_index)).one()
        if count >= profile['max_attempts']:
            raise TextError('TEXT_RETRY_EXHAUSTED', '此文本组已达到自动调用次数上限')
        reserved = input_bound(segments, language) * profile['input_rate'] + profile['max_output_tokens'] * profile['output_rate']
        call = TextCall(id=uid(), job_id=job_id, attempt_id=job.attempt_id, execution_lease_id=lease_id,
                        group_index=group_index, sequence=sequence + 1,
                        provider_id=profile['provider_id'], model=profile['model'], reserved_micros=reserved, accounted_micros=reserved)
        db.add(call)
        db.commit()  # Intent and full unknown-cost reservation must exist before any request.
        return call.id, profile, count + 1


def complete_call(call_id, lease_id, response=None, error=None, translations=None):
    with session_factory()() as db:
        from .scheduler import lock_scheduler
        lock_scheduler(db)
        call = db.scalar(select(TextCall).where(TextCall.id == call_id).with_for_update())
        if call.completed_at:
            return
        usage = response.usage if response else getattr(error, 'usage', None)
        call.request_id = response.request_id if response else getattr(error, 'request_id', None)
        call.error_code = getattr(error, 'code', None)
        call.completed_at = now()
        job = db.scalar(select(Job).where(Job.id == call.job_id).with_for_update(key_share=True))
        if usage is not None:
            call.usage, call.cost_state = usage, 'estimated'
            profile = job.config['text']
            call.accounted_micros = usage['input_tokens'] * profile['input_rate'] + usage['output_tokens'] * profile['output_rate']
        # Cost belongs to the original call even after cancellation or lease loss.
        # Translation checkpoints belong only to the current execution generation.
        if translations:
            try:
                current(db, job.id, lease_id)
            except ProcessingError:
                pass
            else:
                state = db.get(ClassicState, job.id)
                if state is not None:
                    state.translations = {**state.translations, **translations}
        db.commit()


def translate_group(job_id, lease_id, index, segments, language, before_call=None):
    while True:
        if before_call:
            before_call()
        try:
            call_id, profile, sequence = reserve_call(job_id, lease_id, index, segments, language)
        except TextError as error:
            if error.code != 'TEXT_RATE_LIMITED':
                raise
            with session_factory()() as db:
                job = current(db, job_id, lease_id)
                if error.retry_after + job.config['text']['timeout_seconds'] > text_remaining(db, job):
                    raise TextError('TEXT_DEADLINE_EXCEEDED', '供应商限流等待超过此页剩余时限') from None
            # Let the durable scheduler wait; holding this lease could prevent a
            # completely different supplier from using the shared text pool.
            raise
        response = None
        try:
            response = call_text(segments, language, profile)
            translations = parse_translations(response.content, segments)
            complete_call(call_id, lease_id, response=response, translations=translations)
            return
        except TextError as error:
            complete_call(call_id, lease_id, response=response, error=error)
            if error.code == 'TEXT_RATE_LIMITED' and sequence >= profile['max_attempts']:
                raise TextError('TEXT_RETRY_EXHAUSTED', '此文本组已达到自动调用次数上限') from None
            if not error.retryable or sequence >= profile['max_attempts']:
                raise
            delay = max(error.retry_after, min(2 ** (sequence - 1), 8))
            with session_factory()() as db:
                job = current(db, job_id, lease_id)
                remaining = text_remaining(db, job)
            if delay + profile['timeout_seconds'] > remaining:
                raise TextError('TEXT_DEADLINE_EXCEEDED', '供应商要求等待的时间超过此页剩余时限')
            if error.code == 'TEXT_RATE_LIMITED':
                error.retry_after = delay
                raise
            # Check cancellation while honoring Retry-After; never shorten a server's delay.
            wait_for_retry(job_id, lease_id, delay, before_call)
        except Exception:
            complete_call(call_id, lease_id, error=TextError('TEXT_CALL_INTERRUPTED', '文本调用中断，保守保留成本预占'))
            raise


def wait_for_retry(job_id, lease_id, delay, before_call=None):
    end = time.monotonic() + delay
    while time.monotonic() < end:
        if before_call:
            before_call()
        time.sleep(max(0, min(1, end - time.monotonic())))
        with session_factory()() as db:
            current(db, job_id, lease_id)


def validate_render(data, result):
    try:
        output = decode_bounded(result['image'])
        inspect_image(output, output=True)
        with Image.open(BytesIO(data)) as source, Image.open(BytesIO(output)) as target:
            original, final = source.convert('RGB'), target.convert('RGB')
            if target.format != 'PNG' or original.size != final.size:
                raise ValueError()
            masks = []
            for field in ('mask', 'glyph_mask'):
                with Image.open(BytesIO(decode_bounded(result[field], MAX_CHECKPOINT_BYTES))) as mask:
                    if mask.format != 'PNG' or mask.size != original.size:
                        raise ValueError()
                    masks.append(mask.convert('L').point(lambda p: 255 if p else 0))
            permitted = ImageChops.lighter(*masks)
            if not masks[1].getbbox():
                raise ValueError()
            difference = ImageChops.difference(original, final)
            if ImageChops.multiply(difference, ImageChops.invert(permitted).convert('RGB')).getbbox():
                raise ValueError()
            # Preserve the source alpha channel as well as RGB pixels outside the masks.
            if 'A' in source.getbands() or 'transparency' in source.info:
                final.putalpha(source.convert('RGBA').getchannel('A'))
                buffer = BytesIO()
                final.save(buffer, 'PNG')
                output = buffer.getvalue()
        return output
    except (ValueError, KeyError, TypeError, OSError, Image.DecompressionBombError):
        raise ProcessingError('CLASSIC_RENDER_INVALID', '译图尺寸、字形或掩膜外像素验证失败，未交付') from None


def run_text_stage(job_id, lease_id):
    """Run only LLM work. Image stages run on independently leased devices."""
    with session_factory()() as db:
        job = current(db, job_id, lease_id)
        state = db.get(ClassicState, job_id)
        if not state or not state.analysis:
            raise ProcessingError('CLASSIC_OCR_MISSING', '缺少已验证 OCR 检查点')
        analysis, language, config = state.analysis, job.target_language, job.config
    for index, group in enumerate(groups(analysis['segments'], config['text']['group_bytes'])):
        with session_factory()() as db:
            current(db, job_id, lease_id)
            saved = db.get(ClassicState, job_id).translations
        if not all(segment['id'] in saved for segment in group):
            translate_group(job_id, lease_id, index, group, language)
    with session_factory()() as db:
        current(db, job_id, lease_id)
        return {'translations': db.get(ClassicState, job_id).translations}
