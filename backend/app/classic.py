"""Recoverable local stages and page-wide, atomic text-call budgeting."""
import base64
from io import BytesIO
import json
import time
from PIL import Image, ImageChops
import httpx
from sqlalchemy import func, select
from .adapters.images import TranslationOutput, read_bounded
from .adapters.text import TextError, call_text, groups, input_bound, parse_translations
from .assets import available, create_asset, inspect_image, object_path
from .config import settings
from .db import session_factory
from .errors import ProcessingError
from .models import Asset, Attempt, ClassicState, Job, Outbox, TextCall, now, uid


def current(db, job_id, attempt_id, phase=None):
    job = db.scalar(select(Job).where(Job.id == job_id).with_for_update().execution_options(populate_existing=True))
    if not job or job.status != 'running' or job.attempt_id != attempt_id:
        raise ProcessingError('CLASSIC_SUPERSEDED', '此工作进程已被新的恢复任务替代')
    if job.cancel_requested or job.discard_output or not available(db.get(Asset, job.input_asset_id)):
        raise ProcessingError('ASSET_EXPIRED', '原图已删除、过期或任务已取消')
    if phase:
        job.phase = phase
    return job


def engine_request(stage, data, config, **extra):
    cfg = settings()
    payload = {'image': base64.b64encode(data).decode(), 'config': config['engine'], **extra}
    try:
        with httpx.Client(timeout=config['provider']['timeout_seconds'], trust_env=False, follow_redirects=False) as client:
            with client.stream('POST', cfg.classic_engine_url.rstrip('/') + '/v1/' + stage, json=payload,
                               headers={'Authorization': 'Bearer ' + cfg.classic_engine_token}) as response:
                if response.status_code != 200:
                    raise ProcessingError('CLASSIC_' + stage.upper() + '_FAILED', '常规翻译图像阶段失败，请检查引擎状态')
                raw = read_bounded(response, 96 * 1024 * 1024)
        result = json.loads(raw)
        if result['version'] != config['engine']['version']:
            raise ProcessingError('CLASSIC_ENGINE_CHANGED', '引擎版本与任务快照不一致，请重新估算')
        return result
    except ProcessingError:
        raise
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise ProcessingError('CLASSIC_ENGINE_UNAVAILABLE', '常规翻译引擎不可用，将在本地恢复次数内重试') from None


def validate_analysis(result, width, height):
    try:
        segments = result['segments']
        if result['width'] != width or result['height'] != height or not isinstance(segments, list) or len(segments) > 200:
            raise ValueError()
        if len(result['regions']) != len(segments):
            raise ValueError()
        seen = set()
        for segment in segments:
            if set(segment) != {'id', 'source'} or not isinstance(segment['id'], str) or segment['id'] in seen:
                raise ValueError()
            if not isinstance(segment['source'], str) or not segment['source'].strip() or len(segment['source']) > 4000:
                raise ValueError()
            seen.add(segment['id'])
        if segments and not result['mask']:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise ProcessingError('CLASSIC_OCR_INVALID', 'OCR 区域或掩膜无效，未调用文本服务') from None


def reserve_call(job_id, attempt_id, group_index, segments, language):
    with session_factory()() as db:
        job = current(db, job_id, attempt_id, 'translating_text')
        state = db.get(ClassicState, job_id)
        profile = job.config['text']
        if (now() - state.started_at).total_seconds() >= job.config['provider']['timeout_seconds']:
            raise TextError('TEXT_DEADLINE_EXCEEDED', '此页已达到文本处理总时限')
        count = db.scalar(select(func.count()).select_from(TextCall).where(TextCall.job_id == job_id, TextCall.group_index == group_index))
        if count >= profile['max_attempts']:
            raise TextError('TEXT_RETRY_EXHAUSTED', '此文本组已达到自动调用次数上限')
        reserved = input_bound(segments, language) * profile['input_rate'] + profile['max_output_tokens'] * profile['output_rate']
        spent = db.scalar(select(func.coalesce(func.sum(TextCall.accounted_micros), 0)).where(TextCall.job_id == job_id))
        if spent + reserved > profile['page_budget_micros']:
            raise TextError('TEXT_BUDGET_EXCEEDED', '此页已达到文本成本预算，未知消耗仍保留预占')
        call = TextCall(id=uid(), job_id=job_id, attempt_id=attempt_id, group_index=group_index, sequence=count + 1,
                        provider_id=job.config['provider']['id'], model=profile['model'], reserved_micros=reserved, accounted_micros=reserved)
        db.add(call)
        db.commit()  # Intent and full unknown-cost reservation must exist before any request.
        return call.id, profile, count + 1


def complete_call(call_id, response=None, error=None, translations=None):
    with session_factory()() as db:
        call = db.scalar(select(TextCall).where(TextCall.id == call_id).with_for_update())
        if call.completed_at:
            return
        usage = response.usage if response else getattr(error, 'usage', None)
        call.request_id = response.request_id if response else getattr(error, 'request_id', None)
        call.error_code = getattr(error, 'code', None)
        call.completed_at = now()
        job = db.scalar(select(Job).where(Job.id == call.job_id).with_for_update())
        if usage is not None:
            call.usage, call.cost_state = usage, 'estimated'
            profile = job.config['text']
            call.accounted_micros = usage['input_tokens'] * profile['input_rate'] + usage['output_tokens'] * profile['output_rate']
        # A late result can update its own usage, never a newer attempt's translation checkpoint.
        if translations and job.attempt_id == call.attempt_id and job.status == 'running' and not job.cancel_requested and not job.discard_output and available(db.get(Asset, job.input_asset_id)):
            state = db.get(ClassicState, job.id)
            state.translations = {**state.translations, **translations}
        db.commit()


def translate_group(job_id, attempt_id, index, segments, language):
    while True:
        call_id, profile, sequence = reserve_call(job_id, attempt_id, index, segments, language)
        response = None
        try:
            response = call_text(segments, language, profile)
            translations = parse_translations(response.content, segments)
            complete_call(call_id, response=response, translations=translations)
            return
        except TextError as error:
            complete_call(call_id, response=response, error=error)
            if not error.retryable or sequence >= profile['max_attempts']:
                raise
            delay = max(error.retry_after, min(2 ** (sequence - 1), 8))
            with session_factory()() as db:
                job = current(db, job_id, attempt_id)
                state = db.get(ClassicState, job_id)
                remaining = job.config['provider']['timeout_seconds'] - (now() - state.started_at).total_seconds()
            if delay + profile['timeout_seconds'] > remaining:
                raise TextError('TEXT_DEADLINE_EXCEEDED', '供应商要求等待的时间超过此页剩余时限')
            # Check cancellation while honoring Retry-After; never shorten a server's delay.
            end = time.monotonic() + delay
            while time.monotonic() < end:
                time.sleep(min(1, end - time.monotonic()))
                with session_factory()() as db:
                    current(db, job_id, attempt_id)
        except Exception:
            complete_call(call_id, error=TextError('TEXT_CALL_INTERRUPTED', '文本调用中断，保守保留成本预占'))
            raise


def validate_render(data, result):
    try:
        output = base64.b64decode(result['image'], validate=True)
        inspect_image(output, output=True)
        with Image.open(BytesIO(data)) as source, Image.open(BytesIO(output)) as target:
            original, final = source.convert('RGB'), target.convert('RGB')
            if target.format != 'PNG' or original.size != final.size:
                raise ValueError()
            masks = []
            for field in ('mask', 'glyph_mask'):
                with Image.open(BytesIO(base64.b64decode(result[field], validate=True))) as mask:
                    if mask.size != original.size:
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
    except (ValueError, KeyError, TypeError, OSError):
        raise ProcessingError('CLASSIC_RENDER_INVALID', '译图尺寸、字形或掩膜外像素验证失败，未交付') from None


def run_classic(job_id, attempt_id, data, language, config):
    with session_factory()() as db:
        current(db, job_id, attempt_id, 'detecting_ocr')
        state = db.get(ClassicState, job_id)
        if not state:
            state = ClassicState(job_id=job_id)
            db.add(state)
            db.flush()
        if state.local_attempts >= config['local_attempts']:
            raise ProcessingError('CLASSIC_RECOVERY_EXHAUSTED', '此页已达到本地恢复次数上限')
        state.local_attempts += 1
        analysis, rendered = state.analysis, state.artifacts.get('rendered')
        db.commit()
        if rendered:
            asset = db.get(Asset, rendered)
            if available(asset):
                return TranslationOutput(object_path(asset.storage_key).read_bytes(), quality_flags=(analysis or {}).get('quality_flags', []))
    if analysis is None:
        analysis = engine_request('analyze', data, config)
        info = inspect_image(data, output=True)
        validate_analysis(analysis, info['width'], info['height'])
        with session_factory()() as db:
            current(db, job_id, attempt_id)
            state = db.get(ClassicState, job_id)
            state.analysis, state.timings = analysis, analysis.get('timings', {})
            db.commit()
    if not analysis['segments']:
        return TranslationOutput(None, no_text=True)
    for index, group in enumerate(groups(analysis['segments'], config['text']['group_bytes'])):
        with session_factory()() as db:
            current(db, job_id, attempt_id)
            saved = db.get(ClassicState, job_id).translations
        if all(segment['id'] in saved for segment in group):
            continue
        translate_group(job_id, attempt_id, index, group, language)
    with session_factory()() as db:
        current(db, job_id, attempt_id, 'inpainting_rendering')
        translations = db.get(ClassicState, job_id).translations
        db.commit()
    rendered = engine_request('render', data, config, analysis=analysis, translations=translations, language=language)
    output = validate_render(data, rendered)
    with session_factory()() as db:
        job = current(db, job_id, attempt_id, 'validating')
        state = db.get(ClassicState, job_id)
        artifacts = dict(state.artifacts)
        for name in ('cleaned', 'mask', 'glyph_mask'):
            raw = base64.b64decode(rendered[name], validate=True)
            asset = create_asset(db, job.owner_id, raw, kind='classic_stage', parent_id=job.input_asset_id)
            artifacts[name] = asset.id
        asset = create_asset(db, job.owner_id, output, kind='classic_stage', parent_id=job.input_asset_id)
        artifacts['rendered'] = asset.id
        state.artifacts, state.timings = artifacts, {**state.timings, **rendered.get('timings', {})}
        db.commit()
    return TranslationOutput(output, quality_flags=analysis.get('quality_flags', []))


def requeue_local(job_id, attempt_id, error):
    # Text failures finish normally; only local work is automatically replayed here.
    retryable = error.code in {'CLASSIC_ENGINE_UNAVAILABLE', 'CLASSIC_ANALYZE_FAILED', 'CLASSIC_RENDER_FAILED', 'CLASSIC_LOCAL_INTERRUPTED'}
    if not retryable:
        return False
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        state = db.get(ClassicState, job_id)
        if not job or job.attempt_id != attempt_id or job.status != 'running' or job.cancel_requested or job.discard_output:
            return False
        if state and state.local_attempts >= job.config['local_attempts']:
            return False
        attempt = db.get(Attempt, attempt_id)
        attempt.completed_at, attempt.error_code = now(), error.code
        job.status, job.phase, job.attempt_id = 'queued', 'recovering_local', None
        event = db.scalar(select(Outbox).where(Outbox.job_id == job_id))
        event.published_at = None
        db.commit()
        return True
