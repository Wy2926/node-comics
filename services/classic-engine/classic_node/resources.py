"""Startup CPU limits, without importing any model or rendering dependencies."""
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re

import psutil


def _read(path, problems, *, required=False):
    try:
        return path.read_text(encoding='utf-8').strip()
    except FileNotFoundError:
        if required:
            problems.append('missing')
    except (OSError, UnicodeError):
        problems.append('unreadable')
    return None


def _cpu_set(value):
    cpus = set()
    for item in value.split(','):
        ends = item.split('-')
        if len(ends) not in (1, 2) or any(not end.isdecimal() for end in ends):
            raise ValueError('Invalid CPU set')
        start, end = int(ends[0]), int(ends[-1])
        if start > end:
            raise ValueError('Invalid CPU range')
        cpus.update(range(start, end + 1))
    return cpus


def _unescape_mount(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)


def _quota(directory, unified, problems):
    raw = _read(directory / ('cpu.max' if unified else 'cpu.cfs_quota_us'), problems)
    if raw is None:
        return None
    try:
        if unified:
            limit, period = raw.split()
        else:
            limit, period = raw, _read(directory / 'cpu.cfs_period_us', problems, required=True)
        if period is None or int(period) <= 0:
            raise ValueError('Invalid CPU quota period')
        unlimited = limit == 'max' if unified else int(limit) < 0
        if not unlimited:
            if int(limit) <= 0:
                raise ValueError('Invalid CPU quota')
            return int(limit) / int(period)
    except (ValueError, OverflowError):
        problems.append('quota')
    return None


def _cpuset(directory, unified, problems):
    raw = _read(directory / ('cpuset.cpus.effective' if unified else 'cpuset.effective_cpus'), problems)
    if raw is None:
        raw = _read(directory / 'cpuset.cpus', problems)
    if raw:
        try:
            return _cpu_set(raw)
        except ValueError:
            problems.append('cpuset')
    return None


def _cgroup_limits(proc_root, problems):
    """Read the current cgroup and visible ancestors, never above a mount root."""
    membership = _read(proc_root / 'self/cgroup', problems, required=True)
    mountinfo = _read(proc_root / 'self/mountinfo', problems, required=True)
    if membership is None or mountinfo is None:
        return None, None
    groups = {}
    try:
        for line in membership.splitlines():
            _, controllers, name = line.split(':', 2)
            member = PurePosixPath(name)
            if not member.is_absolute() or '..' in member.parts:
                raise ValueError('Unresolved cgroup namespace')
            for controller in controllers.split(','):
                if controller in ('', 'cpu', 'cpuset'):
                    groups[controller] = member
    except ValueError:
        problems.append('membership')
        return None, None
    matched, quota, cpus = set(), None, None
    for line in mountinfo.splitlines():
        try:
            fields, filesystem = line.split(' - ', 1)
            fields, filesystem = fields.split(), filesystem.split()
            kind = filesystem[0]
            if kind not in ('cgroup', 'cgroup2'):
                continue
            controllers = {''} if kind == 'cgroup2' else set(filesystem[2].split(',')) & {'cpu', 'cpuset'}
            controllers &= groups.keys()
            if not controllers:
                continue
            root = PurePosixPath(_unescape_mount(fields[3]))
            mount = Path(_unescape_mount(fields[4]))
            if not root.is_absolute() or '..' in root.parts or not mount.is_absolute():
                raise ValueError('Unresolved cgroup mount')
            for controller in controllers:
                member = groups[controller]
                if not member.is_relative_to(root):
                    continue
                directory = mount.joinpath(*member.relative_to(root).parts)
                matched.add(controller)
                while True:
                    if not directory.is_dir():
                        problems.append('directory')
                    if controller in ('', 'cpu'):
                        current = _quota(directory, kind == 'cgroup2', problems)
                        if current is not None:
                            quota = current if quota is None else min(quota, current)
                    if controller in ('', 'cpuset'):
                        current = _cpuset(directory, kind == 'cgroup2', problems)
                        if current is not None:
                            cpus = current if cpus is None else cpus & current
                    if directory == mount:
                        break
                    directory = directory.parent
        except (IndexError, ValueError, OSError):
            problems.append('limits')
    if groups.keys() - matched:
        problems.append('unmounted')
    return quota, cpus


def _affinity():
    try:
        return set(os.sched_getaffinity(0)) or None
    except (AttributeError, OSError, NotImplementedError):
        try:
            return set(psutil.Process().cpu_affinity()) or None
        except (AttributeError, OSError, NotImplementedError, psutil.Error):
            return None


def detect_cpu_capacity(*, proc_root=Path('/proc')):
    """Return a conservative CPU budget, not a throughput-optimal worker count.

    Cgroup quotas are CPU-time limits and may be fractional. Namespace-hidden
    ancestors cannot be inspected; all readable ancestors within mounts are used.
    """
    try:
        logical = psutil.cpu_count(logical=True) or os.cpu_count()
    except (OSError, psutil.Error):
        logical = os.cpu_count()
    affinity = _affinity()
    warnings = []
    limits = [logical] if logical else []
    if affinity is None:
        limits.append(1)
        warnings.append('Process CPU affinity is unavailable; automatic CPU budget is capped at one')
    else:
        limits.append(len(affinity))
    quota, cpuset = None, None
    if platform.system() == 'Linux':
        problems = []
        quota, cpuset = _cgroup_limits(Path(proc_root), problems)
        if cpuset is not None:
            allowed = cpuset if affinity is None else cpuset & affinity
            if allowed:
                limits.append(len(allowed))
            else:
                problems.append('empty-cpuset')
        if quota is not None:
            limits.append(quota)
        if problems:
            limits.append(1)
            warnings.append('Cgroup CPU limits could not be fully read; automatic CPU budget is capped at one')
    effective = float(min(limits))
    return {'logical_cpus': logical, 'affinity_cpus': len(affinity) if affinity is not None else None,
            'cpuset_cpus': len(cpuset) if cpuset is not None else None, 'quota_cpus': quota,
            'effective_cpus': effective, 'budget_cpus': max(1, math.floor(effective)), 'warnings': warnings}


def resolve_cpu_resources(*, analysis_threads, render_workers, local_pages, max_leases):
    """Share a CPU budget across native analysis work and render processes.

    This is a startup allocation, not a claim that the chosen worker count is
    optimal. Explicit values remain unchanged even when they overcommit CPUs.
    """
    resources = detect_cpu_capacity()
    budget = resources['budget_cpus']
    if analysis_threads == 'auto':
        analysis_threads = max(1, budget // (local_pages + (1 if render_workers == 'auto' else render_workers)))
    remaining = max(1, budget - local_pages * analysis_threads)
    if render_workers == 'auto':
        render_workers = min(max_leases, remaining)
    # A single renderer stays in the model process and shares its native-library
    # thread settings. Only child processes have a separate native-thread budget.
    render_threads = analysis_threads if render_workers == 1 else max(1, remaining // render_workers)
    allocated = local_pages * analysis_threads + render_workers * render_threads
    mixed = local_pages * analysis_threads + max(render_workers * render_threads,
                                                (render_workers - 1) * render_threads + analysis_threads)
    warnings = list(resources['warnings'])
    oversubscribed = allocated > resources['effective_cpus']
    if oversubscribed:
        warnings.append(f'CPU stage budget {allocated} exceeds detected capacity {resources["effective_cpus"]:g}; '
                        'minimum stage concurrency and explicit settings are preserved')
    return {**resources, 'analysis_threads': analysis_threads, 'render_workers': render_workers,
            'render_threads': render_threads, 'allocated_cpu_slots': allocated,
            'mixed_render_cpu_slots': mixed,
            'oversubscribed': oversubscribed, 'warnings': warnings}
