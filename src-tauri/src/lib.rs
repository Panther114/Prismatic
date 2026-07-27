use lofty::{
    file::{AudioFile, TaggedFileExt},
    prelude::Accessor,
    probe::Probe,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
    formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};
use tauri::{AppHandle, Manager, State};
use walkdir::{DirEntry, WalkDir};

static GENERATION: AtomicU64 = AtomicU64::new(1);
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"];

#[derive(Debug, Clone)]
struct LibraryPaths {
    data_root: PathBuf,
    music_directory: PathBuf,
    state_directory: PathBuf,
    output_directory: PathBuf,
}

struct WatcherState(Mutex<RecommendedWatcher>);

impl LibraryPaths {
    fn resolve() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("Could not resolve your home directory")?;
        let data_root = std::env::var_os("PRISMATIC_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("Music").join("Prismatic"));
        let music_directory = std::env::var_os("PRISMATIC_MUSIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root.clone());
        let paths = Self {
            state_directory: data_root.join(".prismatic"),
            output_directory: data_root.join("output"),
            data_root,
            music_directory,
        };
        fs::create_dir_all(&paths.music_directory).map_err(display_err)?;
        fs::create_dir_all(&paths.state_directory).map_err(display_err)?;
        fs::create_dir_all(&paths.output_directory).map_err(display_err)?;
        Ok(paths)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchFolder {
    id: String,
    path: String,
    label: String,
    enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    watch_folders: Vec<WatchFolder>,
    hidden: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Override {
    title: Option<String>,
    artist: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTrack {
    id: String,
    source_id: String,
    file_name: String,
    relative_path: String,
    folder: String,
    media_path: String,
    cover_path: Option<String>,
    waveform_url: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    bitrate: Option<u32>,
    format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthInfo {
    ok: bool,
    name: &'static str,
    mode: &'static str,
    client_export: bool,
    desktop: bool,
    version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryMeta {
    generation: u64,
    watch_folders: Vec<WatchFolder>,
    music_directory: String,
    data_root: String,
    mode: &'static str,
    client_export: bool,
    shared_library: bool,
    offline_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Playlist {
    id: String,
    name: String,
    track_ids: Vec<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PlayerPrefs {
    schema_version: u8,
    shuffle: bool,
    repeat: String,
    volume: f64,
    muted: bool,
    visualizer_quality: String,
    resume_behavior: String,
    library_mode: String,
    library_sort: String,
    compact_player: bool,
}

impl Default for PlayerPrefs {
    fn default() -> Self {
        Self {
            schema_version: 2,
            shuffle: false,
            repeat: "off".into(),
            volume: 0.86,
            muted: false,
            visualizer_quality: "low".into(),
            resume_behavior: "track".into(),
            library_mode: "songs".into(),
            library_sort: "title".into(),
            compact_player: false,
        }
    }
}

fn display_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn sha1_hex(input: &str) -> String {
    format!("{:x}", Sha1::digest(input.as_bytes()))
}

fn source_id(path: &Path) -> String {
    sha1_hex(&path.to_string_lossy().to_lowercase())[..10].to_owned()
}

fn track_id(source: &str, relative: &str) -> String {
    let normalized = relative.replace('\\', "/").to_lowercase();
    sha1_hex(&format!("{source}:{normalized}"))[..14].to_owned()
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| AUDIO_EXTENSIONS.contains(&value.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn include_entry(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    if entry.depth() == 0 {
        return true;
    }
    if name.starts_with('.') {
        return false;
    }
    !matches!(
        name.to_lowercase().as_str(),
        "output" | "node_modules" | "dist" | "release" | "release-build"
    )
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(display_err)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(display_err)?;
    fs::write(path, format!("{text}\n")).map_err(display_err)
}

fn image_extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "png"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else {
        "jpg"
    }
}

fn cached_cover(paths: &LibraryPaths, id: &str, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let directory = paths.state_directory.join("covers");
    fs::create_dir_all(&directory).ok()?;
    let file = directory.join(format!("{id}.{}", image_extension(bytes)));
    if !file.exists() {
        fs::write(&file, bytes).ok()?;
    }
    Some(file.to_string_lossy().into_owned())
}

fn settings(paths: &LibraryPaths) -> Settings {
    read_json(&paths.state_directory.join("settings.json"))
}

fn sources(paths: &LibraryPaths, config: &Settings) -> Vec<(String, PathBuf, String)> {
    let mut result = vec![(
        "music".into(),
        paths.music_directory.clone(),
        "Shared library".into(),
    )];
    let default = paths.music_directory.to_string_lossy().to_lowercase();
    for folder in config.watch_folders.iter().filter(|folder| folder.enabled) {
        let path = PathBuf::from(&folder.path);
        if path.to_string_lossy().to_lowercase() != default {
            result.push((folder.id.clone(), path, folder.label.clone()));
        }
    }
    result
}

fn scan_tracks(paths: &LibraryPaths) -> Result<Vec<DesktopTrack>, String> {
    let config = settings(paths);
    let hidden: HashSet<&str> = config.hidden.iter().map(String::as_str).collect();
    let overrides: HashMap<String, Override> =
        read_json(&paths.state_directory.join("library.json"));
    let mut tracks = Vec::new();

    for (source, root, label) in sources(paths, &config) {
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(include_entry)
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file() && is_audio(entry.path()))
        {
            let path = entry.path();
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let id = track_id(&source, &relative);
            if hidden.contains(id.as_str()) {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled")
                .to_owned();
            let fallback_title = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled")
                .to_owned();

            let mut title = fallback_title;
            let mut artist = "Unknown artist".to_owned();
            let mut album = String::new();
            let mut duration = 0.0;
            let mut bitrate = None;
            let mut format = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("audio")
                .to_uppercase();
            let mut cover_path = None;

            if let Ok(tagged) = Probe::open(path).and_then(|probe| probe.read()) {
                let properties = tagged.properties();
                duration = properties.duration().as_secs_f64();
                bitrate = properties.audio_bitrate();
                format = format!("{:?}", tagged.file_type());
                if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                    title = tag.title().map(|value| value.into_owned()).unwrap_or(title);
                    artist = tag
                        .artist()
                        .map(|value| value.into_owned())
                        .unwrap_or(artist);
                    album = tag
                        .album()
                        .map(|value| value.into_owned())
                        .unwrap_or_default();
                    if let Some(picture) = tag.pictures().first() {
                        cover_path = cached_cover(paths, &id, picture.data());
                    }
                }
            }

            if let Some(change) = overrides.get(&id) {
                if let Some(value) = change
                    .title
                    .as_ref()
                    .filter(|value| !value.trim().is_empty())
                {
                    title = value.trim().to_owned();
                }
                if let Some(value) = change
                    .artist
                    .as_ref()
                    .filter(|value| !value.trim().is_empty())
                {
                    artist = value.trim().to_owned();
                }
            }

            let parent = Path::new(&relative)
                .parent()
                .filter(|value| !value.as_os_str().is_empty())
                .map(|value| format!("{label}/{}", value.to_string_lossy().replace('\\', "/")))
                .unwrap_or_else(|| label.clone());
            tracks.push(DesktopTrack {
                id: id.clone(),
                source_id: source.clone(),
                file_name,
                relative_path: relative,
                folder: parent,
                media_path: path.to_string_lossy().into_owned(),
                cover_path,
                waveform_url: format!("tauri-waveform:{id}"),
                title,
                artist,
                album,
                duration,
                bitrate,
                format,
            });
        }
    }
    tracks.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.artist.to_lowercase().cmp(&b.artist.to_lowercase()))
    });
    Ok(tracks)
}

fn find_track(paths: &LibraryPaths, id: &str) -> Result<DesktopTrack, String> {
    scan_tracks(paths)?
        .into_iter()
        .find(|track| track.id == id)
        .ok_or_else(|| "Track not found".into())
}

fn allow_library_scope(app: &AppHandle, paths: &LibraryPaths) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    scope
        .allow_directory(&paths.music_directory, true)
        .map_err(display_err)?;
    scope
        .allow_directory(&paths.state_directory, true)
        .map_err(display_err)?;
    for folder in settings(paths).watch_folders {
        if folder.enabled {
            scope
                .allow_directory(PathBuf::from(folder.path), true)
                .map_err(display_err)?;
        }
    }
    Ok(())
}

fn start_watcher(paths: &LibraryPaths) -> Result<WatcherState, String> {
    let mut watcher = notify::recommended_watcher(|event: notify::Result<notify::Event>| {
        if event.is_ok() {
            GENERATION.fetch_add(1, Ordering::Relaxed);
        }
    })
    .map_err(display_err)?;
    for (_, directory, _) in sources(paths, &settings(paths)) {
        if directory.is_dir() {
            watcher
                .watch(&directory, RecursiveMode::Recursive)
                .map_err(display_err)?;
        }
    }
    Ok(WatcherState(Mutex::new(watcher)))
}

#[tauri::command]
fn health() -> HealthInfo {
    HealthInfo {
        ok: true,
        name: "Prismatic",
        mode: "local",
        client_export: true,
        desktop: true,
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn tracks(paths: State<LibraryPaths>) -> Result<Vec<DesktopTrack>, String> {
    scan_tracks(&paths)
}

#[tauri::command]
fn library_meta(paths: State<LibraryPaths>) -> LibraryMeta {
    let config = settings(&paths);
    LibraryMeta {
        generation: GENERATION.load(Ordering::Relaxed),
        watch_folders: config.watch_folders,
        music_directory: paths.music_directory.to_string_lossy().into_owned(),
        data_root: paths.data_root.to_string_lossy().into_owned(),
        mode: "local",
        client_export: true,
        shared_library: true,
        offline_only: true,
    }
}

#[tauri::command]
fn update_track(
    paths: State<LibraryPaths>,
    id: String,
    title: String,
    artist: String,
) -> Result<DesktopTrack, String> {
    let mut overrides: HashMap<String, Override> =
        read_json(&paths.state_directory.join("library.json"));
    overrides.insert(
        id.clone(),
        Override {
            title: Some(title.trim().to_owned()),
            artist: Some(artist.trim().to_owned()),
        },
    );
    write_json(&paths.state_directory.join("library.json"), &overrides)?;
    GENERATION.fetch_add(1, Ordering::Relaxed);
    find_track(&paths, &id)
}

#[tauri::command]
fn remove_track(
    paths: State<LibraryPaths>,
    id: String,
    delete_file: bool,
) -> Result<Vec<DesktopTrack>, String> {
    let track = find_track(&paths, &id)?;
    if delete_file {
        fs::remove_file(&track.media_path).map_err(display_err)?;
    }
    let mut config = settings(&paths);
    if !config.hidden.contains(&id) {
        config.hidden.push(id);
        write_json(&paths.state_directory.join("settings.json"), &config)?;
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    scan_tracks(&paths)
}

fn copy_to_library(paths: &LibraryPaths, source: &Path) -> Result<Option<String>, String> {
    if !is_audio(source) {
        return Ok(None);
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid file name")?;
    let mut destination = paths.music_directory.join(name);
    if destination.exists() {
        let source_size = fs::metadata(source).map_err(display_err)?.len();
        let destination_size = fs::metadata(&destination).map_err(display_err)?.len();
        if source_size == destination_size {
            return Ok(None);
        }
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("audio");
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp3");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        destination = paths
            .music_directory
            .join(format!("{stem}-{suffix:x}.{extension}"));
    }
    fs::copy(source, &destination).map_err(display_err)?;
    Ok(destination
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned))
}

#[tauri::command]
fn import_paths(
    paths: State<LibraryPaths>,
    files: Vec<String>,
) -> Result<Vec<DesktopTrack>, String> {
    for file in files {
        copy_to_library(&paths, Path::new(&file))?;
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    scan_tracks(&paths)
}

#[tauri::command]
fn import_folder(
    paths: State<LibraryPaths>,
    folder_path: String,
    max_depth: usize,
) -> Result<Vec<DesktopTrack>, String> {
    let root = PathBuf::from(folder_path);
    if !root.is_dir() {
        return Err("Path is not a folder".into());
    }
    for entry in WalkDir::new(&root)
        .max_depth(max_depth.saturating_add(2))
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_audio(entry.path()))
    {
        copy_to_library(&paths, entry.path())?;
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    scan_tracks(&paths)
}

#[tauri::command]
fn add_watch_folder(
    app: AppHandle,
    paths: State<LibraryPaths>,
    watcher: State<WatcherState>,
    folder_path: String,
) -> Result<Vec<WatchFolder>, String> {
    let path = PathBuf::from(folder_path);
    if !path.is_dir() {
        return Err("Path is not a folder".into());
    }
    let canonical = path.canonicalize().map_err(display_err)?;
    let mut config = settings(&paths);
    let id = source_id(&canonical);
    if !config.watch_folders.iter().any(|folder| folder.id == id) {
        let label = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| canonical.to_string_lossy().into_owned());
        config.watch_folders.push(WatchFolder {
            id,
            path: canonical.to_string_lossy().into_owned(),
            label,
            enabled: true,
        });
        write_json(&paths.state_directory.join("settings.json"), &config)?;
        allow_library_scope(&app, &paths)?;
        watcher
            .0
            .lock()
            .map_err(display_err)?
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(display_err)?;
        GENERATION.fetch_add(1, Ordering::Relaxed);
    }
    Ok(config.watch_folders)
}

#[tauri::command]
fn remove_watch_folder(
    paths: State<LibraryPaths>,
    watcher: State<WatcherState>,
    id: String,
) -> Result<Vec<WatchFolder>, String> {
    let mut config = settings(&paths);
    let removed = config
        .watch_folders
        .iter()
        .find(|folder| folder.id == id)
        .map(|folder| PathBuf::from(&folder.path));
    config.watch_folders.retain(|folder| folder.id != id);
    write_json(&paths.state_directory.join("settings.json"), &config)?;
    if let Some(path) = removed {
        let _ = watcher.0.lock().map_err(display_err)?.unwatch(&path);
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    Ok(config.watch_folders)
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn playlists_path(paths: &LibraryPaths) -> PathBuf {
    paths.state_directory.join("playlists.json")
}

#[tauri::command]
fn playlists(paths: State<LibraryPaths>) -> Vec<Playlist> {
    read_json(&playlists_path(&paths))
}

#[tauri::command]
fn create_playlist(
    paths: State<LibraryPaths>,
    name: String,
    track_ids: Vec<String>,
) -> Result<Playlist, String> {
    let mut list: Vec<Playlist> = read_json(&playlists_path(&paths));
    let now = now_iso();
    let id_seed = format!("{}:{}:{}", name, now, list.len());
    let playlist = Playlist {
        id: format!("pl-{}", &sha1_hex(&id_seed)[..12]),
        name: if name.trim().is_empty() {
            "New playlist".into()
        } else {
            name.trim().into()
        },
        track_ids,
        created_at: now.clone(),
        updated_at: now,
    };
    list.push(playlist.clone());
    write_json(&playlists_path(&paths), &list)?;
    Ok(playlist)
}

#[tauri::command]
fn update_playlist(
    paths: State<LibraryPaths>,
    id: String,
    name: Option<String>,
    track_ids: Option<Vec<String>>,
) -> Result<Playlist, String> {
    let mut list: Vec<Playlist> = read_json(&playlists_path(&paths));
    let playlist = list
        .iter_mut()
        .find(|playlist| playlist.id == id)
        .ok_or("Playlist not found")?;
    if let Some(value) = name.filter(|value| !value.trim().is_empty()) {
        playlist.name = value.trim().into();
    }
    if let Some(value) = track_ids {
        playlist.track_ids = value;
    }
    playlist.updated_at = now_iso();
    let result = playlist.clone();
    write_json(&playlists_path(&paths), &list)?;
    Ok(result)
}

#[tauri::command]
fn delete_playlist(paths: State<LibraryPaths>, id: String) -> Result<Vec<Playlist>, String> {
    let mut list: Vec<Playlist> = read_json(&playlists_path(&paths));
    list.retain(|playlist| playlist.id != id);
    write_json(&playlists_path(&paths), &list)?;
    Ok(list)
}

#[tauri::command]
fn player_prefs(paths: State<LibraryPaths>) -> PlayerPrefs {
    read_json(&paths.state_directory.join("player.json"))
}

#[tauri::command]
fn save_player_prefs(
    paths: State<LibraryPaths>,
    prefs: PlayerPrefs,
) -> Result<PlayerPrefs, String> {
    write_json(&paths.state_directory.join("player.json"), &prefs)?;
    Ok(prefs)
}

fn decode_waveform(path: &Path, duration: f64) -> Result<Vec<f32>, String> {
    const BINS: usize = 512;
    let file = File::open(path).map_err(display_err)?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(display_err)?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "Audio has no decodable track".to_owned())?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let sample_rate = params.sample_rate.unwrap_or(44_100) as f64;
    let estimated_frames = params
        .n_frames
        .unwrap_or_else(|| (duration.max(1.0) * sample_rate) as u64)
        .max(1);
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(display_err)?;
    let mut peaks = vec![0.0_f32; BINS];
    let mut frame_index = 0_u64;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(display_err(error)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(display_err(error)),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        for frame in buffer.samples().chunks(channels) {
            let peak = frame
                .iter()
                .fold(0.0_f32, |value, sample| value.max(sample.abs()));
            let bin = ((frame_index.saturating_mul(BINS as u64)) / estimated_frames)
                .min(BINS as u64 - 1) as usize;
            peaks[bin] = peaks[bin].max(peak);
            frame_index = frame_index.saturating_add(1);
        }
    }
    Ok(peaks)
}

#[tauri::command]
fn waveform(paths: State<LibraryPaths>, id: String) -> Result<Vec<f32>, String> {
    let cache_directory = paths.state_directory.join("waveforms");
    let cache_path = cache_directory.join(format!("{id}.json"));
    if cache_path.is_file() {
        let cached: Vec<f32> = read_json(&cache_path);
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    let track = find_track(&paths, &id)?;
    let peaks = decode_waveform(Path::new(&track.media_path), track.duration)?;
    fs::create_dir_all(cache_directory).map_err(display_err)?;
    write_json(&cache_path, &peaks)?;
    Ok(peaks)
}

#[tauri::command]
fn output_directory(paths: State<LibraryPaths>) -> String {
    paths.output_directory.to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = LibraryPaths::resolve().expect("failed to initialize Prismatic library");
    let watcher = start_watcher(&paths).expect("failed to watch Prismatic library");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(paths.clone())
        .manage(watcher)
        .setup(move |app| {
            allow_library_scope(app.handle(), &paths)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            tracks,
            library_meta,
            update_track,
            remove_track,
            import_paths,
            import_folder,
            add_watch_folder,
            remove_watch_folder,
            playlists,
            create_playlist,
            update_playlist,
            delete_playlist,
            player_prefs,
            save_player_prefs,
            waveform,
            output_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prismatic");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_ids_match_the_legacy_typescript_algorithm() {
        assert_eq!(track_id("music", "Album\\Song.MP3"), "6e673eaf02e711");
        assert_eq!(
            track_id("music", "Album\\Song.MP3"),
            track_id("music", "album/song.mp3")
        );
    }

    #[test]
    fn only_supported_audio_extensions_are_scanned() {
        for name in [
            "track.mp3",
            "track.WAV",
            "track.flac",
            "track.m4a",
            "track.aac",
            "track.ogg",
            "track.opus",
        ] {
            assert!(is_audio(Path::new(name)), "{name}");
        }
        assert!(!is_audio(Path::new("cover.jpg")));
        assert!(!is_audio(Path::new("song.mp3.exe")));
    }

    #[test]
    fn cover_extension_detection_is_bounded_to_known_signatures() {
        assert_eq!(image_extension(b"\x89PNG\r\n"), "png");
        assert_eq!(image_extension(b"GIF89a"), "gif");
        assert_eq!(image_extension(b"unknown"), "jpg");
    }
}
