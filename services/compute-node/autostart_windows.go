package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

type autostartState struct {
	Registered bool   `json:"registered"`
	Trigger    string `json:"trigger"`
	Shortcut   string `json:"shortcut"`
}

func encodePowerShell(script string) string {
	words := utf16.Encode([]rune(script))
	data := make([]byte, len(words)*2)
	for i, word := range words {
		binary.LittleEndian.PutUint16(data[i*2:], word)
	}
	return base64.StdEncoding.EncodeToString(data)
}

func (a app) autostartName() string {
	hash := sha256.Sum256([]byte(strings.ToLower(a.root + "\n" + a.home)))
	return "NodeComics-" + hex.EncodeToString(hash[:16]) + ".lnk"
}

func (a app) autostart(action string) error {
	if action != "enable" && action != "disable" && action != "status" {
		return errors.New("specify autostart enable, disable or status")
	}
	if action == "enable" {
		if err := a.checkConfiguredBackend(); err != nil {
			return err
		}
		if err := a.verifySeed(); err != nil {
			return err
		}
	}
	directory, err := windows.KnownFolderPath(windows.FOLDERID_Startup, 0)
	if err != nil {
		return err
	}
	state, err := a.manageAutostart(directory, action)
	if err != nil {
		return err
	}
	return printJSON(state)
}

func (a app) autostartStatus() (autostartState, error) {
	directory, err := windows.KnownFolderPath(windows.FOLDERID_Startup, 0)
	if err != nil {
		return autostartState{}, err
	}
	return a.manageAutostart(directory, "status")
}

// The sole out-of-package file is this user's Startup shortcut. Use Windows'
// known folder, not redirected worker APPDATA. Never overwrite/remove another
// installation's link. The directory argument lets tests use a private folder.
func (a app) manageAutostart(directory, action string) (autostartState, error) {
	state := autostartState{Trigger: "current-user-logon", Shortcut: filepath.Join(directory, a.autostartName())}
	if action != "enable" && action != "disable" && action != "status" {
		return state, errors.New("invalid autostart action")
	}
	if action != "status" {
		lock, err := acquireLock(filepath.Join(a.root, ".setup", a.autostartName()+".lock"))
		if err != nil {
			return state, errors.New("another autostart change is in progress")
		}
		defer lock.Close()
	}
	if _, err := os.Lstat(state.Shortcut); os.IsNotExist(err) && action != "enable" {
		return state, nil
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	// WSH truncates long shortcut arguments. The shortcut already binds its
	// working directory to the bundle, so don't repeat the full root/home paths.
	homeArgument := a.home
	if relative, err := filepath.Rel(a.root, a.home); err == nil && len(relative) < len(homeArgument) {
		homeArgument = relative
	}
	script := "& '.\\node.exe' _autostart --home " + quote(homeArgument) + "; exit $LASTEXITCODE"
	args := "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encodePowerShell(script)
	if len(utf16.Encode([]rune(args))) > 1023 {
		return state, errors.New("autostart command exceeds Windows shortcut limits; choose a shorter data path")
	}
	request, err := json.Marshal(map[string]string{
		"action": action, "shortcut": state.Shortcut, "target": powershell, "arguments": args,
		"directory": a.root, "description": "Node Comics current-user logon startup v1",
	})
	if err != nil {
		return state, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(shortcutScript))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	cmd.Stdin = bytes.NewReader(request)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return state, fmt.Errorf("autostart shortcut operation failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if err := json.Unmarshal(bytes.TrimPrefix(output, []byte{0xef, 0xbb, 0xbf}), &state); err != nil {
		return state, fmt.Errorf("invalid autostart shortcut result: %w", err)
	}
	return state, nil
}

const shortcutScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Test-OwnedShortcut($link) {
    return ($link.TargetPath -ieq $request.target -and $link.Arguments -ceq $request.arguments -and
        $link.WorkingDirectory -ieq $request.directory -and $link.Description -ceq $request.description)
}
$exists = Test-Path -LiteralPath $request.shortcut
$shell = New-Object -ComObject WScript.Shell
if ($exists) {
    $item = Get-Item -LiteralPath $request.shortcut -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Startup shortcut is not a regular file; left unchanged.'
    }
    $link = $shell.CreateShortcut($request.shortcut)
    if (-not (Test-OwnedShortcut $link)) {
        throw 'Startup shortcut belongs to another configuration; left unchanged.'
    }
}
if ($request.action -eq 'enable' -and -not $exists) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($request.shortcut)) | Out-Null
    $link = $shell.CreateShortcut($request.shortcut)
    $link.TargetPath = $request.target
    $link.Arguments = $request.arguments
    $link.WorkingDirectory = $request.directory
    $link.Description = $request.description
    $link.WindowStyle = 7
    $link.Save()
    $exists = Test-Path -LiteralPath $request.shortcut
    if (-not $exists) { throw 'Startup shortcut was not created.' }
    if (-not (Test-OwnedShortcut ($shell.CreateShortcut($request.shortcut)))) {
        Remove-Item -LiteralPath $request.shortcut -Force
        throw 'Windows did not preserve shortcut parameters; use a shorter package/data path.'
    }
} elseif ($request.action -eq 'disable' -and $exists) {
    Remove-Item -LiteralPath $request.shortcut -Force
    $exists = $false
}
@{registered=$exists; trigger='current-user-logon'; shortcut=$request.shortcut} | ConvertTo-Json -Compress
`

func (a app) launchAtLogon() error {
	// Don't create private state before initialization, or expose credentials in
	// a shortcut / command line. Background failures stay beside the node data.
	if _, err := os.Stat(a.configPath()); err != nil {
		return errors.New("complete Start.cmd initialization before enabling autostart")
	}
	if err := os.MkdirAll(filepath.Join(a.home, "logs"), 0700); err != nil {
		return err
	}
	logger := log.New(rotatingLog{filepath.Join(a.home, "logs", "autostart.log")}, "", log.Ldate|log.Ltime|log.LUTC)
	err := a.launch("", "", false, true)
	if err != nil {
		logger.Printf("event=logon_start_failed error=%q", err)
		return err
	}
	logger.Printf("event=logon_start_requested")
	return nil
}
