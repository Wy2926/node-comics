package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func TestMain(m *testing.M) {
	if os.Getenv("NODE_TEST_FIXTURE") == "1" {
		if len(os.Args) > 1 && os.Args[1] == "-B" {
			fixtureWorker()
			os.Exit(0)
		}
		if len(os.Args) > 1 && os.Args[1] == "_host" {
			if entry(os.Args[1:]) != nil {
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
		_ = writeJSON(filepath.Join(root, "status.json"), map[string]any{"pid": os.Getpid(), "updated_at": time.Now().UTC(), "phase": "running", "connected": true, "loop_age_seconds": 0})
		time.Sleep(100 * time.Millisecond)
	}
}

func fixtureBundle(t *testing.T) app {
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
	for _, name := range []string{"node.exe", "runtime/python.exe", "engine/classic_node/__main__.py", "fonts/font.bin"} {
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
		files[name] = hex.EncodeToString(hash[:])
	}
	if err := writeJSON(filepath.Join(root, "release.json"), releaseManifest{Version: "test", Platform: "windows-amd64", Files: files, Fonts: []string{"fonts/font.bin"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(a.home, 0700); err != nil {
		t.Fatal(err)
	}
	if err := a.bind(); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(a.configPath(), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestManifestRejectsCorruptionAndEscapes(t *testing.T) {
	a := fixtureBundle(t)
	if err := a.verifyBundle(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside", "C:/outside", "runtime/../../outside"} {
		if _, err := safePath(a.root, path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	_ = os.WriteFile(filepath.Join(a.root, "fonts/font.bin"), []byte("changed"), 0600)
	if a.verifyBundle() == nil {
		t.Fatal("accepted changed font")
	}
}

func TestIdentityAndSingleOwner(t *testing.T) {
	a := fixtureBundle(t)
	if err := a.checkBinding(); err != nil {
		t.Fatal(err)
	}
	first, err := acquireLock(filepath.Join(a.home, "host.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if second, err := acquireLock(filepath.Join(a.home, "host.lock")); err == nil {
		second.Close()
		t.Fatal("duplicate owner")
	}
	first.Close()
	_ = writeJSON(filepath.Join(a.home, "instance.json"), map[string]string{"machine": "different"})
	if a.checkBinding() == nil {
		t.Fatal("accepted another computer")
	}
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

func launchFixture(t *testing.T, a app) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(filepath.Join(a.root, "node.exe"), "_host", "--home", a.home)
	cmd.Env = append(os.Environ(), "NODE_TEST_FIXTURE=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.stop(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
	waitFor(t, 10*time.Second, func() bool { return a.status()["connected"] == true })
	return cmd
}

func TestNativeSupervisorRecoversWorkerAndHonorsStop(t *testing.T) {
	a := fixtureBundle(t)
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
	a := fixtureBundle(t)
	cmd := launchFixture(t, a)
	state, _ := a.liveHost()
	worker, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(state.WorkerPID))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(worker)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	result, err := windows.WaitForSingleObject(worker, 10000)
	if err != nil || result != windows.WAIT_OBJECT_0 {
		t.Fatal("orphan worker", result, err)
	}
}

func TestWatchdogUsesWorkerGenerationAndProgress(t *testing.T) {
	a := fixtureBundle(t)
	_ = writeJSON(filepath.Join(a.statePath(), "status.json"), map[string]any{"pid": 12, "updated_at": time.Now().UTC(), "phase": "running", "loop_age_seconds": 121})
	if !a.workerStalled(12, time.Now()) {
		t.Fatal("stalled loop not detected")
	}
	if a.workerStalled(13, time.Now()) {
		t.Fatal("previous process state used for new worker")
	}
	_ = writeJSON(filepath.Join(a.statePath(), "status.json"), map[string]any{"pid": 12, "updated_at": time.Now().Add(-30 * time.Second), "phase": "starting", "loop_age_seconds": 1})
	if !a.workerStalled(12, time.Now()) {
		t.Fatal("native stall not detected")
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

func TestServiceStopDuringStartupIsNotLost(t *testing.T) {
	a := fixtureBundle(t)
	t.Setenv("NODE_TEST_FIXTURE", "1")
	requests := make(chan svc.ChangeRequest, 1)
	statuses := make(chan svc.Status, 8)
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	done := make(chan uint32, 1)
	go func() {
		_, code := (serviceHandler{a}).Execute(nil, requests, statuses)
		done <- code
	}()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("service failed during normal startup cancellation: %d", code)
		}
	case <-time.After(10 * time.Second):
		_ = a.requestStop()
		t.Fatal("startup stop was lost")
	}
	var state hostState
	if err := readJSON(filepath.Join(a.home, "supervisor.json"), &state); err != nil || state.Phase != "stopped" || state.WorkerPID != 0 {
		t.Fatal("service left a worker running", state, err)
	}
}
