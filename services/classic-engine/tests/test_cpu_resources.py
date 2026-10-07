from pathlib import Path
from types import SimpleNamespace

import pytest

from classic_node import resources


@pytest.fixture
def cpu_host(monkeypatch):
    monkeypatch.setattr(resources.psutil, 'cpu_count', lambda **kwargs: 32)
    monkeypatch.setattr(resources.os, 'sched_getaffinity', lambda _: set(range(16)), raising=False)
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Linux')


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def mount_line(path, *, root='/', kind='cgroup2', controllers='rw'):
    mount = path.as_posix().replace('\\', r'\134').replace(' ', r'\040')
    return f'30 20 0:30 {root} {mount} rw - {kind} cgroup {controllers}\n'


def linux_process(tmp_path, membership, mounts):
    proc = tmp_path / 'proc'
    write(proc / 'self/cgroup', membership)
    write(proc / 'self/mountinfo', ''.join(mounts))
    return proc


@pytest.mark.parametrize('limit,expected,budget', [('max', 6, 6), ('250000', 2.5, 2), ('50000', .5, 1)])
def test_v2_effective_cpu_intersects_affinity_cpuset_and_fractional_quota(cpu_host, tmp_path, limit, expected, budget):
    mount = tmp_path / 'cgroup'
    write(mount / 'worker/cpu.max', f'{limit} 100000')
    write(mount / 'worker/cpuset.cpus.effective', '10-19')
    proc = linux_process(tmp_path, '0::/worker\n', [mount_line(mount)])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['logical_cpus'] == 32 and result['affinity_cpus'] == 16
    assert result['cpuset_cpus'] == 10
    assert result['effective_cpus'] == expected and result['budget_cpus'] == budget
    assert result['warnings'] == []


def test_v2_reads_every_visible_ancestor_quota_and_inherited_cpuset(cpu_host, tmp_path):
    mount = tmp_path / 'cgroup'
    write(mount / 'group/leaf/cpu.max', 'max 100000')
    write(mount / 'group/cpu.max', '175000 100000')
    write(mount / 'cpu.max', '300000 100000')
    write(mount / 'group/leaf/cpuset.cpus', '')
    write(mount / 'group/cpuset.cpus', '0-3')
    proc = linux_process(tmp_path, '0::/group/leaf\n', [mount_line(mount)])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['quota_cpus'] == result['effective_cpus'] == 1.75
    assert result['cpuset_cpus'] == 4 and result['budget_cpus'] == 1
    assert result['warnings'] == []


def test_v1_cpu_and_cpuset_mounts_use_ancestor_limits(cpu_host, tmp_path):
    cpu, cpuset = tmp_path / 'cpu', tmp_path / 'cpuset'
    write(cpu / 'group/leaf/cpu.cfs_quota_us', '-1')
    write(cpu / 'group/leaf/cpu.cfs_period_us', '100000')
    write(cpu / 'group/cpu.cfs_quota_us', '700000')
    write(cpu / 'group/cpu.cfs_period_us', '200000')
    write(cpuset / 'group/leaf/cpuset.cpus', '')
    write(cpuset / 'group/cpuset.effective_cpus', '4-8,10,12-13')
    proc = linux_process(tmp_path, '3:cpu,cpuacct:/group/leaf\n4:cpuset:/group/leaf\n', [
        mount_line(cpu, kind='cgroup', controllers='rw,cpu,cpuacct'),
        mount_line(cpuset, kind='cgroup', controllers='rw,cpuset')])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['quota_cpus'] == result['effective_cpus'] == 3.5
    assert result['cpuset_cpus'] == 8 and result['budget_cpus'] == 3
    assert result['warnings'] == []


def test_mounted_subtree_stops_at_mount_root_and_decodes_spaces(cpu_host, tmp_path):
    mount = tmp_path / 'mounted cgroup'
    write(mount / 'worker/cpu.max', 'max 100000')
    write(mount / 'cpu.max', '350000 100000')
    write(tmp_path / 'cpu.max', '10000 100000')  # Not part of this cgroup mount.
    proc = linux_process(tmp_path, '0::/host/subtree/worker\n', [mount_line(mount, root='/host/subtree')])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['effective_cpus'] == 3.5 and result['warnings'] == []


def test_namespaced_root_and_unrelated_bind_mount_are_not_confused(cpu_host, tmp_path):
    current, unrelated = tmp_path / 'current', tmp_path / 'unrelated'
    write(current / 'cpu.max', '400000 100000')
    write(unrelated / 'cpu.max', '10000 100000')
    proc = linux_process(tmp_path, '0::/\n', [mount_line(current), mount_line(unrelated, root='/other')])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['effective_cpus'] == 4 and result['warnings'] == []


def test_unrelated_v1_controller_mount_does_not_change_cpu_detection(cpu_host, tmp_path):
    cpu, freezer = tmp_path / 'cpu', tmp_path / 'freezer'
    write(cpu / 'cpu.cfs_quota_us', '250000')
    write(cpu / 'cpu.cfs_period_us', '100000')
    proc = linux_process(tmp_path, '3:cpu:/\n4:freezer:/\n', [
        mount_line(cpu, kind='cgroup', controllers='rw,cpu'),
        mount_line(freezer, root='/..', kind='cgroup', controllers='rw,freezer')])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['effective_cpus'] == 2.5 and result['warnings'] == []


@pytest.mark.parametrize('value', ['bad', '250000 0', '0 100000', '-1 100000', 'max -1'])
def test_invalid_v2_quota_uses_safe_fallback(cpu_host, tmp_path, value):
    mount = tmp_path / 'cgroup'
    write(mount / 'cpu.max', value)
    proc = linux_process(tmp_path, '0::/\n', [mount_line(mount)])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['effective_cpus'] == result['budget_cpus'] == 1
    assert result['warnings']


@pytest.mark.parametrize('value', ['3-1', '0,1,,2', '-2', '1-two'])
def test_invalid_cpuset_uses_safe_fallback(cpu_host, tmp_path, value):
    mount = tmp_path / 'cgroup'
    write(mount / 'cpuset.cpus.effective', value)
    proc = linux_process(tmp_path, '0::/\n', [mount_line(mount)])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['budget_cpus'] == 1 and result['warnings']


def test_unreadable_ancestor_cannot_silently_remove_limit(cpu_host, monkeypatch, tmp_path):
    mount = tmp_path / 'cgroup'
    write(mount / 'leaf/cpu.max', '50000 100000')
    write(mount / 'cpu.max', '20000 100000')
    proc = linux_process(tmp_path, '0::/leaf\n', [mount_line(mount)])
    real_read = Path.read_text
    def restricted(path, *args, **kwargs):
        if path == mount / 'cpu.max':
            raise PermissionError('fixture')
        return real_read(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', restricted)
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['effective_cpus'] == .5 and result['budget_cpus'] == 1
    assert result['warnings']


@pytest.mark.parametrize('bad_file', ['cpu.max', 'cpuset.cpus.effective'])
def test_bad_child_limit_does_not_hide_a_stricter_readable_ancestor(cpu_host, tmp_path, bad_file):
    mount = tmp_path / 'cgroup'
    write(mount / 'leaf' / bad_file, 'bad')
    write(mount / 'cpu.max', '50000 100000')
    proc = linux_process(tmp_path, '0::/leaf\n', [mount_line(mount)])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['quota_cpus'] == result['effective_cpus'] == .5
    assert result['budget_cpus'] == 1 and result['warnings']


@pytest.mark.parametrize('membership,mount_root', [('0::/../outside\n', '/'), ('0::/\n', '/..'), ('0::/worker\n', '/other')])
def test_unresolved_cgroup_mapping_is_conservative(cpu_host, tmp_path, membership, mount_root):
    mount = tmp_path / 'cgroup'
    write(mount / 'cpu.max', 'max 100000')
    proc = linux_process(tmp_path, membership, [mount_line(mount, root=mount_root)])
    result = resources.detect_cpu_capacity(proc_root=proc)
    assert result['budget_cpus'] == 1 and result['warnings']


def test_missing_proc_files_do_not_use_unrestricted_host_cpu_count(cpu_host, tmp_path):
    result = resources.detect_cpu_capacity(proc_root=tmp_path)
    assert result['logical_cpus'] == 32 and result['budget_cpus'] == 1
    assert result['warnings']


def test_windows_uses_process_affinity_without_linux_proc(cpu_host, monkeypatch, tmp_path):
    monkeypatch.delattr(resources.os, 'sched_getaffinity')
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(resources.psutil, 'Process', lambda: SimpleNamespace(cpu_affinity=lambda: [3, 4, 6]))
    result = resources.detect_cpu_capacity(proc_root=tmp_path)
    assert result['effective_cpus'] == result['budget_cpus'] == 3
    assert result['quota_cpus'] is None and result['warnings'] == []


@pytest.mark.parametrize('logical', [None, 32])
def test_unavailable_affinity_and_cpu_count_have_bounded_fallback(cpu_host, monkeypatch, tmp_path, logical):
    monkeypatch.delattr(resources.os, 'sched_getaffinity')
    monkeypatch.setattr(resources.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(resources.psutil, 'cpu_count', lambda **kwargs: logical)
    monkeypatch.setattr(resources.os, 'cpu_count', lambda: logical)
    def restricted():
        raise resources.psutil.AccessDenied()
    monkeypatch.setattr(resources.psutil, 'Process', restricted)
    result = resources.detect_cpu_capacity(proc_root=tmp_path)
    assert result['affinity_cpus'] is None and result['effective_cpus'] == result['budget_cpus'] == 1
    assert result['warnings']
