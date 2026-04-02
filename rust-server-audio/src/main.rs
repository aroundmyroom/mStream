use std::env;
use std::fs::File;
use std::io::BufReader;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use serde::{Deserialize, Serialize};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tiny_http::{Header, Method, Response, Server};

// ── Request / Response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct PlayRequest {
    file: String,
}

#[derive(Deserialize)]
struct AddManyRequest {
    files: Vec<String>,
}

#[derive(Deserialize)]
struct IndexRequest {
    index: usize,
}

#[derive(Deserialize)]
struct SeekRequest {
    position: f64,
}

#[derive(Deserialize)]
struct VolumeRequest {
    volume: f32,
}

#[derive(Serialize)]
struct StatusResponse {
    playing: bool,
    paused: bool,
    position: f64,
    duration: f64,
    volume: f32,
    file: String,
    queue_index: usize,
    queue_length: usize,
}

#[derive(Serialize)]
struct QueueResponse {
    queue: Vec<String>,
    current_index: usize,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

// ── Player state ────────────────────────────────────────────────────────────
// OutputStream is !Send, so we keep it on the main thread.
// SharedState holds only the Send-safe parts for cross-thread access.

struct SharedState {
    sink: Sink,
    current_file: String,
    duration: f64,
    queue: Vec<String>,
    queue_index: usize,
    stopped: bool, // true when user explicitly stopped (don't auto-advance)
}

/// Holds the OutputStream (must stay on the main thread) and the shared state.
struct Player {
    _stream: OutputStream,
    stream_handle: OutputStreamHandle,
    shared: Arc<Mutex<SharedState>>,
}

impl Player {
    fn new() -> Self {
        let (stream, stream_handle) = OutputStream::try_default()
            .expect("Failed to open audio output device");
        let sink = Sink::try_new(&stream_handle)
            .expect("Failed to create audio sink");

        let shared = Arc::new(Mutex::new(SharedState {
            sink,
            current_file: String::new(),
            duration: 0.0,
            queue: Vec::new(),
            queue_index: 0,
            stopped: true,
        }));

        Player {
            _stream: stream,
            stream_handle,
            shared,
        }
    }
}

/// Load and play the file at the current queue_index.
/// Needs the stream_handle to recreate the sink.
fn play_current(state: &mut SharedState, stream_handle: &OutputStreamHandle) -> bool {
    if state.queue_index >= state.queue.len() {
        return false;
    }

    let path = state.queue[state.queue_index].clone();

    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return false,
    };

    let reader = BufReader::new(file);
    let source = match Decoder::new(reader) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let duration = get_file_duration(&path);

    state.sink.stop();
    state.sink = Sink::try_new(stream_handle)
        .expect("Failed to create audio sink");

    state.sink.append(source);
    state.current_file = path;
    state.duration = duration;
    state.stopped = false;
    true
}

// ── Duration detection via symphonia ────────────────────────────────────────

fn get_file_duration(path: &str) -> f64 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 0.0,
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();

    let probed = match symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts) {
        Ok(p) => p,
        Err(_) => return 0.0,
    };

    let reader = probed.format;

    if let Some(track) = reader.default_track() {
        if let Some(n_frames) = track.codec_params.n_frames {
            if let Some(sample_rate) = track.codec_params.sample_rate {
                if sample_rate > 0 {
                    return n_frames as f64 / sample_rate as f64;
                }
            }
        }
        if let Some(tb) = track.codec_params.time_base {
            if let Some(n_frames) = track.codec_params.n_frames {
                let duration = tb.calc_time(n_frames);
                return duration.seconds as f64 + duration.frac;
            }
        }
    }

    0.0
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

fn json_response<T: Serialize>(data: &T) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(data).unwrap_or_default();
    let header = Header::from_bytes("Content-Type", "application/json").unwrap();
    Response::from_data(body).with_header(header)
}

fn error_response(msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let resp = ErrorResponse { error: msg.to_string() };
    let body = serde_json::to_vec(&resp).unwrap_or_default();
    let header = Header::from_bytes("Content-Type", "application/json").unwrap();
    Response::from_data(body).with_header(header).with_status_code(400)
}

fn read_body(request: &mut tiny_http::Request) -> Option<String> {
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).ok()?;
    if body.is_empty() { None } else { Some(body) }
}

// ── Request handlers ────────────────────────────────────────────────────────

type State = Arc<Mutex<SharedState>>;
type Resp = Response<std::io::Cursor<Vec<u8>>>;

fn handle_play(state: &State, sh: &OutputStreamHandle, body: &str) -> Resp {
    let req: PlayRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    let mut s = state.lock().unwrap();
    s.queue.clear();
    s.queue.push(req.file);
    s.queue_index = 0;

    if play_current(&mut s, sh) {
        json_response(&OkResponse { ok: true })
    } else {
        error_response("Failed to play file")
    }
}

fn handle_pause(state: &State) -> Resp {
    state.lock().unwrap().sink.pause();
    json_response(&OkResponse { ok: true })
}

fn handle_resume(state: &State) -> Resp {
    state.lock().unwrap().sink.play();
    json_response(&OkResponse { ok: true })
}

fn handle_stop(state: &State) -> Resp {
    let mut s = state.lock().unwrap();
    s.sink.stop();
    s.current_file.clear();
    s.duration = 0.0;
    s.stopped = true;
    json_response(&OkResponse { ok: true })
}

fn handle_seek(state: &State, body: &str) -> Resp {
    let req: SeekRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    let s = state.lock().unwrap();
    match s.sink.try_seek(Duration::from_secs_f64(req.position)) {
        Ok(_) => json_response(&OkResponse { ok: true }),
        Err(e) => error_response(&format!("Seek failed: {}", e)),
    }
}

fn handle_volume(state: &State, body: &str) -> Resp {
    let req: VolumeRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    state.lock().unwrap().sink.set_volume(req.volume.clamp(0.0, 1.0));
    json_response(&OkResponse { ok: true })
}

fn handle_status(state: &State) -> Resp {
    let s = state.lock().unwrap();
    let is_empty = s.sink.empty();
    let is_paused = s.sink.is_paused();

    let status = StatusResponse {
        playing: !is_empty && !is_paused,
        paused: is_paused,
        position: s.sink.get_pos().as_secs_f64(),
        duration: s.duration,
        volume: s.sink.volume(),
        file: s.current_file.clone(),
        queue_index: s.queue_index,
        queue_length: s.queue.len(),
    };

    json_response(&status)
}

fn handle_next(state: &State, sh: &OutputStreamHandle) -> Resp {
    let mut s = state.lock().unwrap();
    if s.queue_index + 1 >= s.queue.len() {
        return error_response("Already at end of queue");
    }
    s.queue_index += 1;
    if play_current(&mut s, sh) {
        json_response(&OkResponse { ok: true })
    } else {
        error_response("Failed to play next track")
    }
}

fn handle_previous(state: &State, sh: &OutputStreamHandle) -> Resp {
    let mut s = state.lock().unwrap();
    if s.queue_index == 0 {
        let _ = s.sink.try_seek(Duration::ZERO);
        return json_response(&OkResponse { ok: true });
    }
    s.queue_index -= 1;
    if play_current(&mut s, sh) {
        json_response(&OkResponse { ok: true })
    } else {
        error_response("Failed to play previous track")
    }
}

// ── Queue handlers ──────────────────────────────────────────────────────────

fn handle_queue_add(state: &State, sh: &OutputStreamHandle, body: &str) -> Resp {
    let req: PlayRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    let mut s = state.lock().unwrap();
    let was_empty = s.queue.is_empty();
    s.queue.push(req.file);

    if was_empty && s.sink.empty() {
        s.queue_index = 0;
        play_current(&mut s, sh);
    }

    json_response(&OkResponse { ok: true })
}

fn handle_queue_add_many(state: &State, sh: &OutputStreamHandle, body: &str) -> Resp {
    let req: AddManyRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    let mut s = state.lock().unwrap();
    let was_empty = s.queue.is_empty();
    s.queue.extend(req.files);

    if was_empty && s.sink.empty() {
        s.queue_index = 0;
        play_current(&mut s, sh);
    }

    json_response(&OkResponse { ok: true })
}

fn handle_queue_play_index(state: &State, sh: &OutputStreamHandle, body: &str) -> Resp {
    let req: IndexRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    let mut s = state.lock().unwrap();
    if req.index >= s.queue.len() {
        return error_response("Index out of bounds");
    }

    s.queue_index = req.index;
    if play_current(&mut s, sh) {
        json_response(&OkResponse { ok: true })
    } else {
        error_response("Failed to play track at index")
    }
}

fn handle_queue_remove(state: &State, sh: &OutputStreamHandle, body: &str) -> Resp {
    let req: IndexRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };

    let mut s = state.lock().unwrap();
    if req.index >= s.queue.len() {
        return error_response("Index out of bounds");
    }

    s.queue.remove(req.index);

    if s.queue.is_empty() {
        s.queue_index = 0;
        s.sink.stop();
        s.current_file.clear();
        s.duration = 0.0;
        s.stopped = true;
    } else if req.index < s.queue_index {
        s.queue_index -= 1;
    } else if req.index == s.queue_index {
        if s.queue_index >= s.queue.len() {
            s.queue_index = s.queue.len() - 1;
        }
        play_current(&mut s, sh);
    }

    json_response(&OkResponse { ok: true })
}

fn handle_queue_clear(state: &State) -> Resp {
    let mut s = state.lock().unwrap();
    s.sink.stop();
    s.queue.clear();
    s.queue_index = 0;
    s.current_file.clear();
    s.duration = 0.0;
    s.stopped = true;
    json_response(&OkResponse { ok: true })
}

fn handle_queue_get(state: &State) -> Resp {
    let s = state.lock().unwrap();
    json_response(&QueueResponse {
        queue: s.queue.clone(),
        current_index: s.queue_index,
    })
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut port: u16 = 3333;

    let mut i = 1;
    while i < args.len() {
        if args[i] == "--port" && i + 1 < args.len() {
            port = args[i + 1].parse().unwrap_or(3333);
            i += 2;
        } else {
            i += 1;
        }
    }

    let player = Player::new();
    let state = Arc::clone(&player.shared);
    let stream_handle = player.stream_handle;

    // Auto-advance runs on the main thread since OutputStreamHandle is !Send.
    // We use tiny_http's recv_timeout so the main loop polls for both HTTP requests
    // and auto-advance every 250ms.
    let addr = format!("0.0.0.0:{}", port);
    let server = Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("Failed to start server on {}: {}", addr, e);
        std::process::exit(1);
    });

    println!("rust-server-audio listening on http://0.0.0.0:{}", port);

    loop {
        // Check for auto-advance
        {
            let mut s = state.lock().unwrap();
            if s.sink.empty() && !s.stopped && !s.queue.is_empty() {
                let next_index = s.queue_index + 1;
                if next_index < s.queue.len() {
                    s.queue_index = next_index;
                    play_current(&mut s, &stream_handle);
                } else {
                    s.stopped = true;
                    s.current_file.clear();
                    s.duration = 0.0;
                }
            }
        }

        // Poll for HTTP request with 250ms timeout
        let request = server.recv_timeout(Duration::from_millis(250));
        let mut request = match request {
            Ok(Some(r)) => r,
            Ok(None) => continue,    // timeout, loop back to auto-advance check
            Err(_) => continue,
        };

        let method = request.method().clone();
        let path = request.url().to_string();
        let body = read_body(&mut request);

        let response = match (method, path.as_str()) {
            // Playback controls
            (Method::Post, "/play") => match body {
                Some(b) => handle_play(&state, &stream_handle, &b),
                None => error_response("Missing request body"),
            },
            (Method::Post, "/pause")    => handle_pause(&state),
            (Method::Post, "/resume")   => handle_resume(&state),
            (Method::Post, "/stop")     => handle_stop(&state),
            (Method::Post, "/next")     => handle_next(&state, &stream_handle),
            (Method::Post, "/previous") => handle_previous(&state, &stream_handle),
            (Method::Post, "/seek") => match body {
                Some(b) => handle_seek(&state, &b),
                None => error_response("Missing request body"),
            },
            (Method::Post, "/volume") => match body {
                Some(b) => handle_volume(&state, &b),
                None => error_response("Missing request body"),
            },
            (Method::Get, "/status") => handle_status(&state),

            // Queue management
            (Method::Post, "/queue/add") => match body {
                Some(b) => handle_queue_add(&state, &stream_handle, &b),
                None => error_response("Missing request body"),
            },
            (Method::Post, "/queue/add-many") => match body {
                Some(b) => handle_queue_add_many(&state, &stream_handle, &b),
                None => error_response("Missing request body"),
            },
            (Method::Post, "/queue/play-index") => match body {
                Some(b) => handle_queue_play_index(&state, &stream_handle, &b),
                None => error_response("Missing request body"),
            },
            (Method::Post, "/queue/remove") => match body {
                Some(b) => handle_queue_remove(&state, &stream_handle, &b),
                None => error_response("Missing request body"),
            },
            (Method::Post, "/queue/clear") => handle_queue_clear(&state),
            (Method::Get, "/queue")         => handle_queue_get(&state),

            // 404
            _ => {
                let resp = ErrorResponse { error: "Not found".to_string() };
                let body_bytes = serde_json::to_vec(&resp).unwrap_or_default();
                let header = Header::from_bytes("Content-Type", "application/json").unwrap();
                Response::from_data(body_bytes).with_header(header).with_status_code(404)
            }
        };

        let _ = request.respond(response);
    }
}
