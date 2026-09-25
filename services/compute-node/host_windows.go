package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func machineID() (string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "", err
	}
	defer key.Close()
	value, _, err := key.GetStringValue("MachineGuid")
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:]), nil
}

func protectDirectory(path string, service bool) error {
	rights := ""
	if service {
		rights = "0x1301bf" // Modify, excluding permission/ownership changes.
	}
	return setDirectoryPermissions(path, rights)
}

func setDirectoryPermissions(path, serviceRights string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sddl := "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + user.User.Sid.String() + ")"
	if serviceRights != "" {
		sid, _, _, err := windows.LookupSID("", `NT SERVICE\`+serviceName)
		if err != nil {
			return err
		}
		sddl += "(A;OICI;" + serviceRights + ";;;" + sid.String() + ")"
	}
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func acquireLock(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

type hostState struct {
	PID       int       `json:"pid"`
	Created   int64     `json:"process_created"`
	Updated   time.Time `json:"updated_at"`
	Phase     string    `json:"phase"`
	WorkerPID int       `json:"worker_pid"`
	Restarts  int       `json:"restarts"`
	Version   string    `json:"version"`
}

func processIdentity(pid int) (string, int64, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", 0, err
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return "", 0, err
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return "", 0, err
	}
	return windows.UTF16ToString(buffer[:size]), created.Nanoseconds(), nil
}

func (a app) liveHost() (hostState, bool) {
	var state hostState
	if readJSON(filepath.Join(a.home, "supervisor.json"), &state) != nil || state.PID <= 0 {
		return state, false
	}
	exe, created, err := processIdentity(state.PID)
	return state, err == nil && created == state.Created && strings.EqualFold(exe, filepath.Join(a.root, "node.exe"))
}

func (a app) status() map[string]any {
	host, alive := a.liveHost()
	var worker map[string]any
	_ = readJSON(filepath.Join(a.statePath(), "status.json"), &worker)
	connected := false
	if alive && time.Since(host.Updated) < 10*time.Second && host.Phase == "running" && worker != nil {
		updated, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(worker["updated_at"]))
		pid, _ := worker["pid"].(float64)
		connected = worker["connected"] == true && int(pid) == host.WorkerPID && time.Since(updated) < 10*time.Second
	}
	return map[string]any{"supervisor_alive": alive, "connected": connected, "supervisor": host, "worker": worker, "home": a.home}
}

func (a app) start() error {
	if _, alive := a.liveHost(); alive {
		if a.status()["connected"] == true {
			return printJSON(a.status())
		}
		return errors.New("supervisor is already running but has no fresh successful heartbeat; inspect node status and logs")
	}
	if err := a.checkBinding(); err != nil {
		return err
	}
	cmd := exec.Command(filepath.Join(a.root, "node.exe"), "_host", "--home", a.home)
	cmd.Dir = a.root
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS, HideWindow: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer cmd.Process.Release()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if a.status()["connected"] == true {
			return printJSON(a.status())
		}
		time.Sleep(time.Second)
	}
	return errors.New("no successful heartbeat within 90 seconds; inspect node status and logs (supervisor continues recovery)")
}

func (a app) requestStop() error {
	return os.WriteFile(filepath.Join(a.home, "host.stop"), []byte("operator stop\n"), 0600)
}

func (a app) stop() error {
	if err := a.requestStop(); err != nil {
		return err
	}
	deadline := time.Now().Add(85 * time.Second)
	for time.Now().Before(deadline) {
		if _, alive := a.liveHost(); !alive {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("supervisor did not stop; inspect its PID and logs")
}

// The kernel kills the worker if the native host is terminated. No orphaned
// Python process can retain GPU memory or race a replacement host.
func childJob(process *os.Process) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err == nil {
		var handle windows.Handle
		handle, err = windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.Pid))
		if err == nil {
			err = windows.AssignProcessToJobObject(job, handle)
			windows.CloseHandle(handle)
		}
	}
	if err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

type rotatingLog struct{ path string }

func (r rotatingLog) Write(data []byte) (int, error) {
	if info, err := os.Stat(r.path); err == nil && info.Size()+int64(len(data)) > 10*1024*1024 {
		_ = os.Remove(r.path + ".5")
		for i := 4; i >= 1; i-- {
			_ = os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
		}
		if err := os.Rename(r.path, r.path+".1"); err != nil {
			return 0, err
		}
	}
	file, err := os.OpenFile(r.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	return file.Write(data)
}

func (a app) supervise(console bool, stopRequests ...<-chan struct{}) error {
	if err := a.checkBinding(); err != nil {
		return err
	}
	lock, err := acquireLock(filepath.Join(a.home, "host.lock"))
	if err != nil {
		return errors.New("another supervisor owns this node")
	}
	defer lock.Close()
	if err := os.MkdirAll(filepath.Join(a.home, "logs"), 0700); err != nil {
		return err
	}
	logger := log.New(rotatingLog{filepath.Join(a.home, "logs", "supervisor.log")}, "", log.Ldate|log.Ltime|log.LUTC)
	logger.Printf("event=supervisor_start version=%s", version)
	if err := os.MkdirAll(a.statePath(), 0700); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(a.home, "host.stop"))
	_ = os.Remove(filepath.Join(a.statePath(), "stop"))
	_, created, err := processIdentity(os.Getpid())
	if err != nil {
		return err
	}
	state := hostState{PID: os.Getpid(), Created: created, Phase: "starting", Version: version}
	publish := func() error {
		state.Updated = time.Now().UTC()
		return writeJSON(filepath.Join(a.home, "supervisor.json"), state)
	}
	defer func() { state.Phase = "stopped"; state.WorkerPID = 0; _ = publish() }()
	if err := publish(); err != nil {
		return err
	}
	if len(stopRequests) > 0 {
		finished := make(chan struct{})
		defer close(finished)
		go func() {
			select {
			case <-stopRequests[0]:
				_ = a.requestStop()
			case <-finished:
			}
		}()
	}
	if err := a.verifyBundle(); err != nil {
		logger.Printf("event=invalid_release")
		return err
	}
	interrupt := make(chan os.Signal, 1)
	if console {
		signal.Notify(interrupt, os.Interrupt)
		defer signal.Stop(interrupt)
	}
	backoff := time.Second
	for {
		if _, err := os.Stat(filepath.Join(a.home, "host.stop")); err == nil {
			return nil
		}
		cmd := a.worker("run")
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
		if err := cmd.Start(); err != nil {
			logger.Print("event=worker_start_failed")
			return errors.New("cannot start bundled runtime")
		}
		job, err := childJob(cmd.Process)
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return fmt.Errorf("cannot contain worker: %w", err)
		}
		state.WorkerPID = cmd.Process.Pid
		state.Phase = "running"
		logger.Printf("event=worker_started pid=%d", state.WorkerPID)
		started := time.Now()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		stopping := time.Time{}
		finished := false
		for !finished {
			if err := publish(); err != nil {
				windows.CloseHandle(job)
				<-done
				return err
			}
			select {
			case <-done:
				finished = true
			case <-interrupt:
				_ = a.requestStop()
			case <-time.After(time.Second):
			}
			if _, err := os.Stat(filepath.Join(a.home, "host.stop")); err == nil && stopping.IsZero() {
				stopping = time.Now()
				state.Phase = "stopping"
				_ = os.WriteFile(filepath.Join(a.statePath(), "stop"), []byte("operator stop\n"), 0600)
			}
			if !stopping.IsZero() && time.Since(stopping) > 75*time.Second {
				logger.Print("event=worker_stop_timeout")
				_ = windows.TerminateJobObject(job, 1)
			}
			if stopping.IsZero() && a.workerStalled(state.WorkerPID, started) {
				logger.Print("event=worker_watchdog_timeout")
				_ = windows.TerminateJobObject(job, 1)
			}
		}
		windows.CloseHandle(job)
		logger.Printf("event=worker_exit code=%d", cmd.ProcessState.ExitCode())
		state.WorkerPID = 0
		if !stopping.IsZero() {
			return nil
		}
		state.Restarts++
		state.Phase = "recovering"
		if time.Since(started) > 5*time.Minute {
			backoff = time.Second
		}
		logger.Printf("event=worker_retry delay_seconds=%d", int(backoff.Seconds()))
		until := time.Now().Add(backoff)
		for time.Now().Before(until) {
			if err := publish(); err != nil {
				return err
			}
			if _, err := os.Stat(filepath.Join(a.home, "host.stop")); err == nil {
				return nil
			}
			select {
			case <-interrupt:
				_ = a.requestStop()
			case <-time.After(time.Second):
			}
		}
		backoff = min(time.Minute, backoff*2)
	}
}

func (a app) workerStalled(pid int, started time.Time) bool {
	var state struct {
		PID     int       `json:"pid"`
		Updated time.Time `json:"updated_at"`
		Phase   string    `json:"phase"`
		LoopAge float64   `json:"loop_age_seconds"`
	}
	err := readJSON(filepath.Join(a.statePath(), "status.json"), &state)
	if err != nil || state.PID != pid {
		return time.Since(started) > 60*time.Second
	}
	if time.Since(state.Updated) > 20*time.Second {
		return true
	}
	limit := float64(120)
	if state.Phase == "starting" {
		limit = 600
	}
	return state.LoopAge > limit
}
