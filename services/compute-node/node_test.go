package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestMain(m *testing.M) {
	if os.Getenv("NODE_TEST_FIXTURE") == "1" {
		if len(os.Args) > 1 && os.Args[1] == "-B" {
			fixtureWorker()
			os.Exit(0)
		}
		if len(os.Args) > 1 && (os.Args[1] == "_host" || os.Args[1] == "doctor" || os.Args[1] == "_autostart") {
			if err := entry(os.Args[1:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}

func fixtureWorker() {
	path := os.Args[len(os.Args)-3]
	root := filepath.Join(filepath.Dir(path), "state")
	_ = os.MkdirAll(root, 0700)
	for {
		if _, err := os.Stat(filepath.Join(root, "crash")); err == nil {
			_ = os.Remove(filepath.Join(root, "crash"))
			os.Exit(23)
		}
		if _, err := os.Stat(filepath.Join(root, "stop")); err == nil {
			return
		}
		connected := true
		if os.Getenv("NODE_TEST_OFFLINE") == "1" {
			_, err := os.Stat(filepath.Join(root, "network-ready"))
			connected = err == nil
		}
		_ = writeJSON(filepath.Join(root, "status.json"), map[string]any{"pid": os.Getpid(), "updated_at": time.Now().UTC(), "phase": "running", "connected": connected, "loop_age_seconds": 0})
		time.Sleep(100 * time.Millisecond)
	}
}

func fixtureBundle(t *testing.T, backend string) app {
	t.Helper()
	root := t.TempDir()
	a := app{root: root, home: filepath.Join(root, "data")}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	seedFiles := map[string]string{}
	for _, name := range []string{"node.exe", "source/compute-node/run_node.py", "source/compute-node/prepare.ps1", "payload/runtime/python.exe", "payload/engine/classic_node/__main__.py", "payload/fonts/font.bin", "payload/mtu-assets.json", "payload/runtime-requirements.txt"} {
		path := filepath.Join(root, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(path), 0700)
		content := data
		if filepath.Ext(name) != ".exe" {
			content = []byte("fixture")
		}
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(content)
		if strings.HasPrefix(name, "payload/") {
			files[strings.TrimPrefix(name, "payload/")] = hex.EncodeToString(hash[:])
		} else {
			seedFiles[name] = hex.EncodeToString(hash[:])
		}
	}
	if err := writeJSON(filepath.Join(root, "payload", "release.json"), releaseManifest{Version: "test", Platform: "windows-amd64", Python: "3.12.11", Backend: backend, Files: files, Fonts: []string{"fonts/font.bin"}}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(root, "portable.json"), releaseManifest{Format: "gpu-portable-v1", Platform: "windows-amd64", Python: "3.12.11", Files: seedFiles, Requirements: map[string]string{"cuda": files["runtime-requirements.txt"], "amd": files["runtime-requirements.txt"]}}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(a.configPath(), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestManifestRejectsCorruptionAndEscapes(t *testing.T) {
	a := fixtureBundle(t, "cuda")
	if err := a.verifyBundle(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside", "C:/outside", "runtime/../../outside"} {
		if _, err := safePath(a.root, path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	_ = os.WriteFile(filepath.Join(a.bundleRoot(), "fonts/font.bin"), []byte("changed"), 0600)
	if a.verifyBundle() == nil {
		t.Fatal("accepted changed font")
	}
}

func TestSingleOwner(t *testing.T) {
	a := fixtureBundle(t, "cuda")
	first, err := acquireLock(filepath.Join(a.home, "host.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if second, err := acquireLock(filepath.Join(a.home, "host.lock")); err == nil {
		second.Close()
		t.Fatal("duplicate owner")
	}
	first.Close()
}

func waitFor(t *testing.T, timeout time.Duration, check func() bool) {
	t.Helper()
	until := time.Now().Add(timeout)
	for time.Now().Before(until) {
		if check() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("condition timed out")
}

func startFixture(t *testing.T, a app, command string, environment ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(filepath.Join(a.root, "node.exe"), command, "--home", a.home)
	cmd.Env = append(append(os.Environ(), "NODE_TEST_FIXTURE=1"), environment...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.stop(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

func launchFixture(t *testing.T, a app) *exec.Cmd {
	t.Helper()
	cmd := startFixture(t, a, "_host")
	waitFor(t, 10*time.Second, func() bool { return a.status()["connected"] == true })
	return cmd
}

func processExitCheck(t *testing.T, pids ...int) func(uint32) {
	t.Helper()
	handles := make([]windows.Handle, 0, len(pids))
	for _, pid := range pids {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { windows.CloseHandle(handle) })
		handles = append(handles, handle)
	}
	return func(timeout uint32) {
		t.Helper()
		for index, handle := range handles {
			if result, err := windows.WaitForSingleObject(handle, timeout); err != nil || result != windows.WAIT_OBJECT_0 {
				t.Fatal("fixture process has not exited", pids[index], result, err)
			}
		}
	}
}

func TestNativeSupervisorRecoversWorkerAndHonorsStop(t *testing.T) {
	a := fixtureBundle(t, "cuda")
	cmd := launchFixture(t, a)
	before, _ := a.liveHost()
	_ = os.WriteFile(filepath.Join(a.statePath(), "crash"), []byte("fail"), 0600)
	waitFor(t, 15*time.Second, func() bool {
		now, _ := a.liveHost()
		return now.WorkerPID != before.WorkerPID && now.Restarts > 0 && a.status()["connected"] == true
	})
	if err := a.stop(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if a.status()["connected"] == true {
		t.Fatal("stopped node reported online")
	}
	time.Sleep(1500 * time.Millisecond)
	if _, alive := a.liveHost(); alive {
		t.Fatal("operator stop restarted")
	}
}

func TestKernelJobKillsWorkerWhenHostCrashes(t *testing.T) {
	a := fixtureBundle(t, "cuda")
	cmd := launchFixture(t, a)
	state, _ := a.liveHost()
	exited := processExitCheck(t, state.WorkerPID)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	exited(10000)
}

func TestWatchdogUsesWorkerGenerationAndProgress(t *testing.T) {
	a := fixtureBundle(t, "cuda")
	for _, test := range []struct {
		name, phase                       string
		pid, age, loopAge, runningSeconds int
		stalled                           bool
	}{
		{"stalled-loop", "running", 12, 0, 121, 0, true},
		{"old-worker", "running", 13, 0, 121, 0, false},
		{"stale-status", "running", 12, 30, 1, 0, true},
		{"warmup", "starting", 12, 30, 60, 60, false},
		{"warmup-timeout", "starting", 12, 30, 60, 601, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_ = writeJSON(filepath.Join(a.statePath(), "status.json"), map[string]any{"pid": 12,
				"updated_at": time.Now().Add(-time.Duration(test.age) * time.Second), "phase": test.phase, "loop_age_seconds": test.loopAge})
			if a.workerStalled(test.pid, time.Now().Add(-time.Duration(test.runningSeconds)*time.Second)) != test.stalled {
				t.Fatal("incorrect watchdog decision", test)
			}
		})
	}
}

func TestOriginsRejectCredentialsAndNonTLS(t *testing.T) {
	for _, origin := range []string{"http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?token=x"} {
		if validOrigin(origin) {
			t.Fatal(fmt.Sprint("accepted ", origin))
		}
	}
	if !validOrigin("https://example.test:443") {
		t.Fatal("valid origin rejected")
	}
}

func TestPrivateDataCannotOwnProgramOrAncestor(t *testing.T) {
	root := filepath.Join(t.TempDir(), "release")
	for _, home := range []string{root, filepath.Dir(root), filepath.Join(root, "runtime")} {
		if (app{root: root, home: home}).validateHome() == nil {
			t.Fatal("accepted unsafe private data directory", home)
		}
	}
	for _, home := range []string{filepath.Join(root, "data"), filepath.Join(filepath.Dir(root), "private")} {
		if err := (app{root: root, home: home}).validateHome(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInitPreservesExistingDirectory(t *testing.T) {
	root := t.TempDir()
	a := app{root: filepath.Join(root, "release"), home: filepath.Join(root, "private")}
	if err := os.MkdirAll(a.home, 0700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(a.home, "existing.txt")
	_ = os.WriteFile(sentinel, []byte("keep"), 0600)
	if a.initialize("") == nil {
		t.Fatal("accepted nonempty data directory")
	}
	data, err := os.ReadFile(sentinel)
	if err != nil || string(data) != "keep" {
		t.Fatal("existing file changed")
	}
}
