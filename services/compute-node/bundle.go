package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type releaseManifest struct {
	Version  string            `json:"version"`
	Platform string            `json:"platform"`
	Files    map[string]string `json:"files"`
	Fonts    []string          `json:"fonts"`
}

func (a app) manifest() (releaseManifest, error) {
	var manifest releaseManifest
	err := readJSON(filepath.Join(a.root, "release.json"), &manifest)
	if err == nil && (manifest.Platform != "windows-amd64" || len(manifest.Files) == 0 || len(manifest.Fonts) == 0) {
		err = errors.New("invalid Windows release manifest")
	}
	return manifest, err
}

func safePath(root, relative string) (string, error) {
	name := filepath.FromSlash(relative)
	if filepath.IsAbs(name) || filepath.VolumeName(name) != "" {
		return "", errors.New("absolute release path rejected")
	}
	clean := filepath.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == "." {
		return "", errors.New("release path escapes bundle")
	}
	path := filepath.Join(root, clean)
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("release link escapes bundle")
	}
	return path, nil
}

func (a app) verifyBundle() error {
	m, err := a.manifest()
	if err != nil {
		return err
	}
	for relative, expected := range m.Files {
		path, err := safePath(a.root, relative)
		if err != nil {
			return fmt.Errorf("invalid release file %q", relative)
		}
		file, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("missing release file %q", relative)
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		file.Close()
		if copyErr != nil || len(expected) != 64 || hex.EncodeToString(hash.Sum(nil)) != expected {
			return fmt.Errorf("release checksum mismatch: %q", relative)
		}
	}
	for _, required := range append([]string{"node.exe", "runtime/python.exe", "engine/classic_node/__main__.py"}, m.Fonts...) {
		if _, ok := m.Files[required]; !ok {
			return fmt.Errorf("unlisted required file %q", required)
		}
	}
	return nil
}

func validOrigin(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Path == "" || u.Path == "/")
}

func (a app) initialize(from string) error {
	if err := a.validateHome(); err != nil {
		return err
	}
	if _, err := os.Stat(a.configPath()); !os.IsNotExist(err) {
		return errors.New("node configuration already exists; initialization never overwrites identity")
	}
	if entries, err := os.ReadDir(a.home); err == nil && len(entries) != 0 {
		return errors.New("initialization requires an empty dedicated data directory; existing files and permissions are preserved")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	m, err := a.manifest()
	if err != nil {
		return err
	}
	config := map[string]any{}
	if from != "" {
		if err = readJSON(from, &config); err != nil {
			return errors.New("cannot read private configuration")
		}
	} else {
		reader := bufio.NewReader(os.Stdin)
		for _, field := range []struct{ key, label string }{
			{"control_url", "Controller HTTPS origin"}, {"r2_origin", "R2 HTTPS origin"},
			{"node_id", "Node ID from administrator"}, {"resource_id", "Resource ID from administrator"}, {"node_token", "Node credential"},
		} {
			value, err := prompt(reader, field.label, field.key == "node_token")
			if err != nil {
				return err
			}
			config[field.key] = value
		}
	}
	for _, field := range []string{"control_url", "r2_origin", "node_id", "resource_id", "node_token"} {
		value, ok := config[field].(string)
		if !ok || strings.TrimSpace(value) == "" {
			return fmt.Errorf("configuration requires %s", field)
		}
		if (field == "control_url" || field == "r2_origin") && !validOrigin(value) {
			return fmt.Errorf("%s must be an HTTPS origin", field)
		}
	}
	if err = os.MkdirAll(a.home, 0700); err != nil {
		return err
	}
	if err = protectDirectory(a.home, false); err != nil {
		return err
	}
	config["protocol_version"], config["state_dir"] = 2, "state"
	engine, _ := config["engine"].(map[string]any)
	if engine == nil {
		engine = map[string]any{}
	}
	// Release assets are resolved by the host at runtime, independently of where
	// the operator keeps private data. Never retain paths from the source PC.
	delete(engine, "models")
	delete(engine, "font")
	for _, font := range m.Fonts {
		_, err := safePath(a.root, font)
		if err != nil {
			return err
		}
	}
	config["engine"] = engine
	if ca, ok := config["control_ca"].(string); ok && ca != "" {
		if !filepath.IsAbs(ca) {
			ca = filepath.Join(filepath.Dir(from), ca)
		}
		data, err := os.ReadFile(ca)
		if err != nil {
			return errors.New("cannot copy private controller CA")
		}
		if err = os.WriteFile(filepath.Join(a.home, "control-ca.pem"), data, 0600); err != nil {
			return err
		}
		config["control_ca"] = "control-ca.pem"
	}
	if err = a.bind(); err != nil {
		return err
	}
	if err = writeJSON(a.configPath(), config); err != nil {
		return err
	}
	fmt.Println("Initialized private node data. Run 'node doctor' before starting. Imported identity must not be running on another computer.")
	return nil
}

func (a app) validateHome() error {
	// Never give data/Modify permission to program files or an ancestor such as
	// a drive root. Only data/ may be initialized inside a release directory.
	rel, err := filepath.Rel(a.home, a.root)
	if err != nil {
		if !strings.EqualFold(filepath.VolumeName(a.home), filepath.VolumeName(a.root)) {
			return nil // Separate volumes cannot be ancestors.
		}
		return err
	}
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
		return errors.New("private data must not be the release directory or one of its ancestors")
	}
	rel, err = filepath.Rel(a.root, a.home)
	if err != nil {
		return err
	}
	if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !strings.EqualFold(rel, "data") && !strings.HasPrefix(strings.ToLower(rel), "data"+string(filepath.Separator)) {
		return errors.New("inside a release, private data must be under data; otherwise choose an external directory")
	}
	return nil
}

func (a app) checkBinding() error {
	var identity struct {
		Machine string `json:"machine"`
	}
	if err := readJSON(filepath.Join(a.home, "instance.json"), &identity); err != nil {
		return errors.New("node is not initialized; run node init")
	}
	machine, err := machineID()
	if err != nil {
		return err
	}
	if identity.Machine != machine {
		return errors.New("this data belongs to another computer; stop the old host, then use node adopt or initialize a new node")
	}
	return nil
}

func (a app) bind() error {
	machine, err := machineID()
	if err != nil {
		return err
	}
	return writeJSON(filepath.Join(a.home, "instance.json"), map[string]string{"machine": machine})
}

func (a app) adopt() error {
	lock, err := acquireLock(filepath.Join(a.home, "host.lock"))
	if err != nil {
		return errors.New("stop the current node before adopting")
	}
	defer lock.Close()
	// Moving unfinished leases to a different physical GPU is intentionally not
	// implicit. Leave the recovery data intact for the original host to finish.
	cmd := a.worker("pending")
	if err := cmd.Run(); err != nil {
		return errors.New("adoption requires an empty, unlocked journal; finish pending work on the old host")
	}
	if err := protectDirectory(a.home, false); err != nil {
		return err
	}
	if err := a.bind(); err != nil {
		return err
	}
	fmt.Println("Bound to this computer. The previous host must stay stopped. Run node doctor and reinstall the service at the new path.")
	return nil
}
