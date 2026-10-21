// Node Comics Node: native Windows lifecycle host for the bundled image engine.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"
)

var version = "0.1.0-dev"

type app struct{ root, home string }

func main() {
	if err := entry(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Node Comics:", err)
		os.Exit(1)
	}
}

func entry(args []string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Println(`Node Comics Node (Windows x64)
  node init [--from node.json]     Initialize this computer; credential input is hidden
  node start [--backend cuda|amd]  Prepare, initialize once and start (Start.cmd)
  node prepare --backend cuda|amd Download/verify the selected private environment only
  node doctor                    Verify release files, GPU, models and fonts offline
  node stop | status              Stop the node or inspect its connection
  node autostart enable|disable|status  Portable package: current-user logon startup
  node version

All commands accept --home PATH (default: data beside node.exe).
Copy the entire release folder; a new computer needs its own node credentials.
Stop before overwriting package files. Keep data, payload and .setup directories.
Logic-only updates reuse the installed environment and models.
Autostart is opt-in and runs after user sign-in, not before login.`)
		return nil
	}
	command := args[0]
	args = args[1:]
	action := ""
	if command == "autostart" {
		if len(args) == 0 {
			return fmt.Errorf("specify a %s action; use node help", command)
		}
		action, args = args[0], args[1:]
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	flags := flag.NewFlagSet("node "+command, flag.ContinueOnError)
	home := flags.String("home", filepath.Join(root, "data"), "private node data directory")
	from := flags.String("from", "", "import an existing private node configuration")
	backend := flags.String("backend", "", "portable backend: cuda or amd (chosen once)")
	if err = flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected arguments; use node help")
	}
	absolute, err := filepath.Abs(*home)
	if err != nil {
		return err
	}
	a := app{root: root, home: absolute}
	if err := a.validateHome(); err != nil {
		return err
	}
	switch command {
	case "version":
		fmt.Println("Node Comics Node", version)
		return nil
	case "init":
		return a.initialize(*from)
	case "start", "prepare":
		return a.launch(*from, *backend, command == "prepare", false)
	case "_autostart":
		return a.launchAtLogon()
	case "autostart":
		return a.autostart(action)
	case "doctor":
		finish, err := a.beginLaunch("checking")
		if err != nil {
			return err
		}
		defer finish()
		if err := a.checkConfiguredBackend(); err != nil {
			return err
		}
		lock, err := acquireLock(filepath.Join(a.home, "host.lock"))
		if err != nil {
			return errors.New("stop this node before running GPU diagnostics")
		}
		defer lock.Close()
		if err := a.verifyBundle(); err != nil {
			return err
		}
		cmd := a.worker("check")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := runContained(cmd, a.jobName("prepare")); err != nil {
			return errors.New("engine check failed; inspect data/startup-logs/node.log and model/font configuration")
		}
		return nil
	case "_host":
		return a.supervise()
	case "stop":
		return a.stop()
	case "status":
		status := a.status()
		startup, err := a.autostartStatus()
		if err != nil {
			status["autostart"] = map[string]string{"error": err.Error()}
		} else {
			status["autostart"] = startup
		}
		return printJSON(status)
	default:
		return errors.New("unknown command; use node help")
	}
}

func (a app) configPath() string { return filepath.Join(a.home, "node.json") }
func (a app) statePath() string  { return filepath.Join(a.home, "state") }
func (a app) worker(command string) *exec.Cmd {
	root := a.bundleRoot()
	cmd := exec.Command(filepath.Join(root, "runtime", "python.exe"), "-B", filepath.Join(a.root, "source/compute-node/run_node.py"), command, "--config", a.configPath(), "--bundle-root", root)
	cmd.Dir = a.root
	// The release _pth isolates imports; NODE_TOKEN must never override this
	// installation's private credential through a parent shell's environment.
	cmd.Env = localEnvironment(a.home)
	cmd.Err = localDirectories(a.home)
	return cmd
}

var localPaths = map[string]string{"TEMP": "tmp", "TMP": "tmp", "XDG_CACHE_HOME": "cache",
	"HF_HOME": "cache/huggingface", "TORCH_HOME": "cache/torch", "MPLCONFIGDIR": "cache/matplotlib",
	"YOLO_CONFIG_DIR": "cache/ultralytics", "CUDA_CACHE_PATH": "cache/cuda",
	"MIOPEN_USER_DB_PATH": "cache/miopen/db", "MIOPEN_CUSTOM_CACHE_DIR": "cache/miopen/kernels",
	"ROCFFT_RTC_CACHE_PATH": "cache/rocfft/kernels.db",
	"APPDATA":               "profile/roaming", "LOCALAPPDATA": "profile/local"}

func localDirectories(directory string) error {
	for key, relative := range localPaths {
		path := filepath.Join(directory, filepath.FromSlash(relative))
		// rocFFT takes a database filename; only the library creates/updates it.
		if key == "ROCFFT_RTC_CACHE_PATH" {
			path = filepath.Dir(path)
		}
		if err := os.MkdirAll(path, 0700); err != nil {
			return err
		}
	}
	return nil
}

func localEnvironment(directory string) []string {
	environment := []string{}
	for _, item := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(item, "=", 2)[0])
		_, overridden := localPaths[key]
		if !overridden && key != "NODE_TOKEN" && key != "VIRTUAL_ENV" && !strings.HasPrefix(key, "PYTHON") && !strings.HasPrefix(key, "UV_") && !strings.HasPrefix(key, "PIP_") {
			environment = append(environment, item)
		}
	}
	for key, relative := range localPaths {
		environment = append(environment, key+"="+filepath.Join(directory, filepath.FromSlash(relative)))
	}
	return append(environment, "PYTHONUTF8=1", "PYTHONDONTWRITEBYTECODE=1")
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err = os.WriteFile(temporary, append(data, '\n'), 0600); err != nil {
		return err
	}
	for attempt := 0; attempt < 5; attempt++ {
		err = os.Rename(temporary, path)
		if err == nil {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return err
}

func readJSON(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func prompt(reader *bufio.Reader, label string, secret bool) (string, error) {
	fmt.Print(label + ": ")
	if secret {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return "", errors.New("credential entry requires a terminal; use --from with a private config for automation")
		}
		data, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		return strings.TrimSpace(string(data)), err
	}
	value, err := reader.ReadString('\n')
	return strings.TrimSpace(value), err
}
