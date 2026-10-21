package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func init() {
	if len(os.Args) < 2 {
		return
	}
	command := os.Args[1]
	if (command == "doctor-verifying" && os.Getenv("NODE_DOCTOR_VERIFY") == "1") ||
		(command == "portable-setup" && os.Getenv("NODE_PORTABLE_LAUNCH") == "1") {
		a := app{root: filepath.Dir(os.Args[0])}
		a.home = filepath.Join(a.root, "data")
		phase := "preparing"
		if command == "doctor-verifying" {
			phase = "checking"
		}
		finish, err := a.beginLaunch(phase)
		if err != nil {
			os.Exit(6)
		}
		defer finish()
		child := exec.Command(os.Args[0], "portable-grandchild", filepath.Join(a.root, ".setup/setup-child.pid"))
		if command == "doctor-verifying" {
			// Hold verification before a GPU child, under the real doctor guard.
			for {
				if _, err := os.Stat(filepath.Join(a.root, ".setup/verification-complete")); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			child = a.worker("check")
		}
		_ = runContained(child, a.jobName("prepare"))
		os.Exit(0)
	}
	if os.Getenv("NODE_PORTABLE_TREE") != "1" {
		return
	}
	if os.Args[1] == "portable-grandchild" {
		_ = os.WriteFile(os.Args[2], []byte(strconv.Itoa(os.Getpid())), 0600)
		for {
			time.Sleep(time.Second)
		}
	}
	if os.Args[1] == "-B" {
		config := os.Args[len(os.Args)-3]
		child := exec.Command(os.Args[0], "portable-grandchild", filepath.Join(filepath.Dir(config), "grandchild.pid"))
		if child.Start() != nil {
			os.Exit(5)
		}
		_ = child.Process.Release()
		fixtureWorker()
		os.Exit(0)
	}
}

func waitPID(t *testing.T, path string) int {
	t.Helper()
	var pid int
	waitFor(t, 10*time.Second, func() bool {
		data, err := os.ReadFile(path)
		pid, _ = strconv.Atoi(string(data))
		return err == nil && pid > 0
	})
	return pid
}

func TestStopWaitsForEntireComputeTree(t *testing.T) {
	t.Setenv("NODE_PORTABLE_TREE", "1")
	a := fixtureBundle(t, "cuda")
	cmd := launchFixture(t, a)
	exited := processExitCheck(t, waitPID(t, filepath.Join(a.home, "grandchild.pid")))
	if err := a.stop(); err != nil {
		t.Fatal(err)
	}
	exited(0)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := a.stop(); err != nil {
		t.Fatal("repeated stop must be harmless", err)
	}
}

func TestChildEnvironmentIsPrivateAndDoesNotMutateParent(t *testing.T) {
	t.Setenv("PYTHONPATH", "foreign-python")
	t.Setenv("NODE_TOKEN", "foreign-token")
	t.Setenv("TEMP", "foreign-temp")
	directory := t.TempDir()
	if err := localDirectories(directory); err != nil {
		t.Fatal(err)
	}
	env := localEnvironment(directory)
	values := map[string]string{}
	for _, item := range env {
		pair := strings.SplitN(item, "=", 2)
		values[strings.ToUpper(pair[0])] = pair[1]
	}
	if values["NODE_TOKEN"] != "" || values["PYTHONPATH"] != "" {
		t.Fatal("inherited private configuration")
	}
	for key := range localPaths {
		if !strings.HasPrefix(values[key], directory+string(filepath.Separator)) {
			t.Fatal(key, values[key])
		}
		if info, err := os.Stat(values[key]); err != nil || !info.IsDir() {
			t.Fatal("cache directory must exist before a library checks writability", key, err)
		}
	}
	if os.Getenv("TEMP") != "foreign-temp" || os.Getenv("PYTHONPATH") != "foreign-python" {
		t.Fatal("changed parent environment")
	}
}

func TestPortablePayloadTracksDependenciesNotPackageVersion(t *testing.T) {
	a := fixtureBundle(t, "amd")
	if err := a.verifyBundle(); err != nil {
		t.Fatal(err)
	}
	if err := a.checkPayload("amd"); err != nil {
		t.Fatal(err)
	}
	if a.checkPayload("cuda") == nil {
		t.Fatal("silently switched backend")
	}
	if a.checkConfiguredBackend() == nil {
		t.Fatal("accepted CUDA config in AMD environment")
	}
	_ = writeJSON(a.configPath(), map[string]any{"engine": map[string]string{"backend": "amd"}})
	if err := a.checkConfiguredBackend(); err != nil {
		t.Fatal(err)
	}
	var legacy map[string]any
	_ = readJSON(filepath.Join(a.bundleRoot(), "release.json"), &legacy)
	legacy["seed_sha256"] = "previous-package-fingerprint"
	_ = writeJSON(filepath.Join(a.bundleRoot(), "release.json"), legacy)
	before, _ := os.ReadFile(filepath.Join(a.bundleRoot(), "release.json"))
	var next releaseManifest
	_ = readJSON(filepath.Join(a.root, "portable.json"), &next)
	next.Version = "new-logic-version"
	next.Files["changed-code.py"] = strings.Repeat("a", 64)
	_ = writeJSON(filepath.Join(a.root, "portable.json"), next)
	if err := a.launch("", "amd", true, false); err != nil {
		t.Fatal("logic update did not reuse legacy dependencies", err)
	}
	after, _ := os.ReadFile(filepath.Join(a.bundleRoot(), "release.json"))
	if string(before) != string(after) {
		t.Fatal("logic update rewrote dependency manifest")
	}
	next.Requirements["amd"] = strings.Repeat("0", 64)
	_ = writeJSON(filepath.Join(a.root, "portable.json"), next)
	if a.checkPayload("amd") == nil {
		t.Fatal("accepted incompatible dependencies")
	}
}

func TestPortablePrepareReuseAndConcurrentLaunch(t *testing.T) {
	a := fixtureBundle(t, "amd")
	if err := a.launch("", "amd", true, false); err != nil {
		t.Fatal(err)
	}
	if _, alive := a.liveHost(); alive {
		t.Fatal("prepare started a node")
	}
	lock, err := acquireLock(filepath.Join(a.root, ".setup", "launch.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if a.launch("", "amd", true, false) == nil {
		t.Fatal("concurrent preparation was accepted")
	}
}

func TestRepeatedLaunchDoesNotStopExistingRecoveringNode(t *testing.T) {
	a := fixtureBundle(t, "amd")
	_ = writeJSON(a.configPath(), map[string]any{"engine": map[string]string{"backend": "amd"}})
	launchFixture(t, a)
	_ = os.WriteFile(filepath.Join(a.statePath(), "crash"), []byte("fail"), 0600)
	waitFor(t, 10*time.Second, func() bool {
		state, _ := a.liveHost()
		return state.Phase == "recovering"
	})
	_ = a.launch("", "amd", false, false)
	if _, alive := a.liveHost(); !alive {
		t.Fatal("second launch stopped the existing recovering node")
	}
}

func TestStopBeforeInitializationDoesNotCreatePrivateState(t *testing.T) {
	a := app{root: t.TempDir()}
	a.home = filepath.Join(a.root, "data")
	if err := a.stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a.home); !os.IsNotExist(err) {
		t.Fatal("stop polluted an uninitialized data directory")
	}
}

func TestStopCancelsPreparationTreeAndGatesLateStart(t *testing.T) {
	a := fixtureBundle(t, "amd")
	startFixture(t, a, "portable-setup", "NODE_PORTABLE_LAUNCH=1", "NODE_PORTABLE_TREE=1")
	exited := processExitCheck(t, waitPID(t, filepath.Join(a.root, ".setup/setup-child.pid")))
	if err := a.stop(); err != nil {
		t.Fatal(err)
	}
	exited(0)
	if err := a.supervise(); err != nil {
		t.Fatal(err)
	}
	if _, alive := a.liveHost(); alive {
		t.Fatal("late host started after Stop")
	}
	if err := a.launch("", "amd", true, false); err != nil {
		t.Fatal("could not retry after stop", err)
	}
}

func TestStopCancelsDiagnosticsBeforeAndAfterWorkerStart(t *testing.T) {
	for _, command := range []string{"doctor-verifying", "doctor"} {
		t.Run(command, func(t *testing.T) {
			a := fixtureBundle(t, "cuda")
			cmd := startFixture(t, a, command, "NODE_DOCTOR_VERIFY=1", "NODE_PORTABLE_TREE=1")
			waitFor(t, 10*time.Second, func() bool {
				var state hostState
				return readJSON(filepath.Join(a.root, ".setup/launcher.json"), &state) == nil &&
					state.PID == cmd.Process.Pid && state.Phase == "checking"
			})
			pids := []int{cmd.Process.Pid}
			if command == "doctor" {
				descendant := waitPID(t, filepath.Join(a.home, "grandchild.pid"))
				var worker struct {
					PID int `json:"pid"`
				}
				if err := readJSON(filepath.Join(a.statePath(), "status.json"), &worker); err != nil {
					t.Fatal(err)
				}
				pids = append(pids, worker.PID, descendant)
			}
			exited := processExitCheck(t, pids...)
			if err := a.stop(); err != nil {
				t.Fatal(err)
			}
			exited(0)
			if command == "doctor-verifying" {
				_ = os.WriteFile(filepath.Join(a.root, ".setup/verification-complete"), []byte("continue"), 0600)
				time.Sleep(200 * time.Millisecond)
				if _, err := os.Stat(filepath.Join(a.home, "grandchild.pid")); !os.IsNotExist(err) {
					t.Fatal("cancelled diagnostic started a late compute tree")
				}
			}
		})
	}
}

func TestDoctorDoesNotDisplaceRunningHost(t *testing.T) {
	a := fixtureBundle(t, "cuda")
	launchFixture(t, a)
	before, _ := a.liveHost()
	cmd := exec.Command(filepath.Join(a.root, "node.exe"), "doctor", "--home", a.home)
	cmd.Env = append(os.Environ(), "NODE_TEST_FIXTURE=1")
	if output, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(output), "stop this node before running GPU diagnostics") {
		t.Fatal("doctor did not reject the running host", err, string(output))
	}
	after, alive := a.liveHost()
	if !alive || after.WorkerPID != before.WorkerPID || a.status()["connected"] != true {
		t.Fatal("diagnostic displaced the running node", after)
	}
}
