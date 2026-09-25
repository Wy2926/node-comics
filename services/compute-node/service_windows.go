package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "NodeComicsNode"

func grantBundleRead(path string) error {
	// Merging a read grant into inherited Authenticated Users/Modify permissions
	// would still let the service alter its executable. Use a protected DACL.
	return setDirectoryPermissions(path, "0x1200a9") // Read + execute.
}

func (a app) service(action string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return errors.New("Windows service management requires an Administrator terminal")
	}
	defer manager.Disconnect()
	if action == "install" {
		if existing, err := manager.OpenService(serviceName); err == nil {
			existing.Close()
			return errors.New("service already installed; stop and remove it before moving/upgrading the release")
		}
		if err := a.checkBinding(); err != nil {
			return err
		}
		if err := a.verifyBundle(); err != nil {
			return err
		}
		service, err := manager.CreateService(serviceName, filepath.Join(a.root, "node.exe"), mgr.Config{
			DisplayName: "Node Comics Compute Node", Description: "Node Comics native compute supervisor",
			StartType: mgr.StartAutomatic, DelayedAutoStart: true, ServiceStartName: `NT SERVICE\` + serviceName,
		}, "_service", "--home", a.home)
		if err != nil {
			return err
		}
		defer service.Close()
		rollback := true
		defer func() {
			if rollback {
				_ = service.Delete()
			}
		}()
		if err := grantBundleRead(a.root); err != nil {
			return err
		}
		if err := protectDirectory(a.home, true); err != nil {
			return err
		}
		if err = service.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}, {Type: mgr.ServiceRestart, Delay: 30 * time.Second}, {Type: mgr.ServiceRestart, Delay: time.Minute}}, 86400); err != nil {
			return err
		}
		if err = service.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
			return err
		}
		rollback = false
		fmt.Println("Installed automatic service with a dedicated Windows virtual account. Run node service start, then verify node status reports connected.")
		return nil
	}
	service, err := manager.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return err
	}
	// Never start, remove or stop a same-named service installed from another
	// directory. Moving software requires removing its previous registration.
	parts, parseErr := windows.DecomposeCommandLine(config.BinaryPathName)
	if parseErr != nil || len(parts) != 4 || !strings.EqualFold(parts[0], filepath.Join(a.root, "node.exe")) || parts[1] != "_service" || parts[2] != "--home" || !strings.EqualFold(parts[3], a.home) {
		return errors.New("service belongs to a different release/data path; manage it from that installation")
	}
	switch action {
	case "start":
		if _, alive := a.liveHost(); alive {
			return errors.New("a foreground/background host is already running; stop it before starting the service")
		}
		return service.Start()
	case "status":
		status, err := service.Query()
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"name": serviceName, "service_state": status.State, "node": a.status()})
	case "stop", "remove":
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Stopped {
			if _, err = service.Control(svc.Stop); err != nil {
				return err
			}
			until := time.Now().Add(90 * time.Second)
			for time.Now().Before(until) {
				status, err = service.Query()
				if err != nil {
					return err
				}
				if status.State == svc.Stopped {
					break
				}
				time.Sleep(time.Second)
			}
			if status.State != svc.Stopped {
				return errors.New("service stop timed out; registration retained")
			}
		}
		if action == "remove" {
			return service.Delete()
		}
		return nil
	default:
		return errors.New("unknown service operation")
	}
}

type serviceHandler struct{ app app }

func (h serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	statuses <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	stop := make(chan struct{})
	go func() { done <- h.app.supervise(false, stop) }()
	status := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	statuses <- status
	for {
		select {
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				statuses <- status
			case svc.Stop, svc.Shutdown:
				if status.State != svc.StopPending {
					close(stop)
				}
				status = svc.Status{State: svc.StopPending, WaitHint: 80000}
				statuses <- status
			}
		}
	}
}

func (a app) serve() error {
	service, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !service {
		return errors.New("internal service entry requires Windows Service Control Manager")
	}
	return svc.Run(serviceName, serviceHandler{a})
}
