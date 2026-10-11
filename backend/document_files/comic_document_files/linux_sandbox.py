"""Fail-closed parser sandbox for ordinary unprivileged Linux containers.

Landlock ABI >= 3 confines file reads/writes; libseccomp's default-deny policy
disallows network, execution, process creation/signalling, ptrace and namespace
operations. No capabilities, user namespaces or privileged helper are required.
This launcher runs before importing any native decoder, in a fresh interpreter.
"""
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import sys


READ_FILE, READ_DIR = 1 << 2, 1 << 3
WRITE = (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 14)


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


class Argument(ctypes.Structure):
    _fields_ = [('index', ctypes.c_uint), ('operation', ctypes.c_uint),
               ('a', ctypes.c_uint64), ('b', ctypes.c_uint64)]


def runtime_paths():
    """Only immutable Python/parser libraries, never the engine or state tree."""
    paths = [Path('/usr/lib'), Path('/lib'), Path('/lib64'),
             Path(sys.base_prefix) / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}',
             Path(sys.prefix) / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}',
             Path(__file__).resolve().parent, Path('/etc/ld.so.cache'), Path('/etc/fonts'),
             Path('/usr/share/fonts'), Path('/dev/null'), Path('/dev/urandom')]
    return sorted({p.resolve() for p in paths if p.exists()})


def restrict(source, output, expected_parent=None):
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        raise RuntimeError('DOCUMENT_SANDBOX_PLATFORM')
    libc = ctypes.CDLL(None, use_errno=True)
    # Numbers from the Linux x86_64 syscall ABI. Do not reuse on another arch.
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 3:
        raise RuntimeError('DOCUMENT_SANDBOX_LANDLOCK_ABI')
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                             ctypes.c_uint, ctypes.POINTER(Argument)]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    # Landlock cannot mediate metadata operations on old ABIs. The syscall
    # allowlist therefore omits chmod/chown/link/symlink as well as all IPC.
    permitted = '''read write readv writev pread64 pwrite64 close close_range
        fstat newfstatat stat lstat statx lseek open openat access faccessat
        faccessat2 readlink readlinkat getdents64 fcntl dup dup2 dup3
        mmap mprotect munmap mremap brk madvise
        rt_sigaction rt_sigprocmask rt_sigreturn sigaltstack
        futex set_tid_address set_robust_list rseq arch_prctl
        clock_gettime clock_nanosleep nanosleep gettimeofday time
        getpid getppid gettid getuid geteuid getgid getegid getrandom
        uname sysinfo getrusage times sched_getaffinity sched_yield
        mkdir mkdirat unlink unlinkat rename renameat renameat2
        ftruncate truncate fsync fdatasync umask chdir getcwd
        poll ppoll select pselect6 restart_syscall exit exit_group'''.split()
    context = seccomp.seccomp_init(0x00050000 | errno.EPERM)
    if not context:
        raise RuntimeError('DOCUMENT_SANDBOX_SECCOMP')
    try:
        for name in permitted:
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number < 0 or seccomp.seccomp_rule_add(context, 0x7fff0000, number, 0):
                raise RuntimeError('DOCUMENT_SANDBOX_SECCOMP_RULE')
        # CPython FileIO sets CLOEXEC via ioctl(FIOCLEX) on opener-returned fds.
        # No device-control ioctl is exposed (including GPU, tty and filesystem).
        condition = Argument(1, 4, 0x5451, 0)  # SCMP_CMP_EQ on request
        if seccomp.seccomp_rule_add_array(context, 0x7fff0000,
                seccomp.seccomp_syscall_resolve_name(b'ioctl'), 1, ctypes.byref(condition)):
            raise RuntimeError('DOCUMENT_SANDBOX_SECCOMP_RULE')
        parent = os.getppid()
        if (libc.prctl(1, 9, 0, 0, 0) or os.getppid() != parent
                or expected_parent is not None and parent != expected_parent
                or libc.prctl(38, 1, 0, 0, 0) or libc.prctl(4, 0, 0, 0, 0)):
            raise RuntimeError('DOCUMENT_SANDBOX_NO_NEW_PRIVS')
        # All fs actions through TRUNCATE, plus IOCTL_DEV when supported.
        handled = ctypes.c_uint64((1 << (16 if abi >= 5 else 15)) - 1)
        ruleset = libc.syscall(444, ctypes.byref(handled), ctypes.sizeof(handled), 0)
        if ruleset < 0:
            raise RuntimeError('DOCUMENT_SANDBOX_LANDLOCK_CREATE')
        try:
            paths = [(p, READ_FILE | (READ_DIR if p.is_dir() else 0)) for p in runtime_paths()]
            paths += [(source, READ_FILE), (output, READ_FILE | READ_DIR | WRITE)]
            for path, access in paths:
                descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
                try:
                    rule = PathRule(access, descriptor)
                    if libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0):
                        raise RuntimeError('DOCUMENT_SANDBOX_LANDLOCK_RULE')
                finally:
                    os.close(descriptor)
            if libc.syscall(446, ruleset, 0):
                raise RuntimeError('DOCUMENT_SANDBOX_LANDLOCK_ENFORCE')
        finally:
            os.close(ruleset)
        if seccomp.seccomp_load(context):
            raise RuntimeError('DOCUMENT_SANDBOX_SECCOMP_ENFORCE')
    finally:
        seccomp.seccomp_release(context)


def probe(source, output, forbidden):
    import socket
    import pypdfium2
    from PIL import Image
    source.read_bytes()
    candidate = output / 'allowed'
    candidate.write_bytes(b'probe')
    candidate.unlink()
    # Test denial, not just successful installation of two kernel APIs.
    for operation in (lambda: forbidden.read_bytes(),
                      lambda: forbidden.write_bytes(b'bad'),
                      lambda: Path('/proc/self/environ').read_bytes(),
                      lambda: socket.socket(), lambda: socket.socket(socket.AF_UNIX),
                      lambda: os.kill(os.getppid(), 0), lambda: os.fork(),
                      lambda: os.chmod(forbidden, 0o777),
                      lambda: os.execv('/usr/bin/true', ['true'])):
        try:
            operation()
        except PermissionError:
            continue
        raise RuntimeError('DOCUMENT_SANDBOX_DENIAL_FAILED')
    print('document-sandbox-ok')


def main():
    source, output = (Path(p).resolve(strict=True) for p in sys.argv[1:3])
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from comic_document_files import FileLimits, MAX_IPC_BYTES, _child, _limit_child
    payload = None if len(sys.argv) == 4 else json.loads(sys.stdin.buffer.read(MAX_IPC_BYTES + 1))
    _limit_child(FileLimits(**payload['limits']) if payload else FileLimits())
    restrict(source, output, expected_parent=int(os.environ['NODE_PARSER_PARENT_PID']))
    if len(sys.argv) == 4:
        probe(source, output, Path(sys.argv[3]))
    else:
        _child(payload)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Decoder errors and local paths must not leak to instance logs.
        sys.exit(2)
