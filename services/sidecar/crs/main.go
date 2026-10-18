// crs-detect: a small helper of the VulnMart sidecar (story 6.5, D-70). It embeds Coraza v3 and the OWASP Core Rule Set in DETECTION-ONLY
// mode and answers one question: which rules match this request? It listens on loopback only, never evaluates a response, never makes an
// outbound call, never logs request data (counters only), and its answer carries no action: the sidecar never blocks on it.
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/corazawaf/coraza-coreruleset/v4"
	"github.com/corazawaf/coraza/v3"
	"github.com/corazawaf/coraza/v3/experimental/plugins/plugintypes"
	"github.com/corazawaf/coraza/v3/types"
	"github.com/jcchavezs/mergefs"
	mio "github.com/jcchavezs/mergefs/io"
)

//go:embed directives.conf
var directivesTemplate string

const (
	bodyCap      = 8192      // request body bytes inspected (SecRequestBodyLimit)
	requestCap   = 64 * 1024 // largest /inspect request document accepted
	maxRuleIDs   = 200
	maxTags      = 200
	minCRSRuleID = 900000 // ids below are this helper's own body-processor rules
)

// Request is the one question the sidecar asks.
type Request struct {
	Method  string            `json:"method"`
	URI     string            `json:"uri"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// Answer carries matches only. There is deliberately no action, status or interruption field.
type Answer struct {
	RuleIDs      []string `json:"rule_ids"`
	Tags         []string `json:"tags"`
	AnomalyScore int      `json:"anomaly_score"`
}

// Directives returns the Coraza directives for a paranoia level 1..4.
func Directives(paranoia int) (string, error) {
	if paranoia < 1 || paranoia > 4 {
		return "", errors.New("paranoia level must be 1 to 4")
	}
	return strings.ReplaceAll(directivesTemplate, "{{PARANOIA}}", strconv.Itoa(paranoia)), nil
}

// NewWAF builds the detection-only WAF with the embedded Core Rule Set.
func NewWAF(paranoia int) (coraza.WAF, error) {
	d, err := Directives(paranoia)
	if err != nil {
		return nil, err
	}
	cfg := coraza.NewWAFConfig().
		WithDirectives(d).
		WithRootFS(mergefs.Merge(coreruleset.FS, mio.OSFS)).
		WithErrorCallback(func(types.MatchedRule) {}) // no rule text or request data goes to any log
	return coraza.NewWAF(cfg)
}

func intVar(tx types.Transaction, name string) int {
	ts, ok := tx.(plugintypes.TransactionState)
	if !ok {
		return 0
	}
	vals := ts.Variables().TX().Get(name)
	if len(vals) == 0 {
		return 0
	}
	n, err := strconv.Atoi(vals[0])
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// Inspect runs the request phases for one request and returns the matches. It never reads tx.Interruption() and never alters anything.
func Inspect(waf coraza.WAF, r Request) (Answer, error) {
	tx := waf.NewTransaction()
	defer func() { tx.ProcessLogging(); _ = tx.Close() }()
	method := strings.ToUpper(strings.TrimSpace(r.Method))
	if method == "" || r.URI == "" {
		return Answer{}, errors.New("method and uri are required")
	}
	tx.ProcessConnection("127.0.0.1", 0, "127.0.0.1", 0)
	tx.ProcessURI(r.URI, method, "HTTP/1.1")
	for k, v := range r.Headers {
		tx.AddRequestHeader(k, v)
	}
	if host, ok := r.Headers["host"]; ok {
		tx.SetServerName(host)
	}
	tx.ProcessRequestHeaders()
	body := r.Body
	if len(body) > bodyCap {
		body = body[:bodyCap]
	}
	if _, _, err := tx.WriteRequestBody([]byte(body)); err != nil {
		return Answer{}, err
	}
	if _, err := tx.ProcessRequestBody(); err != nil {
		return Answer{}, err
	}

	ids := []string{}
	tagSet := map[string]bool{}
	for _, m := range tx.MatchedRules() {
		rule := m.Rule()
		id := rule.ID()
		if id < minCRSRuleID || !hasAttackTag(rule.Tags()) {
			continue
		}
		if len(ids) < maxRuleIDs {
			ids = append(ids, strconv.Itoa(id))
		}
		for _, t := range rule.Tags() {
			tagSet[t] = true
		}
	}
	tags := make([]string, 0, len(tagSet))
	for t := range tagSet {
		tags = append(tags, t)
	}
	sort.Strings(tags)
	if len(tags) > maxTags {
		tags = tags[:maxTags]
	}
	score := intVar(tx, "blocking_inbound_anomaly_score")
	if score == 0 {
		score = intVar(tx, "inbound_anomaly_score")
	}
	return Answer{RuleIDs: ids, Tags: tags, AnomalyScore: score}, nil
}

type counters struct{ requests, matches, errors, inflight atomic.Int64 }

func handler(waf coraza.WAF, c *counters) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","requests":%d,"matches":%d,"errors":%d,"inflight":%d}`, c.requests.Load(), c.matches.Load(), c.errors.Load(), c.inflight.Load())
	})
	mux.HandleFunc("/inspect", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		c.requests.Add(1)
		c.inflight.Add(1)
		defer c.inflight.Add(-1)
		var req Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, requestCap))
		if err := dec.Decode(&req); err != nil {
			c.errors.Add(1)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		ans, err := Inspect(waf, req)
		if err != nil {
			c.errors.Add(1)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if len(ans.RuleIDs) > 0 {
			c.matches.Add(1)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(ans)
	})
	return mux
}

// loopbackOnly refuses any listen address that is not a loopback IP.
func loopbackOnly(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("listen address must be a loopback IP")
	}
	return nil
}

func main() {
	listen := flag.String("listen", "127.0.0.1:9100", "loopback address to listen on")
	paranoia := flag.Int("paranoia", 1, "CRS paranoia level 1 to 4")
	flag.Parse()
	if err := loopbackOnly(*listen); err != nil {
		fmt.Fprintln(os.Stderr, "crs-detect:", err)
		os.Exit(2)
	}
	waf, err := NewWAF(*paranoia)
	if err != nil {
		fmt.Fprintln(os.Stderr, "crs-detect: cannot load rules:", err)
		os.Exit(2)
	}
	srv := &http.Server{
		Addr:              *listen,
		Handler:           handler(waf, &counters{}),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
	}
	log.SetFlags(0)
	log.Printf("crs-detect: listening on %s, paranoia %d, detection only", *listen, *paranoia)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "crs-detect:", err)
		os.Exit(1)
	}
}

// hasAttackTag keeps a rule only when it carries a CRS attack-* tag: the bookkeeping, initialization and evaluation rules also match every request.
func hasAttackTag(tags []string) bool {
	for _, t := range tags {
		if strings.HasPrefix(strings.ToLower(t), "attack-") {
			return true
		}
	}
	return false
}
