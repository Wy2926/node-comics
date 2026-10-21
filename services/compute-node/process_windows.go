package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type containedProcess struct {
	handle   windows.Handle
	pid      int
	exitCode uint32
}

func (p *containedProcess) wait() error {
	if _, err := windows.WaitForSingleObject(p.handle, windows.INFINITE); err != nil {
		return err
	}
	if err := windows.GetExitCodeProcess(p.handle, &p.exitCode); err != nil {
		return err
	}
	if p.exitCode != 0 {
		return fmt.Errorf("child exited with code %d", p.exitCode)
	}
	return nil
}

func terminateOwnedProcess(state hostState) error {
	process, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(state.PID))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil // Already exited.
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	// Recheck creation time on the actual handle, never terminate a reused PID.
	var birth, end, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &birth, &end, &kernel, &user); err != nil {
		return err
	}
	if birth.Nanoseconds() != state.Created {
		return nil
	}
	if err := windows.TerminateProcess(process, 1); err != nil {
		return err
	}
	result, err := windows.WaitForSingleObject(process, 10000)
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return errors.New("owned process exit timed out; stop NOT confirmed")
	}
	return nil
}

// Windows 10's JOB_LIST creation attribute makes containment atomic. Even if
// the host is killed during CreateProcess, no untracked child can survive.
// os/exec has no JOB_LIST option, so only these file-backed child commands use
// the native creation API. Quoting and attributes use the existing x/sys APIs.
func startContained(cmd *exec.Cmd, name string) (*containedProcess, windows.Handle, error) {
	if cmd.Err != nil {
		return nil, 0, cmd.Err
	}
	job, err := childJob(name)
	if err != nil {
		return nil, 0, err
	}
	ok := false
	defer func() {
		if !ok {
			windows.CloseHandle(job)
		}
	}()
	attributes, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, 0, err
	}
	defer attributes.Delete()
	if err := attributes.Update(0x0002000D, unsafe.Pointer(&job), unsafe.Sizeof(job)); err != nil {
		return nil, 0, err
	} // JOB_LIST
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return nil, 0, err
	}
	defer null.Close()
	var handles [3]windows.Handle
	defer func() {
		for _, handle := range handles {
			if handle != 0 {
				windows.CloseHandle(handle)
			}
		}
	}()
	for index, stream := range []any{cmd.Stdin, cmd.Stdout, cmd.Stderr} {
		file := null
		if stream != nil {
			var valid bool
			file, valid = stream.(*os.File)
			if !valid {
				return nil, 0, errors.New("contained process requires file-backed standard streams")
			}
		}
		if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(file.Fd()), windows.CurrentProcess(),
			&handles[index], 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return nil, 0, err
		}
	}
	if err := attributes.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), unsafe.Sizeof(handles)); err != nil {
		return nil, 0, err
	}
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = windows.STARTF_USESTDHANDLES
	startup.StdInput, startup.StdOutput, startup.StdErr = handles[0], handles[1], handles[2]
	application, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		return nil, 0, err
	}
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(cmd.Args))
	if err != nil {
		return nil, 0, err
	}
	var directory *uint16
	if cmd.Dir != "" {
		directory, err = windows.UTF16PtrFromString(cmd.Dir)
		if err != nil {
			return nil, 0, err
		}
	}
	values := cmd.Env
	if values == nil {
		values = os.Environ()
	}
	environment := []uint16{}
	for _, value := range values {
		entry, err := windows.UTF16FromString(value)
		if err != nil {
			return nil, 0, err
		}
		environment = append(environment, entry...)
	}
	environment = append(environment, 0)
	var info windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NO_WINDOW)
	if err := windows.CreateProcess(application, command, nil, nil, true, flags, &environment[0], directory, &startup.StartupInfo, &info); err != nil {
		return nil, 0, err
	}
	windows.CloseHandle(info.Thread)
	ok = true
	return &containedProcess{handle: info.Process, pid: int(info.ProcessId)}, job, nil
}

type jobAccounting struct {
	Times                                                                [4]int64
	PageFaultCount, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
}

func finishJob(job windows.Handle) error {
	if job == 0 {
		return nil
	}
	// ActiveProcesses can reach zero before process handles are signalled.
	// Keep synchronization handles and wait for actual process exits as well.
	var members struct {
		Assigned, Listed uint32
		IDs              [256]uintptr
	}
	if err := windows.QueryInformationJobObject(job, windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&members)), uint32(unsafe.Sizeof(members)), nil); err != nil {
		return err
	}
	handles := []windows.Handle{}
	defer func() {
		for _, handle := range handles {
			windows.CloseHandle(handle)
		}
	}()
	for _, pid := range members.IDs[:members.Listed] {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue
		}
		if err != nil {
			return err
		}
		handles = append(handles, handle)
	}
	if err := windows.TerminateJobObject(job, 0); err != nil {
		return err
	}
	for _, handle := range handles {
		result, err := windows.WaitForSingleObject(handle, 10000)
		if err != nil {
			return err
		}
		if result != windows.WAIT_OBJECT_0 {
			return errors.New("child exit timed out; stop NOT confirmed")
		}
	}
	until := time.Now().Add(10 * time.Second)
	for time.Now().Before(until) {
		var info jobAccounting
		if err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
			return err
		}
		if info.ActiveProcesses == 0 {
			return nil
		}
		time.Sleep(25 * time.Millisecond)
	}
	return errors.New("child processes did not exit; GPU release is NOT confirmed")
}

func openJob(name string) (windows.Handle, error) {
	value, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	// x/sys exposes Create/Query/Terminate but not OpenJobObjectW.
	result, _, callErr := windows.NewLazySystemDLL("kernel32.dll").NewProc("OpenJobObjectW").Call(
		0x0004|0x0008, 0, uintptr(unsafe.Pointer(value))) // QUERY | TERMINATE
	handle := windows.Handle(result)
	if result != 0 {
		return handle, nil
	}
	err = callErr
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return 0, nil
	}
	return handle, err
}

func runContained(cmd *exec.Cmd, name string) error {
	child, job, err := startContained(cmd, name)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	defer windows.CloseHandle(child.handle)
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	defer signal.Stop(interrupt)
	done := make(chan error, 1)
	go func() { done <- child.wait() }()
	select {
	case err = <-done:
	case <-interrupt:
		_ = windows.TerminateJobObject(job, 1)
		err = <-done
	}
	return errors.Join(err, finishJob(job))
}
