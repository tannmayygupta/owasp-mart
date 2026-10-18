package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/corazawaf/coraza/v3"
)

func newTestWAF(t *testing.T) coraza.WAF {
	t.Helper()
	w, err := NewWAF(1)
	if err != nil {
		t.Fatalf("NewWAF: %v", err)
	}
	return w
}

func TestSQLiIsReportedWithTag(t *testing.T) {
	in := newTestWAF(t)
	a, err := Inspect(in, Request{Method: "GET", URI: "/api/products/search?q=%27%20UNION%20SELECT%201,2,3,4--", Headers: map[string]string{"host": "shop", "user-agent": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(a.RuleIDs) == 0 || a.AnomalyScore <= 0 {
		t.Fatalf("expected a match with a score, got %+v", a)
	}
	if !contains(a.Tags, "attack-sqli") {
		t.Fatalf("expected tag attack-sqli, got %v", a.Tags)
	}
}

func TestBenignIsQuiet(t *testing.T) {
	in := newTestWAF(t)
	a, err := Inspect(in, Request{Method: "GET", URI: "/api/products/search?q=blue+lamp", Headers: map[string]string{"host": "shop", "user-agent": "Mozilla/5.0", "accept": "text/html"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(a.RuleIDs) != 0 || a.AnomalyScore != 0 {
		t.Fatalf("benign request matched: %+v", a)
	}
}

// Detect only: a request far above the blocking threshold is never interrupted, and the answer type has no action field.
func TestDetectOnlyNeverInterrupts(t *testing.T) {
	w, err := NewWAF(1)
	if err != nil {
		t.Fatal(err)
	}
	tx := w.NewTransaction()
	defer tx.Close()
	tx.ProcessConnection("127.0.0.1", 0, "127.0.0.1", 0)
	tx.ProcessURI("/x?a=%27%20OR%201=1--&b=%3Cscript%3Ealert(1)%3C/script%3E&c=../../etc/passwd&d=;cat%20/etc/passwd", "GET", "HTTP/1.1")
	tx.AddRequestHeader("user-agent", "sqlmap/1.0")
	tx.ProcessRequestHeaders()
	if _, err := tx.ProcessRequestBody(); err != nil {
		t.Fatal(err)
	}
	if it := tx.Interruption(); it != nil { // test only: the helper itself never reads it
		t.Fatalf("detection-only WAF interrupted the request: %+v", it)
	}
	if intVar(tx, "blocking_inbound_anomaly_score") < 5 {
		t.Fatal("test request should be above the CRS blocking threshold (5)")
	}
	b, _ := json.Marshal(Answer{})
	for _, bad := range []string{"action", "status", "interrupt", "deny", "block"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("answer has a %q field: %s", bad, b)
		}
	}
}

func TestBigBodyOnlyFirst8KiBInspected(t *testing.T) {
	in := newTestWAF(t)
	filler := strings.Repeat("a", 9000)
	h := map[string]string{"host": "shop", "content-type": "text/plain", "user-agent": "x"}
	// attack after the cap: not inspected
	a, err := Inspect(in, Request{Method: "POST", URI: "/api/x", Headers: h, Body: filler + "' UNION SELECT 1,2,3--"})
	if err != nil {
		t.Fatal(err)
	}
	if contains(a.Tags, "attack-sqli") {
		t.Fatalf("attack past 8 KiB should not be inspected: %+v", a)
	}
	// attack inside the cap: inspected
	b, err := Inspect(in, Request{Method: "POST", URI: "/api/x", Headers: h, Body: "' UNION SELECT 1,2,3--" + filler})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(b.Tags, "attack-sqli") {
		t.Fatal("attack inside the first 8 KiB must be seen")
	}
}

// The shop's own methods (PUT, PATCH, DELETE) are not an attack: the CRS default method list is widened in directives.conf.
func TestShopMethodsAreNotFlagged(t *testing.T) {
	in := newTestWAF(t)
	for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"} {
		h := map[string]string{"host": "shop", "user-agent": "Mozilla/5.0", "accept": "application/json"}
		if m == "POST" || m == "PUT" || m == "PATCH" {
			h["content-length"] = "0" // a real client sends it; without it rule 920180 flags the request
		}
		a, err := Inspect(in, Request{Method: m, URI: "/api/cart/items/LMP-0042", Headers: h})
		if err != nil {
			t.Fatal(err)
		}
		if len(a.RuleIDs) != 0 {
			t.Fatalf("%s matched: %+v", m, a)
		}
	}
	a, err := Inspect(in, Request{Method: "TRACE", URI: "/x", Headers: map[string]string{"host": "shop", "user-agent": "Mozilla/5.0", "accept": "*/*"}})
	if err != nil || len(a.RuleIDs) == 0 {
		t.Fatalf("TRACE should still be flagged: %+v %v", a, err)
	}
}

func TestJSONBodyIsInspected(t *testing.T) {
	in := newTestWAF(t)
	a, err := Inspect(in, Request{Method: "POST", URI: "/api/search", Headers: map[string]string{"host": "shop", "content-type": "application/json", "user-agent": "x"}, Body: `{"q":"1' UNION SELECT username,password FROM users--"}`})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(a.Tags, "attack-sqli") {
		t.Fatalf("JSON body SQLi not seen: %+v", a)
	}
}

func TestHandlerAndCounters(t *testing.T) {
	w, err := NewWAF(1)
	if err != nil {
		t.Fatal(err)
	}
	c := &counters{}
	srv := httptest.NewServer(handler(w, c))
	defer srv.Close()
	body, _ := json.Marshal(Request{Method: "GET", URI: "/s?q=%27%20UNION%20SELECT%201--", Headers: map[string]string{"host": "shop"}})
	resp, err := http.Post(srv.URL+"/inspect", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var a Answer
	if err := json.NewDecoder(resp.Body).Decode(&a); err != nil || resp.StatusCode != 200 || len(a.RuleIDs) == 0 {
		t.Fatalf("status %d err %v answer %+v", resp.StatusCode, err, a)
	}
	bad, _ := http.Post(srv.URL+"/inspect", "application/json", strings.NewReader("{not json"))
	bad.Body.Close()
	if bad.StatusCode != 400 {
		t.Fatalf("bad document status %d", bad.StatusCode)
	}
	if c.requests.Load() != 2 || c.matches.Load() != 1 || c.errors.Load() != 1 {
		t.Fatalf("counters %d %d %d", c.requests.Load(), c.matches.Load(), c.errors.Load())
	}
	g, _ := http.Get(srv.URL + "/healthz")
	g.Body.Close()
	if g.StatusCode != 200 {
		t.Fatal("healthz")
	}
}

func TestLoopbackOnly(t *testing.T) {
	for _, ok := range []string{"127.0.0.1:9100", "[::1]:9100"} {
		if err := loopbackOnly(ok); err != nil {
			t.Fatalf("%s should be allowed: %v", ok, err)
		}
	}
	for _, bad := range []string{"0.0.0.0:9100", ":9100", "10.0.0.5:9100", "example.com:80"} {
		if loopbackOnly(bad) == nil {
			t.Fatalf("%s must be refused", bad)
		}
	}
}

func TestParanoiaRange(t *testing.T) {
	if _, err := Directives(0); err == nil {
		t.Fatal("0 must be refused")
	}
	if _, err := Directives(5); err == nil {
		t.Fatal("5 must be refused")
	}
	d, _ := Directives(1)
	if strings.Contains(d, "{{") {
		t.Fatal("placeholder left")
	}
}

// The repository never turns the engine on: only DetectionOnly appears, and no blocking action is in this helper's own directives.
func TestNoEngineOnAnywhere(t *testing.T) {
	err := filepath.Walk(".", func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || strings.HasSuffix(p, "_test.go") {
			return err
		}
		b, _ := os.ReadFile(p)
		s := string(b)
		if strings.Contains(s, "SecRuleEngine On") {
			t.Errorf("%s turns the engine on", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := Directives(1)
	if !strings.HasPrefix(strings.TrimSpace(strings.SplitN(d, "SecRuleEngine", 2)[1]), "DetectionOnly") {
		t.Fatal("first SecRuleEngine is not DetectionOnly")
	}
	if strings.Count(d, "SecRuleEngine") != 1 {
		t.Fatal("exactly one SecRuleEngine directive expected")
	}
	for _, act := range []string{"deny", "drop", "redirect", "block"} {
		for _, line := range strings.Split(d, "\n") {
			if strings.HasPrefix(line, "SecRule") && strings.Contains(line, ","+act) {
				t.Fatalf("own directive uses %s: %s", act, line)
			}
		}
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}
