use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue};
use lofty::picture::MimeType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;
use walkdir::WalkDir;

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ScanConfig {
    vpath: String,
    directory: String,
    port: u16,
    token: String,
    pause: u64,
    #[serde(rename = "skipImg")]
    skip_img: bool,
    #[serde(rename = "albumArtDirectory")]
    album_art_directory: String,
    #[serde(rename = "scanId")]
    scan_id: String,
    #[serde(rename = "isHttps")]
    is_https: bool,
    #[serde(rename = "compressImage")]
    compress_image: bool,
    #[serde(rename = "supportedFiles")]
    supported_files: HashMap<String, bool>,
}

// ── Typed HTTP request bodies (avoids serde_json::Value allocation per call) ──

#[derive(Serialize)]
struct GetFileReq<'a> {
    filepath: &'a str,
    vpath: &'a str,
    #[serde(rename = "modTime")]
    mod_time: u64,
    #[serde(rename = "scanId")]
    scan_id: &'a str,
}

#[derive(Serialize)]
struct FinishScanReq<'a> {
    vpath: &'a str,
    #[serde(rename = "scanId")]
    scan_id: &'a str,
}

// ── Output record sent to add-file API ───────────────────────────────────────

#[derive(Serialize)]
struct FileEntry {
    title: Option<String>,
    artist: Option<String>,
    year: Option<u32>,
    album: Option<String>,
    filepath: String,
    format: String,
    track: Option<u32>,
    disk: Option<u32>,
    modified: u64,
    hash: String,
    #[serde(rename = "aaFile")]
    aa_file: Option<String>,
    vpath: Arc<str>,
    ts: u64,
    #[serde(rename = "sID")]
    scan_id: Arc<str>,
    #[serde(rename = "replaygainTrackDb")]
    replaygain_track_db: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    genre: Option<String>,
}

// ── Shared context cloned cheaply into each task ──────────────────────────────

#[derive(Clone)]
struct Ctx {
    config: Arc<ScanConfig>,
    client: reqwest::Client,
    get_file_url: Arc<str>,
    add_file_url: Arc<str>,
    finish_scan_url: Arc<str>,
    /// Per-directory album art cache; only held during quick lookups/inserts.
    dir_art_cache: Arc<Mutex<HashMap<String, Option<String>>>>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let json_str = match args.last() {
        Some(s) if args.len() > 1 => s.clone(),
        _ => {
            eprintln!("Warning: failed to parse JSON input");
            std::process::exit(1);
        }
    };

    let config: ScanConfig = match serde_json::from_str(&json_str) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Invalid JSON Input: {}", e);
            std::process::exit(1);
        }
    };

    let scheme = if config.is_https { "https" } else { "http" };
    let base_url = format!("{}://localhost:{}", scheme, config.port);

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("Failed to build HTTP client");

    if let Err(e) = run_scan(config, client, &base_url).await {
        eprintln!("Scan Failed\n{}", e);
    }
}

// ── Main scan loop ────────────────────────────────────────────────────────────

async fn run_scan(
    config: ScanConfig,
    client: reqwest::Client,
    base_url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let ctx = Ctx {
        get_file_url: format!("{}/api/v1/scanner/get-file", base_url).into(),
        add_file_url: format!("{}/api/v1/scanner/add-file", base_url).into(),
        finish_scan_url: format!("{}/api/v1/scanner/finish-scan", base_url).into(),
        config: Arc::new(config),
        client,
        dir_art_cache: Arc::new(Mutex::new(HashMap::new())),
    };

    // Collect files first (sync walk is fast, avoids async complexity)
    let entries: Vec<walkdir::DirEntry> = WalkDir::new(&ctx.config.directory)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .collect();

    if ctx.config.pause > 0 {
        // Sequential mode: preserve exact inter-file pause timing
        run_sequential(entries, &ctx).await;
    } else {
        // Concurrent mode: saturate CPU + I/O
        run_concurrent(entries, ctx.clone()).await;
    }

    ctx.client
        .post(ctx.finish_scan_url.as_ref())
        .header("accept", "application/json")
        .header("x-access-token", &ctx.config.token)
        .json(&FinishScanReq {
            vpath: &ctx.config.vpath,
            scan_id: &ctx.config.scan_id,
        })
        .send()
        .await?;

    Ok(())
}

// ── Concurrent processing (pause == 0) ───────────────────────────────────────

async fn run_concurrent(entries: Vec<walkdir::DirEntry>, ctx: Ctx) {
    // Allow up to 2× logical CPUs concurrent tasks so both I/O and CPU stay busy.
    let parallelism = std::thread::available_parallelism()
        .map(|n| n.get() * 2)
        .unwrap_or(8);
    let sem = Arc::new(Semaphore::new(parallelism));

    let mut handles = Vec::with_capacity(entries.len());

    for entry in entries {
        let ext = file_ext(entry.path()).to_lowercase();
        if !ctx.config.supported_files.get(&ext).copied().unwrap_or(false) {
            continue;
        }

        let permit = Arc::clone(&sem).acquire_owned().await.expect("semaphore closed");
        let ctx = ctx.clone();
        let ext = ext.clone();

        handles.push(tokio::spawn(async move {
            let _permit = permit; // released when task ends
            process_one(entry, ext, ctx).await;
        }));
    }

    for h in handles {
        let _ = h.await;
    }
}

// ── Sequential processing (pause > 0) ────────────────────────────────────────

async fn run_sequential(entries: Vec<walkdir::DirEntry>, ctx: &Ctx) {
    for entry in entries {
        let ext = file_ext(entry.path()).to_lowercase();
        if !ctx.config.supported_files.get(&ext).copied().unwrap_or(false) {
            continue;
        }
        process_one(entry, ext, ctx.clone()).await;
        tokio::time::sleep(tokio::time::Duration::from_millis(ctx.config.pause)).await;
    }
}

// ── Per-file pipeline ─────────────────────────────────────────────────────────

async fn process_one(entry: walkdir::DirEntry, ext: String, ctx: Ctx) {
    let filepath = entry.path().to_path_buf();

    let mod_time = match entry.metadata() {
        Ok(m) => m
            .modified()
            .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
            .unwrap_or(0),
        Err(_) => return,
    };

    let rel_path = match filepath.strip_prefix(&ctx.config.directory) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return,
    };

    // ── 1. Check if already indexed (async HTTP) ──────────────────────────────
    let check = ctx
        .client
        .post(ctx.get_file_url.as_ref())
        .header("accept", "application/json")
        .header("x-access-token", &ctx.config.token)
        .json(&GetFileReq {
            filepath: &rel_path,
            vpath: &ctx.config.vpath,
            mod_time,
            scan_id: &ctx.config.scan_id,
        })
        .send()
        .await;

    match check {
        Ok(resp) => {
            if let Ok(data) = resp.json::<Value>().await {
                if data.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                    return; // already in DB
                }
            }
        }
        Err(e) => {
            eprintln!("Warning: failed to check file {}: {}", filepath.display(), e);
            return;
        }
    }

    // ── 2. Parse metadata + hash + album art (blocking CPU/IO) ────────────────
    let entry_data = {
        let config = Arc::clone(&ctx.config);
        let cache = Arc::clone(&ctx.dir_art_cache);
        let fp = filepath.clone();

        match tokio::task::spawn_blocking(move || {
            parse_file(&fp, mod_time, &rel_path, &ext, &config, &cache)
        })
        .await
        {
            Ok(Ok(e)) => e,
            Ok(Err(e)) => {
                eprintln!(
                    "Warning: failed to add file {} to database: {}",
                    filepath.display(),
                    e
                );
                return;
            }
            Err(e) => {
                eprintln!("Warning: task panicked for {}: {}", filepath.display(), e);
                return;
            }
        }
    };

    // ── 3. POST metadata to DB (async HTTP) ───────────────────────────────────
    if let Err(e) = ctx
        .client
        .post(ctx.add_file_url.as_ref())
        .header("accept", "application/json")
        .header("x-access-token", &ctx.config.token)
        .json(&entry_data)
        .send()
        .await
    {
        eprintln!(
            "Warning: failed to add file {} to database: {}",
            filepath.display(),
            e
        );
    }
}

// ── Per-file metadata extraction (runs on blocking thread pool) ───────────────

fn parse_file(
    filepath: &Path,
    mod_time: u64,
    rel_path: &str,
    ext: &str,
    config: &ScanConfig,
    dir_art_cache: &Arc<Mutex<HashMap<String, Option<String>>>>,
) -> Result<FileEntry, Box<dyn std::error::Error + Send + Sync>> {
    let mut title = None;
    let mut artist = None;
    let mut album = None;
    let mut year = None;
    let mut track = None;
    let mut disk = None;
    let mut genre = None;
    let mut replaygain_track_db = None;
    let mut aa_file: Option<String> = None;

    match Probe::open(filepath).and_then(|p| p.read()) {
        Ok(tagged_file) => {
            let tag = tagged_file
                .primary_tag()
                .or_else(|| tagged_file.first_tag());

            if let Some(tag) = tag {
                title = tag.title().map(|s| s.to_string());
                artist = tag.artist().map(|s| s.to_string());
                album = tag.album().map(|s| s.to_string());
                year = tag.year();
                track = tag.track();
                disk = tag.disk();
                genre = tag.genre().map(|s| s.to_string());

                replaygain_track_db = tag
                    .get(&ItemKey::ReplayGainTrackGain)
                    .and_then(|item| {
                        if let ItemValue::Text(s) = item.value() {
                            parse_replaygain_db(s)
                        } else {
                            None
                        }
                    });

                if !config.skip_img {
                    if let Some(pic) = tag.pictures().first() {
                        aa_file = save_embedded_art(pic, config);
                    }
                }
            }
        }
        Err(e) => {
            eprintln!(
                "Warning: metadata parse error on {}: {}",
                filepath.display(),
                e
            );
        }
    }

    if aa_file.is_none() && !config.skip_img {
        aa_file = check_directory_for_album_art(filepath, config, dir_art_cache);
    }

    let hash = calculate_hash(filepath)?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    Ok(FileEntry {
        title,
        artist,
        year,
        album,
        filepath: rel_path.to_string(),
        format: ext.to_string(),
        track,
        disk,
        modified: mod_time,
        hash,
        aa_file,
        vpath: config.vpath.as_str().into(),
        ts,
        scan_id: config.scan_id.as_str().into(),
        replaygain_track_db,
        genre,
    })
}

// ── MD5 hash (streaming 64KB chunks, no full-file allocation) ─────────────────

fn calculate_hash(
    filepath: &Path,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let mut file = fs::File::open(filepath)?;
    let mut ctx = md5::Context::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.consume(&buf[..n]);
    }
    Ok(format!("{:x}", ctx.compute()))
}

// ── Album art: embedded ───────────────────────────────────────────────────────

fn save_embedded_art(pic: &lofty::picture::Picture, config: &ScanConfig) -> Option<String> {
    let data = pic.data();
    let ext = pic.mime_type().map(mime_to_ext).unwrap_or("jpeg");
    let hash = format!("{:x}", md5::compute(data));
    let filename = format!("{}.{}", hash, ext);
    let art_path = Path::new(&config.album_art_directory).join(&filename);

    if !art_path.exists() {
        fs::write(&art_path, data).ok()?;
        if config.compress_image {
            compress_album_art(data, &filename, &config.album_art_directory);
        }
    }

    Some(filename)
}

// ── Album art: directory fallback ─────────────────────────────────────────────

fn check_directory_for_album_art(
    filepath: &Path,
    config: &ScanConfig,
    cache: &Arc<Mutex<HashMap<String, Option<String>>>>,
) -> Option<String> {
    let dir = filepath.parent()?;
    let dir_key = dir.to_string_lossy().to_string();

    // Fast path: cache hit (lock held only for this lookup)
    {
        let guard = cache.lock().unwrap();
        if let Some(cached) = guard.get(&dir_key) {
            return cached.clone();
        }
    }

    // Slow path: scan directory for images (no lock held during I/O)
    let mut images: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let e = file_ext(&p).to_lowercase();
                if e == "jpg" || e == "png" {
                    images.push(p);
                }
            }
        }
    }

    if images.is_empty() {
        cache.lock().unwrap().insert(dir_key, None);
        return None;
    }

    const PRIORITY: &[&str] = &[
        "folder.jpg", "cover.jpg", "album.jpg",
        "folder.png", "cover.png", "album.png",
    ];
    let chosen = images
        .iter()
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| PRIORITY.contains(&n.to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .unwrap_or(&images[0]);

    let data = match fs::read(chosen) {
        Ok(d) => d,
        Err(_) => {
            cache.lock().unwrap().insert(dir_key, None);
            return None;
        }
    };

    let ext = file_ext(chosen).to_lowercase();
    let hash = format!("{:x}", md5::compute(&data));
    let filename = format!("{}.{}", hash, ext);
    let art_path = Path::new(&config.album_art_directory).join(&filename);
    let is_new = !art_path.exists();

    if is_new && fs::write(&art_path, &data).is_err() {
        cache.lock().unwrap().insert(dir_key, None);
        return None;
    }

    // Re-check cache before inserting: another concurrent task may have beaten us
    {
        let mut guard = cache.lock().unwrap();
        guard.entry(dir_key).or_insert_with(|| Some(filename.clone()));
    }

    if is_new && config.compress_image {
        compress_album_art(&data, &filename, &config.album_art_directory);
    }

    Some(filename)
}

// ── Album art: compression (zl- 256×256, zs- 92×92) ─────────────────────────
// Decode once; produce small thumbnail from the already-scaled large one.

fn compress_album_art(data: &[u8], filename: &str, art_dir: &str) {
    let Ok(img) = image::load_from_memory(data) else {
        return;
    };
    let base = Path::new(art_dir);
    let large = img.thumbnail(256, 256);
    // Resize from 256 → 92 instead of re-decoding original
    let _ = large.thumbnail(92, 92).save(base.join(format!("zs-{}", filename)));
    let _ = large.save(base.join(format!("zl-{}", filename)));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn file_ext(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string()
}

fn mime_to_ext(mime: &MimeType) -> &'static str {
    match mime {
        MimeType::Jpeg => "jpeg",
        MimeType::Png => "png",
        MimeType::Tiff => "tiff",
        MimeType::Bmp => "bmp",
        MimeType::Gif => "gif",
        _ => "jpeg",
    }
}

fn parse_replaygain_db(s: &str) -> Option<f64> {
    s.trim().split_whitespace().next()?.parse::<f64>().ok()
}
