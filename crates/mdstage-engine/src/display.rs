//! The display web server: shows per-cue markdown in browsers on stage monitors, tablets
//! or subtitle screens at `http://<address>:<port>/<slug>`, with live updates over
//! Server-Sent Events and spoken announcements.
//!
//! Clients only receive. The server serves nothing but its built-in page, script and
//! stylesheets, plus `.css` files from the show's `css/` folder.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde_json::json;

const PAGE: &str = include_str!("../display/index.html");
const SCRIPT: &str = include_str!("../display/app.js");

const BASE_STYLE: &str = "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;}";
const KEEP_ALIVE: Duration = Duration::from_secs(20);
/// Limits so clients on the network cannot grow the roster without bound.
const MAX_CLIENTS: usize = 200;
const MAX_FIELD: usize = 80;
const MAX_REQUEST: usize = 8192;
/// Each connection has a thread; more than this at once are turned away.
const MAX_CONNECTIONS: usize = 256;

/// A display device as configured on this machine.
#[derive(Clone, Debug, PartialEq)]
pub struct DisplayDevice {
    pub name: String,
    /// `dark`, `light`, `subtitle`, or a `.css` file from the show's `css/` folder.
    pub style: String,
    /// Page through overflowing content every this many seconds; 0 = off.
    pub scroll_seconds: u32,
    /// Language of the announcements (`de`, `en-GB`, …).
    pub language: String,
    /// Speak announcements twice, with "I repeat" in between.
    pub repeat: bool,
}

/// A browser tab that has connected to a display since the server started.
#[derive(Clone, Debug, PartialEq)]
pub struct Client {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub voice: String,
    pub connected: bool,
}

/// URL path of a display: lower case, umlauts spelled out, everything else hyphens.
pub fn slugify(name: &str) -> String {
    let mut spelled = String::new();
    for c in name.to_lowercase().chars() {
        match c {
            'ä' => spelled.push_str("ae"),
            'ö' => spelled.push_str("oe"),
            'ü' => spelled.push_str("ue"),
            'ß' => spelled.push_str("ss"),
            'à' | 'á' | 'â' | 'ã' | 'å' => spelled.push('a'),
            'è' | 'é' | 'ê' | 'ë' => spelled.push('e'),
            'ì' | 'í' | 'î' | 'ï' => spelled.push('i'),
            'ò' | 'ó' | 'ô' | 'õ' => spelled.push('o'),
            'ù' | 'ú' | 'û' => spelled.push('u'),
            'ç' => spelled.push('c'),
            'ñ' => spelled.push('n'),
            c => spelled.push(c),
        }
    }
    let mut slug = String::new();
    for c in spelled.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() { "display".into() } else { slug.into() }
}

/// "I repeat" in the display's language, falling back to the app language, then German.
pub fn repeat_phrase(language: &str, app_language: &str) -> &'static str {
    let phrase = |code: &str| {
        Some(match code.to_lowercase().split('-').next()? {
            "de" => "Ich wiederhole",
            "en" => "I repeat",
            "fr" => "Je répète",
            "es" | "pt" => "Repito",
            "it" => "Ripeto",
            "nl" => "Ik herhaal",
            "pl" => "Powtarzam",
            "ru" => "Повторяю",
            "tr" => "Tekrar ediyorum",
            "cs" => "Opakuji",
            "da" => "Jeg gentager",
            "sv" => "Jag upprepar",
            "nb" => "Jeg gjentar",
            "fi" => "Toistan",
            "zh" => "我重复",
            "ja" => "繰り返します",
            "ko" => "반복합니다",
            "ar" => "أكرر",
            _ => return None,
        })
    };
    phrase(language).or_else(|| phrase(app_language)).unwrap_or("Ich wiederhole")
}

fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}

/// Render markdown to HTML using only headings, paragraphs, emphasis, lists, quotes,
/// code and rules. Links and images keep their text only; raw HTML is shown as text.
pub fn render_markdown(markdown: &str) -> String {
    let mut html = String::new();
    for event in Parser::new(markdown) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => html.push_str("<p>"),
                Tag::Heading { level, .. } => html.push_str(&format!("<h{}>", level as u8)),
                Tag::BlockQuote(_) => html.push_str("<blockquote>"),
                Tag::CodeBlock(_) => html.push_str("<pre><code>"),
                Tag::List(Some(_)) => html.push_str("<ol>"),
                Tag::List(None) => html.push_str("<ul>"),
                Tag::Item => html.push_str("<li>"),
                Tag::Emphasis => html.push_str("<em>"),
                Tag::Strong => html.push_str("<strong>"),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => html.push_str("</p>\n"),
                TagEnd::Heading(level) => html.push_str(&format!("</h{}>\n", level as u8)),
                TagEnd::BlockQuote(_) => html.push_str("</blockquote>\n"),
                TagEnd::CodeBlock => html.push_str("</code></pre>\n"),
                TagEnd::List(true) => html.push_str("</ol>\n"),
                TagEnd::List(false) => html.push_str("</ul>\n"),
                TagEnd::Item => html.push_str("</li>\n"),
                TagEnd::Emphasis => html.push_str("</em>"),
                TagEnd::Strong => html.push_str("</strong>"),
                _ => {}
            },
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => escape(&text, &mut html),
            Event::Code(code) => {
                html.push_str("<code>");
                escape(&code, &mut html);
                html.push_str("</code>");
            }
            Event::SoftBreak => html.push('\n'),
            Event::HardBreak => html.push_str("<br>\n"),
            Event::Rule => html.push_str("<hr>\n"),
            _ => {}
        }
    }
    html
}

fn builtin_style(name: &str) -> Option<String> {
    let (colours, content) = match name {
        "dark" => ("background:#1e222a;color:#e6e6e6;", "#content{padding:4vh 5vw;font-size:5vh;line-height:1.4;box-sizing:border-box;}\n#content h1{font-size:1.6em;}#content h2{font-size:1.3em;}\n#content img{max-width:100%;}#content a{color:#61afef;}"),
        "light" => ("background:#ffffff;color:#111111;", "#content{padding:4vh 5vw;font-size:5vh;line-height:1.4;box-sizing:border-box;}\n#content h1{font-size:1.6em;}#content h2{font-size:1.3em;}\n#content img{max-width:100%;}#content a{color:#1a5fb4;}"),
        "subtitle" => ("background:#000000;color:#ffffff;", "#content{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4vh 5vw;font-size:7vh;line-height:1.35;box-sizing:border-box;font-weight:600;}\n#content img{max-width:100%;}"),
        _ => return None,
    };
    Some(format!("html,body{{margin:0;height:100%;{colours}{BASE_STYLE}\n{content}"))
}

#[derive(Clone, Default, PartialEq)]
struct Content {
    html: String,
    style: String,
    scroll_seconds: u32,
    language: String,
}

impl Content {
    fn event(&self) -> String {
        json!({ "type": "content", "html": self.html, "style": self.style, "scrollSec": self.scroll_seconds, "lang": self.language }).to_string()
    }
}

struct Stream {
    client: String,
    slug: String,
    socket: TcpStream,
}

#[derive(Default)]
struct State {
    devices: Vec<DisplayDevice>,
    content: HashMap<String, Content>,
    streams: Vec<Stream>,
    /// Oldest first.
    clients: Vec<Client>,
    css_dir: Option<PathBuf>,
    app_language: String,
    changed: bool,
}

impl State {
    /// Send an event to every stream of a display; streams that fail are dropped.
    fn push(&mut self, slug: &str, data: &str) {
        let line = format!("data: {data}\n\n");
        let mut gone = Vec::new();
        for stream in self.streams.iter_mut().filter(|s| s.slug == slug) {
            if stream.socket.write_all(line.as_bytes()).is_err() {
                gone.push(stream.client.clone());
            }
        }
        for client in gone {
            self.disconnect(&client, None);
        }
    }

    /// Remove a client's stream (one specific socket, or all of them) and update presence.
    fn disconnect(&mut self, client: &str, socket: Option<SocketAddr>) {
        self.streams.retain(|s| s.client != client || socket.is_some_and(|a| s.socket.peer_addr().ok() != Some(a)));
        let still = self.streams.iter().any(|s| s.client == client);
        if let Some(c) = self.clients.iter_mut().find(|c| c.id == client) {
            if c.connected != still {
                c.connected = still;
                self.changed = true;
            }
        }
    }

    fn client(&mut self, id: &str) -> &mut Client {
        if let Some(i) = self.clients.iter().position(|c| c.id == id) {
            return &mut self.clients[i];
        }
        // Over the limit: forget the oldest clients that are no longer connected.
        while self.clients.len() >= MAX_CLIENTS {
            match self.clients.iter().position(|c| !c.connected) {
                Some(i) => drop(self.clients.remove(i)),
                None => break,
            }
        }
        self.clients.push(Client { id: id.into(), slug: String::new(), name: String::new(), voice: String::new(), connected: false });
        self.clients.last_mut().unwrap()
    }

    fn index_page(&self) -> String {
        let mut rows = String::new();
        for device in &self.devices {
            let slug = slugify(&device.name);
            rows.push_str("<li><a href=\"/");
            escape(&slug, &mut rows);
            rows.push_str("\"><span class=\"nm\">");
            escape(&device.name, &mut rows);
            rows.push_str("</span><span class=\"sl\">/");
            escape(&slug, &mut rows);
            rows.push_str("</span></a></li>");
        }
        let list = if rows.is_empty() {
            "<p class=\"empty\">Noch keine Display-Geräte konfiguriert. Lege in den Einstellungen ein Ausgabegerät vom Typ „Display\" an.</p>".to_string()
        } else {
            format!("<ul class=\"devs\">{rows}</ul>")
        };
        format!(
            "<!doctype html>\n<html lang=\"de\"><head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta http-equiv=\"refresh\" content=\"20\">\n<title>MDstage Displays</title>\n<style>\n  html,body{{margin:0;height:100%;background:#1e222a;color:#e6e6e6;{BASE_STYLE}\n  .wrap{{max-width:44rem;margin:0 auto;padding:8vh 6vw;box-sizing:border-box;}}\n  h1{{font-size:1.9rem;font-weight:600;margin:0 0 0.3rem;}}\n  .sub{{color:#9aa0aa;margin:0 0 2rem;font-size:0.95rem;}}\n  ul.devs{{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.6rem;}}\n  ul.devs a{{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;text-decoration:none;background:#272c35;border:1px solid #3a3f4a;border-radius:10px;padding:0.9rem 1.1rem;color:#e6e6e6;}}\n  ul.devs a:hover{{background:#2f3540;border-color:#61afef;}}\n  ul.devs .nm{{font-size:1.15rem;font-weight:500;}}\n  ul.devs .sl{{color:#7f8794;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9rem;}}\n  .empty{{color:#9aa0aa;background:#272c35;border:1px solid #3a3f4a;border-radius:10px;padding:1.2rem;}}\n</style></head><body>\n<div class=\"wrap\">\n  <h1>MDstage Displays</h1>\n  <p class=\"sub\">Verfügbare Anzeigegeräte — zum Öffnen antippen.</p>\n  {list}\n</div>\n</body></html>"
        )
    }
}

fn clamp_field(value: &str) -> String {
    value.chars().take(MAX_FIELD).collect()
}

pub(crate) fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub(crate) fn query(text: &str) -> HashMap<String, String> {
    text.split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((percent_decode(key)?, percent_decode(value)?))
        })
        .collect()
}

fn is_file_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

pub(crate) fn respond(socket: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).and_then(|_| socket.write_all(body.as_bytes()));
}

fn handle(mut socket: TcpStream, state: &Arc<Mutex<State>>, running: &AtomicBool) {
    let _ = socket.set_read_timeout(Some(Duration::from_secs(10)));
    let mut request_line = String::new();
    {
        let mut reader = BufReader::new((&socket).take(MAX_REQUEST as u64));
        if reader.read_line(&mut request_line).is_err() {
            return;
        }
        // The headers are not needed; read them off so the client is not cut short.
        let mut header = String::new();
        while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
            header.clear();
        }
    }
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return respond(&mut socket, "405 Method Not Allowed", "text/plain", "");
    };
    let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let Some(path) = percent_decode(raw_path).filter(|p| !p.contains('\0')) else {
        return respond(&mut socket, "400 Bad Request", "text/plain", "");
    };
    let params = query(raw_query);

    if path == "/__display/app.js" {
        return respond(&mut socket, "200 OK", "application/javascript; charset=utf-8", SCRIPT);
    }
    if let Some(name) = path.strip_prefix("/__display/style/").filter(|n| is_file_name(n)) {
        let css = builtin_style(name).or_else(|| {
            let dir = state.lock().unwrap().css_dir.clone()?;
            name.ends_with(".css").then(|| std::fs::read_to_string(dir.join(name)).ok()).flatten()
        });
        let css = css.or_else(|| builtin_style("dark")).unwrap_or_default();
        return respond(&mut socket, "200 OK", "text/css; charset=utf-8", &css);
    }
    if path == "/__display/meta" {
        if let Some(id) = params.get("clientId").filter(|id| !id.is_empty()) {
            let mut state = state.lock().unwrap();
            let client = state.client(&clamp_field(id));
            if let Some(name) = params.get("name") {
                client.name = clamp_field(name);
            }
            if let Some(voice) = params.get("voice") {
                client.voice = clamp_field(voice);
            }
            if let Some(slug) = params.get("slug").filter(|s| !s.is_empty()) {
                client.slug = clamp_field(slug);
            }
            state.changed = true;
        }
        let _ = socket.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        return;
    }
    if let Some(slug) = path.strip_prefix("/__display/events/").filter(|s| !s.is_empty()) {
        return stream_events(socket, clamp_field(slug), params.get("clientId").cloned(), state, running);
    }
    if path == "/" {
        let page = state.lock().unwrap().index_page();
        return respond(&mut socket, "200 OK", "text/html; charset=utf-8", &page);
    }
    // Any other path is a display's page; the script asks for that slug's events.
    respond(&mut socket, "200 OK", "text/html; charset=utf-8", PAGE)
}

/// Serve one client's event stream until it disconnects or the server stops.
fn stream_events(mut socket: TcpStream, slug: String, client: Option<String>, state: &Arc<Mutex<State>>, running: &AtomicBool) {
    let Ok(peer) = socket.peer_addr() else { return };
    let client = client.map(|c| clamp_field(&c)).filter(|c| !c.is_empty()).unwrap_or_else(|| format!("anon-{peer}"));
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
    {
        let mut state = state.lock().unwrap();
        let current = state.content.get(&slug).cloned().unwrap_or_else(|| Content { style: "dark".into(), ..Default::default() });
        let hello = format!("{head}data: {}\n\n", current.event());
        let Ok(writer) = socket.try_clone() else { return };
        if socket.write_all(hello.as_bytes()).is_err() {
            return;
        }
        // Name and voice only ever come through /__display/meta, so a reconnect of the
        // stream never undoes a rename.
        let entry = state.client(&client);
        entry.slug = slug.clone();
        entry.connected = true;
        state.streams.push(Stream { client: client.clone(), slug, socket: writer });
        state.changed = true;
    }
    // Nothing more is read from the client; a read that returns means it has gone, a
    // timeout is the moment for a keep-alive.
    let _ = socket.set_read_timeout(Some(KEEP_ALIVE));
    let mut scratch = [0u8; 64];
    loop {
        match socket.read(&mut scratch) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if !running.load(SeqCst) || socket.write_all(b": keep-alive\n\n").is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
        if !running.load(SeqCst) {
            break;
        }
    }
    state.lock().unwrap().disconnect(&client, Some(peer));
}

/// The running server. Dropping it closes all streams and stops listening.
pub struct DisplayServer {
    state: Arc<Mutex<State>>,
    running: Arc<AtomicBool>,
    address: SocketAddr,
}

impl DisplayServer {
    /// Listen on `host:port`. Use `127.0.0.1` to stay on this computer; `0.0.0.0` or an
    /// adapter's address makes the displays reachable from the network.
    pub fn start(host: &str, port: u16) -> std::io::Result<DisplayServer> {
        let listener = TcpListener::bind((host, port))?;
        let address = listener.local_addr()?;
        let state = Arc::new(Mutex::new(State::default()));
        let running = Arc::new(AtomicBool::new(true));
        let (shared, flag) = (state.clone(), running.clone());
        let open = Arc::new(AtomicUsize::new(0));
        thread::Builder::new().name("mdstage-display".into()).spawn(move || {
            for socket in listener.incoming() {
                if !flag.load(SeqCst) {
                    break;
                }
                let Ok(socket) = socket else { continue };
                // Someone on the network opening connections without end gets no more threads.
                if open.fetch_add(1, SeqCst) >= MAX_CONNECTIONS {
                    open.fetch_sub(1, SeqCst);
                    continue;
                }
                let (state, running, open) = (shared.clone(), flag.clone(), open.clone());
                // One thread per connection: a handful of displays, each holding one stream.
                let spawned = thread::Builder::new().name("mdstage-display-client".into()).spawn({
                    let open = open.clone();
                    move || {
                        handle(socket, &state, &running);
                        open.fetch_sub(1, SeqCst);
                    }
                });
                if spawned.is_err() {
                    open.fetch_sub(1, SeqCst);
                }
            }
        })?;
        Ok(DisplayServer { state, running, address })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The show's `css/` folder, for custom stylesheets.
    pub fn set_css_dir(&self, dir: Option<PathBuf>) {
        self.state.lock().unwrap().css_dir = dir;
    }

    pub fn set_app_language(&self, language: &str) {
        self.state.lock().unwrap().app_language = language.into();
    }

    /// The configured display devices. Their settings reach connected clients at once.
    pub fn set_devices(&self, devices: &[DisplayDevice]) {
        let mut state = self.state.lock().unwrap();
        state.devices = devices.to_vec();
        for device in devices {
            let slug = slugify(&device.name);
            let mut content = state.content.get(&slug).cloned().unwrap_or_default();
            content.style = if device.style.is_empty() { "dark".into() } else { device.style.clone() };
            content.scroll_seconds = device.scroll_seconds;
            content.language = device.language.clone();
            if state.content.get(&slug) != Some(&content) {
                let event = content.event();
                state.content.insert(slug.clone(), content);
                state.push(&slug, &event);
            }
        }
    }

    /// Show markdown on a display (empty clears it).
    pub fn set_content(&self, device: &str, markdown: &str) {
        let mut state = self.state.lock().unwrap();
        let slug = slugify(device);
        let mut content = state.content.get(&slug).cloned().unwrap_or_else(|| Content { style: "dark".into(), ..Default::default() });
        content.html = render_markdown(markdown);
        if state.content.get(&slug) != Some(&content) {
            let event = content.event();
            state.content.insert(slug.clone(), content);
            state.push(&slug, &event);
        }
    }

    /// Have a display's clients speak an announcement.
    pub fn announce(&self, device: &str, text: &str) {
        let mut state = self.state.lock().unwrap();
        let slug = slugify(device);
        let mut event = json!({ "type": "announce", "text": text });
        if let Some(config) = state.devices.iter().find(|d| d.name == device).filter(|d| d.repeat) {
            event["repeat"] = json!(true);
            event["repeatPhrase"] = json!(repeat_phrase(&config.language, &state.app_language));
        }
        state.push(&slug, &event.to_string());
    }

    /// Every client seen so far, oldest first.
    pub fn clients(&self) -> Vec<Client> {
        self.state.lock().unwrap().clients.clone()
    }

    /// Whether the client list changed since this was last asked.
    pub fn take_clients_changed(&self) -> bool {
        std::mem::take(&mut self.state.lock().unwrap().changed)
    }
}

impl Drop for DisplayServer {
    fn drop(&mut self) {
        self.running.store(false, SeqCst);
        for stream in self.state.lock().unwrap().streams.drain(..) {
            let _ = stream.socket.shutdown(std::net::Shutdown::Both);
        }
        // Wake the accept loop so it sees the flag.
        let wake = if self.address.ip().is_unspecified() { SocketAddr::from(([127, 0, 0, 1], self.address.port())) } else { self.address };
        let _ = TcpStream::connect_timeout(&wake, Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Bühne Links"), "buehne-links");
        assert_eq!(slugify("  Foyer / Süd (2)  "), "foyer-sued-2");
        assert_eq!(slugify("Straße Café"), "strasse-cafe");
        assert_eq!(slugify("!!!"), "display");
    }

    #[test]
    fn repeat_phrases() {
        assert_eq!(repeat_phrase("en-GB", "de"), "I repeat");
        assert_eq!(repeat_phrase("", "en"), "I repeat");
        assert_eq!(repeat_phrase("xx", "yy"), "Ich wiederhole");
    }

    #[test]
    fn renders_only_harmless_html() {
        assert_eq!(render_markdown("# Scene 3\nCue in *4* **bars**"), "<h1>Scene 3</h1>\n<p>Cue in <em>4</em> <strong>bars</strong></p>\n");
        assert_eq!(render_markdown("- a\n- b"), "<ul><li>a</li>\n<li>b</li>\n</ul>\n");
        let hostile = render_markdown("<script>alert(1)</script>\n\n[click](javascript:alert(1)) ![x](http://evil/x.png) <b onclick=\"x\">y</b>");
        assert!(!hostile.contains("<script") && !hostile.contains("<a") && !hostile.contains("<img") && !hostile.contains("<b "), "{hostile}");
        assert!(hostile.contains("&lt;script&gt;") && hostile.contains("click"));
    }

    fn get(address: SocketAddr, path: &str) -> String {
        let mut socket = TcpStream::connect(address).unwrap();
        socket.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        response
    }

    /// Open an event stream and return the socket with its reader.
    fn events(address: SocketAddr, slug: &str, client: &str) -> BufReader<TcpStream> {
        let mut socket = TcpStream::connect(address).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        socket.write_all(format!("GET /__display/events/{slug}?clientId={client} HTTP/1.1\r\n\r\n").as_bytes()).unwrap();
        BufReader::new(socket)
    }

    fn next_event(reader: &mut BufReader<TcpStream>) -> serde_json::Value {
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0, "stream closed");
            if let Some(data) = line.strip_prefix("data: ") {
                return serde_json::from_str(data).unwrap();
            }
        }
    }

    fn device(name: &str) -> DisplayDevice {
        DisplayDevice { name: name.into(), style: "subtitle".into(), scroll_seconds: 8, language: "en".into(), repeat: true }
    }

    #[test]
    fn serves_pages_styles_and_the_index() {
        let server = DisplayServer::start("127.0.0.1", 0).unwrap();
        let address = server.address();
        assert!(get(address, "/").contains("Noch keine Display-Geräte"));
        server.set_devices(&[device("Bühne <Links>")]);
        let index = get(address, "/");
        assert!(index.contains("href=\"/buehne-links\"") && index.contains("Bühne &lt;Links&gt;"), "{index}");

        assert!(get(address, "/buehne-links").contains("/__display/app.js"));
        assert!(get(address, "/__display/app.js").starts_with("HTTP/1.1 200 OK\r\nContent-Type: application/javascript"));
        assert!(get(address, "/__display/style/subtitle").contains("background:#000000"));
        assert!(get(address, "/__display/style/nonexistent.css").contains("background:#1e222a"), "unknown styles fall back to dark");
        assert!(get(address, "/__display/style/..%2F..%2Fetc%2Fpasswd").contains("200 OK"), "a path is not a style name; it is just a page");
        assert!(get(address, "/%zz").starts_with("HTTP/1.1 400"));

        let dir = std::env::temp_dir().join(format!("mdstage-css-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("eigen.css"), "body{color:pink}").unwrap();
        server.set_css_dir(Some(dir.clone()));
        assert!(get(address, "/__display/style/eigen.css").ends_with("body{color:pink}"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn streams_content_announcements_and_presence() {
        let server = DisplayServer::start("127.0.0.1", 0).unwrap();
        server.set_app_language("de");
        server.set_devices(&[device("Foyer")]);
        server.set_content("Foyer", "# One");

        let mut stream = events(server.address(), "foyer", "tab-1");
        let first = next_event(&mut stream);
        assert_eq!(first, json!({ "type": "content", "html": "<h1>One</h1>\n", "style": "subtitle", "scrollSec": 8, "lang": "en" }));
        assert_eq!(server.clients(), [Client { id: "tab-1".into(), slug: "foyer".into(), name: String::new(), voice: String::new(), connected: true }]);
        assert!(server.take_clients_changed() && !server.take_clients_changed());

        server.set_content("Foyer", "# One"); // unchanged: nothing is sent
        server.set_content("Foyer", "Two");
        assert_eq!(next_event(&mut stream)["html"], "<p>Two</p>\n");
        server.announce("Foyer", "Standby");
        assert_eq!(next_event(&mut stream), json!({ "type": "announce", "text": "Standby", "repeat": true, "repeatPhrase": "I repeat" }));

        // The client names itself; a reconnecting stream keeps the name.
        get(server.address(), "/__display/meta?clientId=tab-1&name=Foyer%20links&voice=Anna");
        assert_eq!(server.clients()[0].name, "Foyer links");
        assert_eq!(server.clients()[0].voice, "Anna");

        drop(stream);
        let gone = (0..100).any(|_| {
            thread::sleep(Duration::from_millis(20));
            server.set_content("Foyer", &format!("{:?}", std::time::Instant::now()));
            !server.clients()[0].connected
        });
        assert!(gone, "a closed tab shows as disconnected");
        assert_eq!(server.clients()[0].name, "Foyer links", "but stays in the list");

        let mut again = events(server.address(), "foyer", "tab-1");
        next_event(&mut again);
        assert!(server.clients()[0].connected && server.clients().len() == 1);
    }

    #[test]
    fn stopping_the_server_closes_streams_and_frees_the_port() {
        let server = DisplayServer::start("127.0.0.1", 0).unwrap();
        let address = server.address();
        let mut stream = events(address, "x", "c");
        next_event(&mut stream);
        drop(server);
        let mut rest = String::new();
        let _ = stream.read_to_string(&mut rest);
        thread::sleep(Duration::from_millis(100));
        assert!(TcpListener::bind(address).is_ok(), "the port can be bound again");
    }
}
