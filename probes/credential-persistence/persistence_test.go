package store

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	auth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

type probeS3 struct {
	t            *testing.T
	mu           sync.Mutex
	objects      map[string][]byte
	rejectWrites bool
	puts         int
	server       *httptest.Server
}

func newProbeS3(t *testing.T) *probeS3 {
	t.Helper()
	s := &probeS3{t: t, objects: make(map[string][]byte)}
	s.server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.server.Close)
	return s
}

func (s *probeS3) failWrites(fail bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rejectWrites = fail
}

func (s *probeS3) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.TrimPrefix(r.URL.Path, "/probe/")
	if r.Method == http.MethodPut {
		s.puts++
	}
	if s.rejectWrites && (r.Method == http.MethodPut || r.Method == http.MethodDelete) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `<Error><Code>AccessDenied</Code><Message>Injected write failure</Message></Error>`)
		return
	}
	if r.URL.Query().Has("list-type") {
		type object struct {
			Key  string
			Size int
		}
		result := struct {
			XMLName     xml.Name `xml:"ListBucketResult"`
			Name        string
			IsTruncated bool
			Contents    []object
		}{Name: "probe"}
		for name, data := range s.objects {
			if strings.HasPrefix(name, r.URL.Query().Get("prefix")) {
				result.Contents = append(result.Contents, object{Key: name, Size: len(data)})
			}
		}
		w.Header().Set("Content-Type", "application/xml")
		if err := xml.NewEncoder(w).Encode(result); err != nil {
			s.t.Error(err)
		}
		return
	}
	switch r.Method {
	case http.MethodPut:
		var body io.Reader = r.Body
		if r.Header.Get("X-Amz-Content-Sha256") == "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" {
			body = httputil.NewChunkedReader(r.Body)
		}
		data, err := io.ReadAll(body)
		if err != nil {
			s.t.Error(err)
			http.Error(w, "body read failed", 500)
			return
		}
		s.objects[key] = data
		w.Header().Set("ETag", `"probe"`)
	case http.MethodDelete:
		delete(s.objects, key)
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		data, ok := s.objects[key]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.Header().Set("Last-Modified", "Sat, 19 Sep 2026 00:00:00 GMT")
		fmt.Fprint(w, string(data))
	default:
		s.t.Errorf("unexpected S3 request: %s %s", r.Method, r.URL)
		http.Error(w, "Unexpected S3 request", http.StatusBadRequest)
	}
}

func (s *probeS3) store(t *testing.T) *ObjectTokenStore {
	t.Helper()
	store, err := NewObjectTokenStore(ObjectStoreConfig{
		Endpoint: strings.TrimPrefix(s.server.URL, "http://"), Bucket: "probe",
		AccessKey: "synthetic-key", SecretKey: "synthetic-secret", Region: "auto",
		PathStyle: true, LocalRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func credential(token string) *auth.Auth {
	return &auth.Auth{ID: "claude.json", FileName: "claude.json", Provider: "claude",
		Metadata: map[string]any{"type": "claude", "refresh_token": token}}
}

func saveProbe(t *testing.T, store *ObjectTokenStore, token string) {
	t.Helper()
	if _, err := store.Save(context.Background(), credential(token)); err != nil {
		t.Fatal(err)
	}
}

func restoredToken(t *testing.T, s *probeS3) string {
	t.Helper()
	fresh := s.store(t)
	// Execute CPA's startup auth download with a fresh disk, without config bootstrapping.
	if err := fresh.syncAuthFromBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(fresh.AuthDir(), "claude.json"))
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(data, &metadata); err != nil {
		t.Fatal(err)
	}
	return metadata.RefreshToken
}

func TestProxyProbeSuccessfulLifecycle(t *testing.T) {
	s := newProbeS3(t)
	store := s.store(t)
	for _, token := range []string{"initial", "rotated", "replacement"} {
		saveProbe(t, store, token)
		if got := restoredToken(t, s); got != token {
			t.Fatalf("got %q, want %q", got, token)
		}
	}
	if err := store.Delete(context.Background(), "claude.json"); err != nil {
		t.Fatal(err)
	}
	if got := restoredToken(t, s); got != "" {
		t.Fatalf("deleted credential restored: %q", got)
	}
}

func TestProxyProbeFailedUploadAndIdenticalRetryLoseRotation(t *testing.T) {
	s := newProbeS3(t)
	store := s.store(t)
	saveProbe(t, store, "old")
	s.failWrites(true)
	if _, err := store.Save(context.Background(), credential("new")); err == nil {
		t.Fatal("expected failed upload")
	}
	s.failWrites(false)
	s.mu.Lock()
	before := s.puts
	s.mu.Unlock()
	saveProbe(t, store, "new")
	s.mu.Lock()
	after := s.puts
	s.mu.Unlock()
	if after != before {
		t.Fatal("retry unexpectedly uploaded; revisit defect")
	}
	if got := restoredToken(t, s); got != "old" {
		t.Fatalf("expected reproduced stale token, got %q", got)
	}
	t.Log("REPRODUCED: identical save reports success, but fresh disk restores old token")
}

func TestProxyProbeManagerDiscardsRefreshPersistenceError(t *testing.T) {
	s := newProbeS3(t)
	store := s.store(t)
	m := auth.NewManager(store, nil, nil)
	base, err := m.Register(context.Background(), credential("old"))
	if err != nil {
		t.Fatal(err)
	}
	s.failWrites(true)
	updated := base.Clone()
	updated.Metadata["refresh_token"] = "new"
	saved, err := m.UpdateRefreshedAuth(context.Background(), base, updated)
	if err != nil {
		t.Fatalf("manager now propagates failure; revisit defect: %v", err)
	}
	if saved.Metadata["refresh_token"] != "new" {
		t.Fatal("new token was not installed")
	}
	s.failWrites(false)
	if got := restoredToken(t, s); got != "old" {
		t.Fatalf("expected stale remote token, got %q", got)
	}
	t.Log("REPRODUCED: manager reports refresh success despite failed durability")
}

func TestProxyProbeExplicitPersistCanRepairWhileDiskSurvives(t *testing.T) {
	s := newProbeS3(t)
	store := s.store(t)
	saveProbe(t, store, "old")
	s.failWrites(true)
	if _, err := store.Save(context.Background(), credential("new")); err == nil {
		t.Fatal("expected failed upload")
	}
	path := filepath.Join(store.AuthDir(), "claude.json")
	if err := store.PersistAuthFiles(context.Background(), "probe", path); err == nil {
		t.Fatal("expected watcher-style persist failure")
	}
	s.failWrites(false)
	if err := store.PersistAuthFiles(context.Background(), "probe", path); err != nil {
		t.Fatal(err)
	}
	if got := restoredToken(t, s); got != "new" {
		t.Fatalf("repair restored %q", got)
	}
}

func TestProxyProbeFailedDeleteResurrectsOnFreshDisk(t *testing.T) {
	s := newProbeS3(t)
	store := s.store(t)
	saveProbe(t, store, "old")
	s.failWrites(true)
	if err := store.Delete(context.Background(), "claude.json"); err == nil {
		t.Fatal("expected delete failure")
	}
	s.failWrites(false)
	if got := restoredToken(t, s); got != "old" {
		t.Fatalf("expected resurrection, got %q", got)
	}
	if err := store.Delete(context.Background(), "claude.json"); err != nil {
		t.Fatal(err)
	}
	if got := restoredToken(t, s); got != "" {
		t.Fatalf("retry did not delete: %q", got)
	}
	t.Log("REPRODUCED: failed delete restores credential; explicit delete retry repairs it")
}

func TestProxyProbeStaleWriterOverwritesNewCredential(t *testing.T) {
	s := newProbeS3(t)
	first, second := s.store(t), s.store(t)
	saveProbe(t, first, "initial")
	if err := second.syncAuthFromBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
	saveProbe(t, first, "newer")
	saveProbe(t, second, "stale-writer")
	if got := restoredToken(t, s); got != "stale-writer" {
		t.Fatalf("expected last writer wins, got %q", got)
	}
	t.Log("REPRODUCED: independent stores have no fencing against stale writers")
}
