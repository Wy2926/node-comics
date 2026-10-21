package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func (a app) bundleRoot() string {
	return filepath.Join(a.root, "payload")
}

func (a app) jobName(role string) string {
	identity := a.home
	if role == "prepare" {
		identity = ""
	}
	hash := sha256.Sum256([]byte(strings.ToLower(a.root + "\n" + identity + "\n" + role)))
	return `Local\NodeComics-` + hex.EncodeToString(hash[:])
}

func (a app) verifySeed() error {
	var seed releaseManifest
	if err := readJSON(filepath.Join(a.root, "portable.json"), &seed); err != nil {
		return err
	}
	if seed.Format != "gpu-portable-v1" || seed.Platform != "windows-amd64" || len(seed.Files) == 0 {
		return errors.New("invalid portable package")
	}
	for _, name := range []string{"node.exe", "source/compute-node/run_node.py", "source/compute-node/prepare.ps1"} {
		if _, err := safePath(a.root, name); err != nil {
			return fmt.Errorf("missing portable source: %s", name)
		}
	}
	return nil
}

func (a app) checkPayload(backend string) error {
	m, err := a.manifest()
	if err != nil {
		return errors.New("environment is not ready; run Start.cmd or node prepare")
	}
	var seed releaseManifest
	if err := readJSON(filepath.Join(a.root, "portable.json"), &seed); err != nil {
		return err
	}
	if m.Backend != "cuda" && m.Backend != "amd" {
		return errors.New("installed environment has no supported GPU backend")
	}
	if backend != "" && backend != m.Backend {
		return errors.New("backend already prepared; use a new directory to change GPUs")
	}
	// Only actual Python/dependency changes require a new environment. Host
	// version, business source and the old seed_sha256 never enter this check.
	requirements, err := os.ReadFile(filepath.Join(a.bundleRoot(), "runtime-requirements.txt"))
	if err != nil {
		return err
	}
	hash := sha256.Sum256(bytes.ReplaceAll(requirements, []byte("\r\n"), []byte("\n")))
	if m.Python != seed.Python || seed.Requirements[m.Backend] != hex.EncodeToString(hash[:]) {
		return errors.New("Python dependencies changed, not a logic-only update; keep data/cache and prepare the changed environment separately")
	}
	for _, relative := range append([]string{"runtime/python.exe", "mtu-assets.json"}, m.Fonts...) {
		if _, err := safePath(a.bundleRoot(), relative); err != nil {
			return fmt.Errorf("missing environment file: %s", relative)
		}
	}
	return nil
}

// Preparation and diagnostics share one cancellable launcher. Stop owns the
// same lock until its contained process tree has exited, including a launcher
// still checking files that has not created its child process yet.
func (a app) beginLaunch(phase string) (func(), error) {
	setup := filepath.Join(a.root, ".setup")
	lock, err := acquireLock(filepath.Join(setup, "launch.lock"))
	if err != nil {
		return nil, errors.New("another launch/preparation/diagnostic/stop is in progress")
	}
	registered := false
	defer func() {
		if !registered {
			lock.Close()
		}
	}()
	_ = os.Remove(filepath.Join(setup, "stop"))
	if _, err := safePath(a.root, ".setup"); err != nil {
		return nil, err
	}
	if err := protectDirectory(setup); err != nil {
		return nil, err
	}
	_, created, err := processIdentity(os.Getpid())
	if err != nil {
		return nil, err
	}
	stateFile := filepath.Join(setup, "launcher.json")
	if err := writeJSON(stateFile, hostState{PID: os.Getpid(), Created: created, Phase: phase}); err != nil {
		return nil, err
	}
	registered = true
	return func() { _ = os.Remove(stateFile); _ = lock.Close() }, nil
}

func (a app) launch(from, backend string, prepareOnly, unattended bool) error {
	if backend != "" && backend != "cuda" && backend != "amd" {
		return errors.New("backend must be cuda or amd")
	}
	// A logon attempt with a missing environment must not create setup state.
	if unattended {
		if err := a.checkConfiguredBackend(); err != nil {
			return err
		}
	}
	finish, err := a.beginLaunch("preparing")
	if err != nil {
		return err
	}
	defer finish()
	if err := a.verifySeed(); err != nil {
		return err
	}
	// Logon must never prompt for credentials, install dependencies or choose a
	// GPU. Require the environment and private identity prepared by Start.cmd.
	if unattended {
		// Wi-Fi may not be ready at sign-in. Leave the supervised worker alive
		// to reconnect instead of applying the interactive heartbeat deadline.
		return a.startBackground(false)
	}
	if _, err := os.Stat(a.bundleRoot()); os.IsNotExist(err) {
		if backend == "" {
			fmt.Println("Choose GPU: cuda = NVIDIA; amd = Windows RX 6900 XT (single GPU / gfx1030).")
			backend, err = prompt(bufio.NewReader(os.Stdin), "Backend (cuda/amd)", false)
			if err != nil {
				return err
			}
			if backend != "cuda" && backend != "amd" {
				return errors.New("enter cuda or amd; no automatic CPU fallback")
			}
		}
		fmt.Println("Preparing private environment and models. First run downloads several GB; no system installation.")
		setup := filepath.Join(a.root, ".setup")
		powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		cmd := exec.Command(powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(a.root, "source/compute-node/prepare.ps1"), "-Root", a.root, "-Backend", backend)
		cmd.Dir, cmd.Env = a.root, localEnvironment(setup)
		if err := localDirectories(setup); err != nil {
			return err
		}
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := runContained(cmd, a.jobName("prepare")); err != nil {
			return fmt.Errorf("preparation failed; verified downloads retained: %w", err)
		}
	}
	if err := a.checkPayload(backend); err != nil {
		return err
	}
	if prepareOnly {
		fmt.Println("Environment ready. No GPU worker or node connection started.")
		return nil
	}
	if _, err := os.Stat(a.configPath()); os.IsNotExist(err) {
		if err := a.initialize(from); err != nil {
			return err
		}
	}
	if err := a.checkConfiguredBackend(); err != nil {
		return err
	}
	if _, alive := a.liveHost(); alive {
		// A second click must not stop an existing node during a network outage.
		return a.startBackground(true)
	}
	fmt.Println("Starting GPU worker; waiting for warmup and a successful heartbeat. Stop.cmd can cancel.")
	if err := a.startBackground(true); err != nil {
		stopErr := a.stopHost()
		return errors.Join(err, stopErr)
	}
	return nil
}

func (a app) checkConfiguredBackend() error {
	var config struct {
		Engine struct {
			Backend string `json:"backend"`
		} `json:"engine"`
	}
	if err := readJSON(a.configPath(), &config); err != nil {
		return err
	}
	backend := config.Engine.Backend
	if backend == "" {
		backend = "cuda"
	}
	return a.checkPayload(backend)
}

// Stop owns the same operation lock until the background host is gone, so a
// cancelled first-run setup cannot subsequently start a worker behind Stop.cmd.
func (a app) cancelLaunch() (*os.File, error) {
	setup := filepath.Join(a.root, ".setup")
	until := time.Now().Add(15 * time.Second)
	for time.Now().Before(until) {
		lock, err := acquireLock(filepath.Join(setup, "launch.lock"))
		if err == nil {
			return lock, nil
		}
		var state hostState
		if readJSON(filepath.Join(setup, "launcher.json"), &state) == nil && state.PID > 0 && state.PID != os.Getpid() {
			exe, created, err := processIdentity(state.PID)
			if err == nil && created == state.Created && strings.EqualFold(exe, filepath.Join(a.root, "node.exe")) {
				if err := terminateOwnedProcess(state); err != nil {
					return nil, err
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, errors.New("could not cancel the active launcher; stop not confirmed")
}
