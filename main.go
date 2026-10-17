package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	qrcode "github.com/skip2/go-qrcode"
)

//go:embed web/*
var files embed.FS

type Word struct {
	Text  string `json:"text"`
	Count int    `json:"count"`
	Likes int    `json:"likes"`
}
type State struct {
	Questions  []string            `json:"questions"`
	Font       string              `json:"font"`
	Style      string              `json:"style"`
	Motion     string              `json:"motion"`
	Question   string              `json:"question"`
	Theme      string              `json:"theme"`
	Open       bool                `json:"open"`
	Round      string              `json:"round"`
	Words      []Word              `json:"words"`
	Responses  int                 `json:"responses"`
	Updated    string              `json:"updated"`
	LikesTotal int                 `json:"likesTotal"`
	Votes      map[string][]string `json:"votes,omitempty"`
}
type App struct {
	mu      sync.Mutex
	state   State
	key     string
	room    string
	port    int
	base    string
	bases   []string
	path    string
	clients map[chan struct{}]bool
	rates   map[string][]time.Time
	server  *http.Server
}

func token() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func defaultQuestions() []string {
	return []string{"用一個詞，說說你對未來的想像。", "想到求職，你最在意的是什麼？", "今天你最想帶走的一個收穫是什麼？", "你願意為未來嘗試的一件事是什麼？", "理想工作最重要的條件是什麼？"}
}
func defaultState() State {
	return State{Questions: defaultQuestions(), Font: "round", Style: "clouds", Motion: "gentle", Question: "用一個詞，說說你對未來的想像。", Theme: "night", Open: true, Round: token(), Words: []Word{}, Votes: map[string][]string{}, Updated: time.Now().Format(time.RFC3339)}
}
func dataPath() string {
	if p := os.Getenv("JUNBA_WORDCLOUD_DATA"); p != "" {
		return p
	}
	d, e := os.UserConfigDir()
	if e != nil {
		d = "."
	}
	return filepath.Join(d, "JunbaWordCloud", "session.json")
}
func newApp(path string) (*App, error) {
	a := &App{state: defaultState(), key: token(), room: token()[:12], path: path, clients: map[chan struct{}]bool{}, rates: map[string][]time.Time{}}
	if b, e := os.ReadFile(path); e == nil {
		var s State
		if json.Unmarshal(b, &s) != nil || !validState(s) {
			return nil, fmt.Errorf("儲存資料無法讀取，請先備份此檔案再移開：%s", path)
		}
		a.state = s
		a.state.Round = token()
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	if a.state.Questions == nil {
		a.state.Questions = defaultQuestions()
	}
	if a.state.Font == "" {
		a.state.Font = "round"
	}
	if a.state.Style == "" {
		a.state.Style = "clouds"
	}
	if a.state.Motion == "" {
		a.state.Motion = "gentle"
	}
	if a.state.Votes == nil {
		a.state.Votes = map[string][]string{}
	}
	sortWords(a.state.Words)
	a.bases = []string{"http://127.0.0.1:8765"}
	a.base = a.bases[0]
	return a, nil
}
func validAppearance(font, style, motion string) bool {
	return (font == "" || font == "round" || font == "sans" || font == "serif" || font == "mixed") && (style == "" || style == "words" || style == "clouds") && (motion == "" || motion == "gentle" || motion == "still" || motion == "eco")
}
func validState(s State) bool {
	if len(s.Questions) > 100 {
		return false
	}
	seenQuestions := map[string]bool{}
	for _, q := range s.Questions {
		if q == "" || normalize(q) != q || utf8.RuneCountInString(q) > 100 || seenQuestions[q] {
			return false
		}
		seenQuestions[q] = true
	}
	if !validAppearance(s.Font, s.Style, s.Motion) {
		return false
	}
	if strings.TrimSpace(s.Question) == "" || utf8.RuneCountInString(s.Question) > 100 || len(s.Words) > 2000 || s.Responses < 0 {
		return false
	}
	if s.Theme != "night" && s.Theme != "paper" && s.Theme != "orange" {
		return false
	}
	seen := map[string]bool{}
	for _, w := range s.Words {
		if normalize(w.Text) != w.Text || w.Text == "" || utf8.RuneCountInString(w.Text) > 20 || w.Count < 1 || w.Count > 100000 || w.Likes < 0 || w.Likes > 100000 || seen[w.Text] {
			return false
		}
		seen[w.Text] = true
	}
	if len(s.Votes) > 10000 || s.LikesTotal < 0 || s.LikesTotal > 100000 {
		return false
	}
	counts := map[string]int{}
	total := 0
	for voter, words := range s.Votes {
		if len(voter) != 32 || len(words) > 2000 {
			return false
		}
		if _, e := hex.DecodeString(voter); e != nil {
			return false
		}
		seenVotes := map[string]bool{}
		for _, word := range words {
			if !seen[word] || seenVotes[word] {
				return false
			}
			seenVotes[word] = true
			counts[word]++
			total++
		}
	}
	if total != s.LikesTotal {
		return false
	}
	for _, word := range s.Words {
		if word.Likes != counts[word.Text] {
			return false
		}
	}
	return true
}
func (a *App) saveLocked() error {
	a.state.Updated = time.Now().Format(time.RFC3339)
	if err := os.MkdirAll(filepath.Dir(a.path), 0700); err != nil {
		return err
	}
	b, e := json.MarshalIndent(a.state, "", "  ")
	if e != nil {
		return e
	}
	tmp := a.path + ".tmp"
	if e = os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	return os.Rename(tmp, a.path)
}
func (a *App) notifyLocked() {
	for c := range a.clients {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}
func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 65536)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "資料格式不正確或文字過長")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		fail(w, 400, "資料格式不正確")
		return false
	}
	return true
}
func normalize(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}
func (a *App) admin(w http.ResponseWriter, r *http.Request) bool {
	ip, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil || !net.ParseIP(ip).IsLoopback() || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+a.key)) != 1 {
		fail(w, 403, "此功能只供主持人於本機控制台操作")
		return false
	}
	return true
}
func voterID(w http.ResponseWriter, r *http.Request) string {
	if c, e := r.Cookie("junba_wordcloud_voter"); e == nil && len(c.Value) == 32 {
		if _, e := hex.DecodeString(c.Value); e == nil {
			return c.Value
		}
	}
	id := token()
	http.SetCookie(w, &http.Cookie{Name: "junba_wordcloud_voter", Value: id, Path: "/", MaxAge: 31536000, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	return id
}
func sortWords(words []Word) {
	sort.Slice(words, func(i, j int) bool {
		hi, hj := words[i].Count+words[i].Likes, words[j].Count+words[j].Likes
		if hi == hj {
			return words[i].Text < words[j].Text
		}
		return hi > hj
	})
}
func (a *App) stateGet(w http.ResponseWriter, r *http.Request) {
	id := voterID(w, r)
	a.mu.Lock()
	defer a.mu.Unlock()
	// Voter records remain private; only this browser's selected words are returned.
	liked := a.state.Votes[id]
	if liked == nil {
		liked = []string{}
	}
	jsonOut(w, map[string]any{"question": a.state.Question, "theme": a.state.Theme, "open": a.state.Open, "round": a.state.Round, "words": a.state.Words, "responses": a.state.Responses, "likesTotal": a.state.LikesTotal, "liked": liked, "updated": a.state.Updated, "font": a.state.Font, "style": a.state.Style, "motion": a.state.Motion})
}
func (a *App) like(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text  string `json:"text"`
		Room  string `json:"room"`
		Round string `json:"round"`
	}
	if !decode(w, r, &in) {
		return
	}
	id := voterID(w, r)
	a.mu.Lock()
	defer a.mu.Unlock()
	if in.Room != a.room {
		fail(w, 403, "活動連結已失效，請重新掃碼")
		return
	}
	if in.Round != a.state.Round {
		fail(w, 409, "活動已更新，請重新確認後再讚同")
		return
	}
	if !a.state.Open {
		fail(w, 409, "主持人已暫停收件與讚同")
		return
	}
	index := -1
	for i, word := range a.state.Words {
		if word.Text == in.Text {
			index = i
			break
		}
	}
	if index < 0 {
		fail(w, 404, "這個詞語已被移除，請重新整理")
		return
	}
	for _, word := range a.state.Votes[id] {
		if word == in.Text {
			fail(w, 409, "你已經讚同過這個詞語囉")
			return
		}
	}
	if a.state.LikesTotal >= 100000 || (len(a.state.Votes) >= 10000 && a.state.Votes[id] == nil) {
		fail(w, 409, "本題已達讚同數上限")
		return
	}
	prior := a.state
	a.state.Words = append([]Word{}, a.state.Words...)
	votes := make(map[string][]string, len(a.state.Votes)+1)
	for k, v := range a.state.Votes {
		votes[k] = v
	}
	a.state.Votes = votes
	a.state.Votes[id] = append(append([]string{}, a.state.Votes[id]...), in.Text)
	a.state.Words[index].Likes++
	a.state.LikesTotal++
	sortWords(a.state.Words)
	if e := a.saveLocked(); e != nil {
		a.state = prior
		fail(w, 500, "無法儲存讚同，請告知主持人")
		return
	}
	a.notifyLocked()
	jsonOut(w, map[string]bool{"ok": true})
}
func (a *App) submit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text  string `json:"text"`
		Room  string `json:"room"`
		Round string `json:"round"`
	}
	if !decode(w, r, &in) {
		return
	}
	parts := strings.FieldsFunc(in.Text, func(r rune) bool {
		return r == '\n' || r == '\r' || r == ',' || r == '，' || r == '、' || r == ';' || r == '；'
	})
	words := []string{}
	seen := map[string]bool{}
	for _, p := range parts {
		p = normalize(p)
		if p == "" {
			continue
		}
		if utf8.RuneCountInString(p) > 20 {
			fail(w, 400, "每個詞語最多 20 個字")
			return
		}
		if !seen[p] {
			words = append(words, p)
			seen[p] = true
		}
	}
	if len(words) == 0 || len(words) > 3 {
		fail(w, 400, "每次請輸入 1～3 個詞語，以換行或逗號分隔")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if in.Room != a.room {
		fail(w, 403, "活動連結已失效，請重新掃描現場 QR Code")
		return
	}
	if in.Round != a.state.Round {
		fail(w, 409, "題目已更新，請確認新題目後再送出")
		return
	}
	if !a.state.Open {
		fail(w, 409, "主持人目前已暫停收件")
		return
	}
	if len(a.state.Words)+len(words) > 2000 || a.state.Responses >= 10000 {
		fail(w, 409, "本題已達容量上限，請主持人開啟新一題")
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	now := time.Now()
	recent := []time.Time{}
	for _, t := range a.rates[ip] {
		if now.Sub(t) < 10*time.Second {
			recent = append(recent, t)
		}
	}
	if len(recent) >= 5 {
		fail(w, 429, "送得太快囉，請稍候 10 秒再試")
		return
	}
	// Discard expired IP entries to bound memory during long events.
	if len(a.rates) > 4096 {
		for k, v := range a.rates {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > time.Minute {
				delete(a.rates, k)
			}
		}
	}
	a.rates[ip] = append(recent, now)
	prior := a.state
	a.state.Words = append([]Word{}, a.state.Words...)
	for _, p := range words {
		found := false
		for i := range a.state.Words {
			if a.state.Words[i].Text == p {
				a.state.Words[i].Count++
				found = true
				break
			}
		}
		if !found {
			a.state.Words = append(a.state.Words, Word{Text: p, Count: 1})
		}
	}
	a.state.Responses++
	sortWords(a.state.Words)
	if e := a.saveLocked(); e != nil {
		a.state = prior
		fail(w, 500, "無法儲存，請告知主持人檢查資料夾權限")
		return
	}
	a.notifyLocked()
	jsonOut(w, map[string]bool{"ok": true})
}
func (a *App) events(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "無法建立即時連線")
		return
	}
	a.mu.Lock()
	if len(a.clients) >= 600 {
		a.mu.Unlock()
		fail(w, 503, "連線繁忙，將使用自動重新整理")
		return
	}
	c := make(chan struct{}, 1)
	a.clients[c] = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.clients, c); a.mu.Unlock() }()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	io.WriteString(w, "data: update\n\n")
	f.Flush()
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c:
			io.WriteString(w, "data: update\n\n")
			f.Flush()
		case <-t.C:
			io.WriteString(w, ": heartbeat\n\n")
			f.Flush()
		}
	}
}
func (a *App) config(w http.ResponseWriter, r *http.Request) {
	if !a.admin(w, r) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	links := []string{}
	for _, b := range a.bases {
		links = append(links, b+"/join?room="+a.room)
	}
	jsonOut(w, map[string]any{"links": links, "join": a.base + "/join?room=" + a.room, "dataPath": a.path, "version": "1.1.0", "questions": a.state.Questions})
}
func (a *App) change(w http.ResponseWriter, r *http.Request) {
	if !a.admin(w, r) {
		return
	}
	var in struct {
		Action    string   `json:"action"`
		Questions []string `json:"questions"`
		Font      string   `json:"font"`
		Style     string   `json:"style"`
		Motion    string   `json:"motion"`
		Question  string   `json:"question"`
		Theme     string   `json:"theme"`
		Text      string   `json:"text"`
		Base      string   `json:"base"`
	}
	if !decode(w, r, &in) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	prior := a.state
	oldbase := a.base
	oldBases := a.bases
	switch in.Action {
	case "questionSave":
		q := normalize(in.Question)
		if q == "" || utf8.RuneCountInString(q) > 100 {
			fail(w, 400, "題目請填 1～100 個字")
			return
		}
		exists := false
		for _, saved := range a.state.Questions {
			if saved == q {
				exists = true
				break
			}
		}
		if !exists {
			if len(a.state.Questions) >= 100 {
				fail(w, 400, "題庫最多 100 題")
				return
			}
			a.state.Questions = append(append([]string{}, a.state.Questions...), q)
		}
	case "questionDelete":
		kept := []string{}
		for _, q := range a.state.Questions {
			if q != in.Question {
				kept = append(kept, q)
			}
		}
		a.state.Questions = kept
	case "questionsImport":
		questions := append([]string{}, a.state.Questions...)
		seen := map[string]bool{}
		for _, q := range questions {
			seen[q] = true
		}
		for _, raw := range in.Questions {
			q := normalize(raw)
			if q == "" || utf8.RuneCountInString(q) > 100 {
				fail(w, 400, "匯入題目需為 1～100 個字")
				return
			}
			if !seen[q] {
				questions = append(questions, q)
				seen[q] = true
			}
		}
		if len(questions) > 100 {
			fail(w, 400, "合併後的題庫超過 100 題")
			return
		}
		a.state.Questions = questions
	case "questionUse":
		found := false
		for _, q := range a.state.Questions {
			if q == in.Question {
				found = true
				break
			}
		}
		if !found {
			fail(w, 404, "這題不在題庫中，請重新選擇")
			return
		}
		a.state.Question = in.Question
		a.state.Open = true
		a.state.Words = []Word{}
		a.state.Responses = 0
		a.state.LikesTotal = 0
		a.state.Votes = map[string][]string{}
		a.state.Round = token()
		a.rates = map[string][]time.Time{}
	case "settings":
		if !validAppearance(in.Font, in.Style, in.Motion) {
			fail(w, 400, "字體或動畫設定不正確")
			return
		}
		if in.Font != "" {
			a.state.Font = in.Font
		}
		if in.Style != "" {
			a.state.Style = in.Style
		}
		if in.Motion != "" {
			a.state.Motion = in.Motion
		}
		q := normalize(in.Question)
		if q == "" || utf8.RuneCountInString(q) > 100 {
			fail(w, 400, "題目請填 1～100 個字")
			return
		}
		if in.Theme != "night" && in.Theme != "paper" && in.Theme != "orange" {
			fail(w, 400, "主題格式不正確")
			return
		}
		if q != a.state.Question {
			a.state.Round = token()
		}
		a.state.Question = q
		a.state.Theme = in.Theme
	case "toggle":
		a.state.Open = !a.state.Open
	case "clear":
		a.state.Open = true
		a.state.Words = []Word{}
		a.state.Responses = 0
		a.state.LikesTotal = 0
		a.state.Votes = map[string][]string{}
		a.state.Round = token()
		a.rates = map[string][]time.Time{}
	case "delete":
		a.state.Words = append([]Word{}, a.state.Words...)
		for i, x := range a.state.Words {
			if x.Text == in.Text {
				a.state.LikesTotal -= x.Likes
				votes := make(map[string][]string, len(a.state.Votes))
				for voter, selected := range a.state.Votes {
					kept := []string{}
					for _, word := range selected {
						if word != x.Text {
							kept = append(kept, word)
						}
					}
					if len(kept) > 0 {
						votes[voter] = kept
					}
				}
				a.state.Votes = votes
				a.state.Words = append(a.state.Words[:i], a.state.Words[i+1:]...)
				break
			}
		}
	case "refreshNetwork":
		a.bases = basesFor(a.port)
		found := false
		for _, b := range a.bases {
			if b == a.base && !strings.Contains(b, "127.0.0.1") {
				found = true
				break
			}
		}
		if !found {
			a.base = a.bases[0]
		}
	case "network":
		found := false
		for _, b := range a.bases {
			if b == in.Base {
				found = true
				break
			}
		}
		if !found {
			fail(w, 400, "請選擇清單中的筆電網址")
			return
		}
		a.base = in.Base
	default:
		fail(w, 400, "不支援的操作")
		return
	}
	if e := a.saveLocked(); e != nil {
		a.state = prior
		a.base = oldbase
		a.bases = oldBases
		fail(w, 500, "儲存失敗，請檢查資料夾權限")
		return
	}
	a.notifyLocked()
	jsonOut(w, map[string]bool{"ok": true})
}
func safeCell(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}
func (a *App) export(w http.ResponseWriter, r *http.Request) {
	if !a.admin(w, r) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="Junba_WordCloud.csv"`)
	io.WriteString(w, "\uFEFF")
	c := csv.NewWriter(w)
	c.Write([]string{"題目", "詞語", "投稿次數", "讚同數", "熱度"})
	for _, x := range a.state.Words {
		c.Write([]string{safeCell(a.state.Question), safeCell(x.Text), strconv.Itoa(x.Count), strconv.Itoa(x.Likes), strconv.Itoa(x.Count + x.Likes)})
	}
	c.Flush()
}
func (a *App) backup(w http.ResponseWriter, r *http.Request) {
	if !a.admin(w, r) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	w.Header().Set("Content-Disposition", `attachment; filename="Junba_WordCloud_backup.json"`)
	jsonOut(w, a.state)
}
func (a *App) qr(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	base := a.base
	room := a.room
	bases := append([]string{}, a.bases...)
	a.mu.Unlock()
	if b := r.URL.Query().Get("base"); b != "" {
		for _, x := range bases {
			if b == x {
				base = b
				break
			}
		}
	}
	p, e := qrcode.Encode(base+"/join?room="+room, qrcode.Medium, 384)
	if e != nil {
		fail(w, 500, "QR Code 產生失敗")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Write(p)
}
func (a *App) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/join", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		jsonOut(w, map[string]string{"join": a.base + "/join?room=" + a.room})
	})
	mux.HandleFunc("GET /api/state", a.stateGet)
	mux.HandleFunc("GET /api/events", a.events)
	mux.HandleFunc("POST /api/submit", a.submit)
	mux.HandleFunc("POST /api/like", a.like)
	mux.HandleFunc("GET /api/admin/config", a.config)
	mux.HandleFunc("POST /api/admin/action", a.change)
	mux.HandleFunc("GET /api/admin/export", a.export)
	mux.HandleFunc("GET /api/admin/backup", a.backup)
	mux.HandleFunc("POST /api/admin/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if !a.admin(w, r) {
			return
		}
		jsonOut(w, map[string]bool{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); a.server.Close() }()
	})
	mux.HandleFunc("GET /qr.png", a.qr)
	web, _ := fs.Sub(files, "web")
	static := http.FileServer(http.FS(web))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/lite" {
			http.ServeFileFS(w, r, web, "legacy.html")
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/host" || r.URL.Path == "/join" || r.URL.Path == "/screen" {
			http.ServeFileFS(w, r, web, "index.html")
			return
		}
		static.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		if r.Method == http.MethodPost && r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+r.Host {
			fail(w, 403, "請從本活動頁面送出")
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func usableIP(ip net.IP) bool {
	return ip != nil && ip.To4() != nil && ip.IsGlobalUnicast() && !ip.IsLoopback()
}
func basesFor(port int) []string {
	interfaces, _ := net.Interfaces()
	out := []string{}
	for _, n := range interfaces {
		if n.Flags&net.FlagUp == 0 || n.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := n.Addrs()
		for _, ad := range addresses {
			ip, _, e := net.ParseCIDR(ad.String())
			if e == nil && usableIP(ip) {
				out = append(out, fmt.Sprintf("http://%s:%d", ip.String(), port))
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.Contains(out[i], "192.168.") && !strings.Contains(out[j], "192.168.")
	})
	return append(out, fmt.Sprintf("http://127.0.0.1:%d", port))
}
func openBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		for _, root := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
			if root == "" {
				continue
			}
			for _, parts := range [][]string{{"Microsoft", "Edge", "Application", "msedge.exe"}, {"Google", "Chrome", "Application", "chrome.exe"}} {
				path := filepath.Join(append([]string{root}, parts...)...)
				if _, e := os.Stat(path); e == nil {
					if exec.Command(path, url).Start() == nil {
						return
					}
				}
			}
		}
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		exec.Command("open", url).Start()
	default:
		exec.Command("xdg-open", url).Start()
	}
}
func main() {
	port := flag.Int("port", 8765, "HTTP port")
	noBrowser := flag.Bool("no-browser", false, "Do not open browser")
	flag.Parse()
	a, e := newApp(dataPath())
	if e != nil {
		log.Print(e)
		fmt.Println("按 Enter 關閉。")
		fmt.Scanln()
		return
	}
	ln, e := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", *port))
	if e != nil {
		fmt.Println("無法啟動：連接埠已被使用。請先關閉上一個文字雲程式，再重新開啟。", e)
		fmt.Println("按 Enter 關閉。")
		fmt.Scanln()
		return
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	a.bases = basesFor(a.port)
	a.base = a.bases[0]
	a.mu.Lock()
	e = a.saveLocked()
	a.mu.Unlock()
	if e != nil {
		log.Fatal("無法儲存活動資料：", e)
	}
	host := fmt.Sprintf("http://127.0.0.1:%d/host#key=%s", a.port, a.key)
	fmt.Println("峻爸文字雲 v1.1｜作者：峻爸\n請保持此視窗開啟；結束時可於主持台按「結束程式」。")
	fmt.Println("主持台：", host)
	fmt.Println("手機網址：", a.base+"/join?room="+a.room)
	fmt.Println("資料位置：", a.path)
	a.server = &http.Server{Handler: a.handler(), ReadHeaderTimeout: 8 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16384}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() { <-sig; a.server.Close() }()
	if !*noBrowser {
		go func() { time.Sleep(400 * time.Millisecond); openBrowser(host) }()
	}
	if e = a.server.Serve(ln); e != nil && e != http.ErrServerClosed {
		log.Print(e)
	}
}
