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
  node doctor                    Verify release files, GPU, models and fonts offline
  node run                       Run the supervised node in this console
  node start | stop | status      Manage a background node in the current session
  node service install           Install a native automatic Windows service (Administrator)
  node service start|stop|status|remove
  node adopt                     Bind a moved, stopped, empty node to this computer
  node version

All commands accept --home PATH (default: data beside node.exe).
Copy the entire release folder; a new computer needs its own node credentials.
Stop/remove the old service before moving an existing node; then use adopt.
Background start is session-only. Install the service for unattended boot startup.`)
		return nil
	}
	command := args[0]
	args = args[1:]
	serviceAction := ""
	if command == "service" {
		if len(args) == 0 {
			return errors.New("specify service install, start, stop, status or remove")
		}
		serviceAction, args = args[0], args[1:]
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	flags := flag.NewFlagSet("node "+command, flag.ContinueOnError)
	home := flags.String("home", filepath.Join(root, "data"), "private node data directory")
	from := flags.String("from", "", "import an existing private node configuration")
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
	case "adopt":
		return a.adopt()
	case "doctor":
		if err := a.checkBinding(); err != nil {
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
		if err := cmd.Run(); err != nil {
			return errors.New("engine check failed; inspect data/startup-logs/node.log and model/font configuration")
		}
		return nil
	case "run", "_host":
		return a.supervise(command == "run")
	case "start":
		return a.start()
	case "stop":
		return a.stop()
	case "status":
		return printJSON(a.status())
	case "service":
		return a.service(serviceAction)
	case "_service":
		return a.serve()
	default:
		return errors.New("unknown command; use node help")
	}
}

func (a app) configPath() string { return filepath.Join(a.home, "node.json") }
func (a app) statePath() string  { return filepath.Join(a.home, "state") }
func (a app) worker(command string) *exec.Cmd {
	cmd := exec.Command(filepath.Join(a.root, "runtime", "python.exe"), "-B", "-m", "classic_node", command, "--config", a.configPath(), "--bundle-root", a.root)
	cmd.Dir = filepath.Join(a.root, "engine")
	// The release _pth isolates imports; NODE_TOKEN must never override this
	// installation's private credential through a parent shell's environment.
	for _, item := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(item, "=", 2)[0])
		if key != "NODE_TOKEN" && key != "PYTHONPATH" && key != "PYTHONHOME" {
			cmd.Env = append(cmd.Env, item)
		}
	}
	return cmd
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
