package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func autostartFixture(t *testing.T) app {
	t.Helper()
	a := fixtureBundle(t, "amd")
	root := filepath.Join(t.TempDir(), "long-path-"+strings.Repeat("x", 35)+" 中文 节点's $&%;")
	if err := os.Rename(a.root, root); err != nil {
		t.Fatal(err)
	}
	a.root = root
	a.home = filepath.Join(root, "data", "自定义's $&%; home")
	if err := writeJSON(a.configPath(), map[string]any{"engine": map[string]string{"backend": "amd"}}); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestAutostartSerializesEnableAndDisable(t *testing.T) {
	a := autostartFixture(t)
	startup := t.TempDir()
	lock, err := acquireLock(filepath.Join(a.root, ".setup", a.autostartName()+".lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	for _, action := range []string{"enable", "disable"} {
		if _, err := a.manageAutostart(startup, action); err == nil {
			t.Fatal("concurrent change accepted", action)
		}
	}
	if state, err := a.manageAutostart(startup, "status"); err != nil || state.Registered {
		t.Fatal("read-only status failed during pending enable", state, err)
	}
}

func TestAutostartShortcutLifecycleAndIsolation(t *testing.T) {
	a := autostartFixture(t)
	startup := filepath.Join(t.TempDir(), "Startup")
	state, err := a.manageAutostart(startup, "status")
	if err != nil || state.Registered {
		t.Fatal("must default to disabled", state, err)
	}
	if _, err := os.Stat(startup); !os.IsNotExist(err) {
		t.Fatal("status created a startup directory")
	}
	state, err = a.manageAutostart(startup, "enable")
	if err != nil || !state.Registered || state.Trigger != "current-user-logon" {
		t.Fatal(state, err)
	}
	before, _ := os.ReadFile(state.Shortcut)
	if _, err := a.manageAutostart(startup, "enable"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(state.Shortcut)
	if !bytes.Equal(before, after) {
		t.Fatal("repeat enable rewrote shortcut")
	}
	b := app{root: a.root, home: filepath.Join(a.root, "data", "different")}
	if strings.EqualFold(a.autostartName(), b.autostartName()) {
		t.Fatal("different identities share a shortcut")
	}
	if _, err := b.manageAutostart(startup, "disable"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(state.Shortcut); err != nil {
		t.Fatal("other identity removed our shortcut", err)
	}
	for i := 0; i < 2; i++ {
		state, err = a.manageAutostart(startup, "disable")
		if err != nil || state.Registered {
			t.Fatal(state, err)
		}
	}
	entries, err := os.ReadDir(startup)
	if err != nil || len(entries) != 0 {
		t.Fatal("disable left startup artifacts", entries, err)
	}
}

func TestAutostartPreservesForeignShortcut(t *testing.T) {
	a := autostartFixture(t)
	startup := t.TempDir()
	path := filepath.Join(startup, a.autostartName())
	original := []byte("unrelated file must not be replaced or removed")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"enable", "disable", "status"} {
		if _, err := a.manageAutostart(startup, action); err == nil {
			t.Fatal("accepted foreign shortcut", action)
		}
		data, _ := os.ReadFile(path)
		if !bytes.Equal(data, original) {
			t.Fatal("modified foreign shortcut", action)
		}
	}
}

func TestAutostartRequiresPreparedIdentityAndNeverInstalls(t *testing.T) {
	for _, missing := range []string{"config", "payload"} {
		t.Run(missing, func(t *testing.T) {
			a := fixtureBundle(t, "cuda")
			var err error
			if missing == "config" {
				err = os.Remove(a.configPath())
			} else {
				err = os.Rename(a.bundleRoot(), filepath.Join(a.root, "saved-payload"))
			}
			if err != nil {
				t.Fatal(err)
			}
			if a.autostart("enable") == nil || a.launchAtLogon() == nil {
				t.Fatal("accepted missing prerequisite", missing)
			}
			if _, err := os.Stat(filepath.Join(a.root, ".setup")); !os.IsNotExist(err) {
				t.Fatal("unattended startup attempted setup")
			}
		})
	}
}

func TestAutostartShortcutLaunchOfflineRecoveryAndStop(t *testing.T) {
	t.Setenv("NODE_TEST_FIXTURE", "1")
	t.Setenv("NODE_TEST_OFFLINE", "1")
	a := autostartFixture(t)
	startup := t.TempDir() // Never register test nodes in the user's real Startup folder.
	state, err := a.manageAutostart(startup, "enable")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.stop() })
	t.Setenv("NODE_TEST_SHORTCUT", state.Shortcut)
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.Command(ps, "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:NODE_TEST_SHORTCUT -WindowStyle Hidden")
	cmd.Dir = t.TempDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("launch shortcut: %v: %s", err, output)
	}
	waitFor(t, 15*time.Second, func() bool {
		host, alive := a.liveHost()
		return alive && host.WorkerPID > 0 && host.Phase == "running"
	})
	before, _ := a.liveHost()
	if a.status()["connected"] == true {
		t.Fatal("offline fixture reported connected")
	}
	if err := a.launchAtLogon(); err != nil {
		t.Fatal("repeat startup must preserve offline host", err)
	}
	if err := os.WriteFile(filepath.Join(a.statePath(), "network-ready"), []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, func() bool { return a.status()["connected"] == true })
	after, _ := a.liveHost()
	if before.PID != after.PID || before.WorkerPID != after.WorkerPID {
		t.Fatal("offline recovery spawned a second node")
	}
	if err := a.stop(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, alive := a.liveHost(); alive {
		t.Fatal("autostart restarted after manual stop")
	}
	if state, err = a.manageAutostart(startup, "status"); err != nil || !state.Registered {
		t.Fatal("Stop must not disable next sign-in startup", state, err)
	}
	if _, err := a.manageAutostart(startup, "disable"); err != nil {
		t.Fatal(err)
	}
}
