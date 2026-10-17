package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) (*App, *httptest.Server) {
	t.Helper()
	a, e := newApp(filepath.Join(t.TempDir(), "session.json"))
	if e != nil {
		t.Fatal(e)
	}
	s := httptest.NewServer(a.handler())
	t.Cleanup(s.Close)
	return a, s
}
func request(t *testing.T, s *httptest.Server, method, path string, body any, key string) *http.Response {
	t.Helper()
	var b bytes.Buffer
	if body != nil {
		json.NewEncoder(&b).Encode(body)
	}
	r, _ := http.NewRequest(method, s.URL+path, &b)
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	r.Header.Set("Content-Type", "application/json")
	res, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	return res
}
func status(t *testing.T, r *http.Response, want int) {
	t.Helper()
	defer r.Body.Close()
	if r.StatusCode != want {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status %d != %d: %s", r.StatusCode, want, b)
	}
}
func submission(a *App, text string) map[string]string {
	return map[string]string{"text": text, "room": a.room, "round": a.state.Round}
}
func TestSubmitCountsPersistenceAndExport(t *testing.T) {
	a, s := testApp(t)
	status(t, request(t, s, "POST", "/api/submit", submission(a, "期待、勇氣、期待"), ""), 200)
	status(t, request(t, s, "POST", "/api/submit", submission(a, "期待"), ""), 200)
	if a.state.Responses != 2 || len(a.state.Words) != 2 || a.state.Words[0].Text != "期待" || a.state.Words[0].Count != 2 {
		t.Fatalf("bad aggregation: %+v", a.state)
	}
	loaded, e := newApp(a.path)
	if e != nil {
		t.Fatal(e)
	}
	if loaded.state.Responses != 2 {
		t.Fatal("not persisted")
	}
	if loaded.state.Round == a.state.Round {
		t.Fatal("restart must invalidate stale round")
	}
	r := request(t, s, "GET", "/api/admin/export", nil, a.key)
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if !bytes.HasPrefix(b, []byte{0xef, 0xbb, 0xbf}) || !strings.Contains(string(b), "期待,2") {
		t.Fatalf("CSV: %s", b)
	}
}
func TestAccessInputPauseAndRounds(t *testing.T) {
	a, s := testApp(t)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "clear"}, "wrong"), 403)
	req := httptest.NewRequest("POST", "/api/admin/action", strings.NewReader(`{"action":"clear"}`))
	req.RemoteAddr = "192.168.1.20:2345"
	req.Header.Set("Authorization", "Bearer "+a.key)
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal("LAN admin must be rejected")
	}
	status(t, request(t, s, "POST", "/api/submit", submission(a, "一、二、三、四"), ""), 400)
	status(t, request(t, s, "POST", "/api/submit", submission(a, strings.Repeat("字", 21)), ""), 400)
	status(t, request(t, s, "POST", "/api/submit", map[string]string{"text": "嗨", "room": "wrong", "round": a.state.Round}, ""), 403)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "toggle"}, a.key), 200)
	status(t, request(t, s, "POST", "/api/submit", submission(a, "暫停"), ""), 409)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "toggle"}, a.key), 200)
	old := submission(a, "舊題目")
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "clear"}, a.key), 200)
	status(t, request(t, s, "POST", "/api/submit", old, ""), 409)
	r, _ := http.NewRequest("POST", s.URL+"/api/submit", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://unrelated.example")
	res, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	status(t, res, 403)
}
func TestQRPagesAndAssets(t *testing.T) {
	_, s := testApp(t)
	for _, p := range []string{"/host", "/join", "/screen", "/style.css", "/app.js", "/api/join"} {
		status(t, request(t, s, "GET", p, nil, ""), 200)
	}
	r := request(t, s, "GET", "/qr.png", nil, "")
	defer r.Body.Close()
	img, e := png.Decode(r.Body)
	if e != nil || img.Bounds().Dx() != 384 {
		t.Fatal("bad QR image", e)
	}
}
func TestLiveEvent(t *testing.T) {
	a, s := testApp(t)
	client := &http.Client{Timeout: 4 * time.Second}
	r, e := client.Get(s.URL + "/api/events")
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	b := bufio.NewReader(r.Body)
	line, _ := b.ReadString('\n')
	b.ReadString('\n')
	if line != "data: update\n" {
		t.Fatal("no initial event")
	}
	status(t, request(t, s, "POST", "/api/submit", submission(a, "即時更新"), ""), 200)
	line, e = b.ReadString('\n')
	if e != nil || line != "data: update\n" {
		t.Fatal("no update event", e, line)
	}
}
func TestRateLimitAndCSVFormula(t *testing.T) {
	a, s := testApp(t)
	for i := 0; i < 5; i++ {
		status(t, request(t, s, "POST", "/api/submit", submission(a, "=SUM(A1)"), ""), 200)
	}
	status(t, request(t, s, "POST", "/api/submit", submission(a, "太多次"), ""), 429)
	r := request(t, s, "GET", "/api/admin/export", nil, a.key)
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if !strings.Contains(string(b), "'=SUM(A1)") {
		t.Fatal("formula not escaped")
	}
}

func TestClearRestartsAndPreservesQuestionThemeAndQR(t *testing.T) {
	a, s := testApp(t)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "settings", "question": "新一輪，想到什麼？", "theme": "orange"}, a.key), 200)
	status(t, request(t, s, "POST", "/api/submit", submission(a, "原本的詞"), ""), 200)
	oldRound, room := a.state.Round, a.room
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "toggle"}, a.key), 200)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "clear"}, a.key), 200)
	if len(a.state.Words) != 0 || a.state.Responses != 0 || !a.state.Open || a.state.Round == oldRound {
		t.Fatalf("reset failed: %+v", a.state)
	}
	if a.room != room || a.state.Theme != "orange" || a.state.Question != "新一輪，想到什麼？" {
		t.Fatal("question, theme or QR changed")
	}
	loaded, e := newApp(a.path)
	if e != nil {
		t.Fatal(e)
	}
	if loaded.state.Responses != 0 || len(loaded.state.Words) != 0 {
		t.Fatal("old words reappeared after reload")
	}
	status(t, request(t, s, "POST", "/api/submit", submission(a, "重新開始"), ""), 200)
	if a.state.Responses != 1 || len(a.state.Words) != 1 || a.state.Words[0].Text != "重新開始" {
		t.Fatal("new round submission failed")
	}
}

func TestSchoolWiFiAndHotspotAddresses(t *testing.T) {
	for _, s := range []string{"192.168.43.22", "192.168.137.2", "172.20.10.4", "10.20.30.4", "140.116.1.2"} {
		if !usableIP(net.ParseIP(s)) {
			t.Fatal("valid Wi-Fi address excluded", s)
		}
	}
	for _, s := range []string{"127.0.0.1", "169.254.1.2", "0.0.0.0", "224.0.0.1", "::1"} {
		if usableIP(net.ParseIP(s)) {
			t.Fatal("unusable address included", s)
		}
	}
	a, server := testApp(t)
	a.port = 8765
	status(t, request(t, server, "POST", "/api/submit", submission(a, "保留活動資料"), ""), 200)
	room, round := a.room, a.state.Round
	a.base = "http://192.0.2.123:1234"
	status(t, request(t, server, "POST", "/api/admin/action", map[string]string{"action": "refreshNetwork"}, a.key), 200)
	if a.base == "http://192.0.2.123:1234" || len(a.bases) == 0 {
		t.Fatal("stale network was not refreshed")
	}
	if a.room != room || a.state.Round != round || a.state.Responses != 1 {
		t.Fatal("refresh lost activity data")
	}
	status(t, request(t, server, "GET", "/qr.png", nil, ""), 200)
}

func likeRequest(t *testing.T, s *httptest.Server, a *App, text, id string) *http.Response {
	t.Helper()
	b, _ := json.Marshal(submission(a, text))
	r, _ := http.NewRequest("POST", s.URL+"/api/like", bytes.NewReader(b))
	r.AddCookie(&http.Cookie{Name: "junba_wordcloud_voter", Value: id})
	r.Header.Set("Content-Type", "application/json")
	res, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	return res
}
func TestLikesRankingPrivacyPersistenceAndReset(t *testing.T) {
	a, s := testApp(t)
	idA, idB := strings.Repeat("a", 32), strings.Repeat("b", 32)
	status(t, request(t, s, "POST", "/api/submit", submission(a, "試錯、勇氣"), ""), 200)
	status(t, likeRequest(t, s, a, "試錯", idA), 200)
	status(t, likeRequest(t, s, a, "試錯", idA), 409)
	status(t, likeRequest(t, s, a, "試錯", idB), 200)
	if a.state.Responses != 1 || a.state.LikesTotal != 2 || a.state.Words[0].Text != "試錯" || a.state.Words[0].Likes != 2 {
		t.Fatalf("likes or ranking failed: %+v", a.state)
	}
	r, _ := http.NewRequest("GET", s.URL+"/api/state", nil)
	r.AddCookie(&http.Cookie{Name: "junba_wordcloud_voter", Value: idA})
	res, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var out struct {
		Liked      []string `json:"liked"`
		LikesTotal int      `json:"likesTotal"`
	}
	json.Unmarshal(raw, &out)
	if len(out.Liked) != 1 || out.Liked[0] != "試錯" || out.LikesTotal != 2 {
		t.Fatal("current browser's liked state missing")
	}
	if strings.Contains(string(raw), idA) || strings.Contains(string(raw), idB) || strings.Contains(string(raw), `"votes"`) {
		t.Fatal("private voter records leaked")
	}
	loaded, e := newApp(a.path)
	if e != nil {
		t.Fatal(e)
	}
	if loaded.state.LikesTotal != 2 || len(loaded.state.Votes[idA]) != 1 {
		t.Fatal("likes not persisted")
	}
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "toggle"}, a.key), 200)
	status(t, likeRequest(t, s, a, "勇氣", idA), 409)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "clear"}, a.key), 200)
	if a.state.LikesTotal != 0 || len(a.state.Votes) != 0 || len(a.state.Words) != 0 {
		t.Fatal("clear did not reset likes")
	}
	status(t, request(t, s, "POST", "/api/submit", submission(a, "試錯"), ""), 200)
	status(t, likeRequest(t, s, a, "試錯", idA), 200)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "delete", "text": "試錯"}, a.key), 200)
	if a.state.LikesTotal != 0 || len(a.state.Votes) != 0 {
		t.Fatal("delete did not clean like records")
	}
	if _, e := newApp(a.path); e != nil {
		t.Fatal("deleted state cannot reload", e)
	}
}
func TestConcurrentLikesDoNotDoubleCount(t *testing.T) {
	a, s := testApp(t)
	status(t, request(t, s, "POST", "/api/submit", submission(a, "共同想法"), ""), 200)
	body, _ := json.Marshal(submission(a, "共同想法"))
	codes := make(chan int, 12)
	for i := 0; i < 12; i++ {
		go func() {
			r, _ := http.NewRequest("POST", s.URL+"/api/like", bytes.NewReader(body))
			r.AddCookie(&http.Cookie{Name: "junba_wordcloud_voter", Value: strings.Repeat("c", 32)})
			res, e := s.Client().Do(r)
			if e != nil {
				codes <- 0
				return
			}
			res.Body.Close()
			codes <- res.StatusCode
		}()
	}
	success := 0
	for i := 0; i < 12; i++ {
		code := <-codes
		if code == 200 {
			success++
		} else if code != 409 {
			t.Fatalf("unexpected status %d", code)
		}
	}
	if success != 1 || a.state.LikesTotal != 1 || a.state.Words[0].Likes != 1 {
		t.Fatal("duplicate concurrent like was counted")
	}
}

func TestAppearanceSettingsPersistenceAndLegacyAssets(t *testing.T) {
	a, s := testApp(t)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "settings", "question": "可愛的小雲朵", "theme": "paper", "font": "serif", "style": "clouds", "motion": "eco"}, a.key), 200)
	b, e := newApp(a.path)
	if e != nil {
		t.Fatal(e)
	}
	if b.state.Font != "serif" || b.state.Style != "clouds" || b.state.Motion != "eco" {
		t.Fatal("appearance settings not persisted")
	}
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "settings", "question": "拒絕錯誤設定", "theme": "paper", "font": "unknown"}, a.key), 400)
	for _, path := range []string{"/fonts/round.woff", "/fonts/serif.woff", "/lite", "/legacy.js", "/legacy.css"} {
		status(t, request(t, s, "GET", path, nil, ""), 200)
	}
}

func TestPrivateQuestionBankSaveUseAndImport(t *testing.T) {
	a, s := testApp(t)
	n := len(a.state.Questions)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "questionSave", "question": "下一步，你想嘗試什麼？"}, a.key), 200)
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "questionSave", "question": "下一步，你想嘗試什麼？"}, a.key), 200)
	if len(a.state.Questions) != n+1 {
		t.Fatal("question save did not deduplicate")
	}
	status(t, request(t, s, "POST", "/api/submit", submission(a, "舊題結果"), ""), 200)
	room := a.room
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "questionUse", "question": "下一步，你想嘗試什麼？"}, a.key), 200)
	if a.state.Question != "下一步，你想嘗試什麼？" || a.state.Responses != 0 || len(a.state.Words) != 0 || !a.state.Open || a.room != room || len(a.state.Questions) != n+1 {
		t.Fatal("switch question did not preserve bank/QR or reset results")
	}
	status(t, request(t, s, "POST", "/api/admin/action", map[string]any{"action": "questionsImport", "questions": []string{"下一步，你想嘗試什麼？", "今天的收穫"}}, a.key), 200)
	if len(a.state.Questions) != n+2 {
		t.Fatal("import merge failed")
	}
	loaded, e := newApp(a.path)
	if e != nil || len(loaded.state.Questions) != n+2 {
		t.Fatal("question bank not persisted", e)
	}
	res := request(t, s, "GET", "/api/state", nil, "")
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if strings.Contains(string(b), `"questions"`) {
		t.Fatal("private question bank leaked to participants")
	}
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "questionDelete", "question": a.state.Question}, a.key), 200)
	if a.state.Question != "下一步，你想嘗試什麼？" {
		t.Fatal("deleting saved item changed active question")
	}
	status(t, request(t, s, "POST", "/api/admin/action", map[string]string{"action": "questionSave", "question": strings.Repeat("字", 101)}, a.key), 400)
}
