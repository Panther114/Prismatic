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
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
    formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};
use tauri::{AppHandle, Emitter, Manager, State};
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryClearResult {
    tracks: Vec<DesktopTrack>,
    playlists: Vec<Playlist>,
    watch_folders: Vec<WatchFolder>,
    deleted_managed_files: usize,
    preserved_external_files: usize,
    failed_managed_files: Vec<String>,
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

fn ensure_managed_path<'a>(managed_root: &Path, target: &'a Path) -> Result<&'a Path, String> {
    target
        .strip_prefix(managed_root)
        .map_err(|_| "Refusing to delete a file outside Prismatic's managed library".to_string())
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
    let ext = image_extension(bytes);
    let file = directory.join(format!("{id}.{ext}"));
    // Refresh when missing or when embedded art changed (size mismatch is a cheap proxy).
    let needs_write = match fs::metadata(&file) {
        Ok(meta) => meta.len() as usize != bytes.len(),
        Err(_) => true,
    };
    if needs_write {
        // Drop stale covers for this track that used a different extension.
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(&format!("{id}.")) && name != format!("{id}.{ext}") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        fs::write(&file, bytes).ok()?;
    }
    Some(file.to_string_lossy().into_owned())
}

/// After importing files into the managed music root, unhide matching track ids
/// so a re-import of a previously removed track becomes visible again.
fn unhide_imported_basenames(paths: &LibraryPaths, basenames: &[String]) -> Result<(), String> {
    if basenames.is_empty() {
        return Ok(());
    }
    let imported_ids: HashSet<String> = basenames
        .iter()
        .map(|name| track_id("music", name))
        .collect();
    let mut config = settings(paths);
    let before = config.hidden.len();
    config
        .hidden
        .retain(|id| !imported_ids.contains(id.as_str()));
    if config.hidden.len() != before {
        write_json(&paths.state_directory.join("settings.json"), &config)?;
    }
    Ok(())
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
    if delete_file && track.source_id == "music" {
        let managed_root = paths.music_directory.canonicalize().map_err(display_err)?;
        let target = PathBuf::from(&track.media_path)
            .canonicalize()
            .map_err(display_err)?;
        ensure_managed_path(&managed_root, &target)?;
        fs::remove_file(&target).map_err(display_err)?;
    }
    let mut config = settings(&paths);
    if !config.hidden.contains(&id) {
        config.hidden.push(id);
        write_json(&paths.state_directory.join("settings.json"), &config)?;
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    scan_tracks(&paths)
}

#[tauri::command]
fn clear_library(
    paths: State<LibraryPaths>,
    watcher: State<WatcherState>,
) -> Result<LibraryClearResult, String> {
    let tracks = scan_tracks(&paths)?;
    let managed_root = paths.music_directory.canonicalize().map_err(display_err)?;
    let mut deleted_managed_files = 0usize;
    let mut preserved_external_files = 0usize;
    let mut failed_managed_files = Vec::new();

    for track in tracks {
        if track.source_id != "music" {
            preserved_external_files += 1;
            continue;
        }
        let result = PathBuf::from(&track.media_path)
            .canonicalize()
            .map_err(display_err)
            .and_then(|target| {
                ensure_managed_path(&managed_root, &target)?;
                fs::remove_file(&target).map_err(display_err)
            });
        match result {
            Ok(()) => deleted_managed_files += 1,
            Err(error) => failed_managed_files.push(format!("{}: {error}", track.file_name)),
        }
    }

    let previous = settings(&paths);
    {
        let mut active_watcher = watcher.0.lock().map_err(display_err)?;
        for folder in previous.watch_folders {
            let _ = active_watcher.unwatch(Path::new(&folder.path));
        }
    }
    let config = Settings::default();
    write_json(&paths.state_directory.join("settings.json"), &config)?;
    write_json::<HashMap<String, Override>>(
        &paths.state_directory.join("library.json"),
        &HashMap::new(),
    )?;
    write_json::<Vec<Playlist>>(&playlists_path(&paths), &Vec::new())?;
    let _ = fs::remove_dir_all(paths.state_directory.join("covers"));
    let _ = fs::remove_dir_all(paths.state_directory.join("waveforms"));
    GENERATION.fetch_add(1, Ordering::Relaxed);

    Ok(LibraryClearResult {
        tracks: scan_tracks(&paths)?,
        playlists: Vec::new(),
        watch_folders: Vec::new(),
        deleted_managed_files,
        preserved_external_files,
        failed_managed_files,
    })
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
            // Already present — still return the basename so re-imports can unhide.
            return Ok(Some(name.to_owned()));
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
    let mut imported_names = Vec::new();
    for file in files {
        if let Some(name) = copy_to_library(&paths, Path::new(&file))? {
            imported_names.push(name);
        }
    }
    unhide_imported_basenames(&paths, &imported_names)?;
    GENERATION.fetch_add(1, Ordering::Relaxed);
    scan_tracks(&paths)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportBytesFile {
    file_name: String,
    bytes: Vec<u8>,
}

/// Write raw audio bytes into the managed library (playlist-share redeem on desktop).
#[tauri::command]
fn import_audio_bytes(
    paths: State<LibraryPaths>,
    files: Vec<ImportBytesFile>,
) -> Result<Vec<DesktopTrack>, String> {
    let mut imported_names = Vec::new();
    for file in files {
        let safe = Path::new(&file.file_name)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("track.mp3");
        if !is_audio(Path::new(safe)) {
            continue;
        }
        let mut destination = paths.music_directory.join(safe);
        if destination.exists() {
            let existing = fs::metadata(&destination).map_err(display_err)?.len();
            if existing == file.bytes.len() as u64 {
                imported_names.push(safe.to_owned());
                continue;
            }
            let stem = Path::new(safe)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("audio");
            let extension = Path::new(safe)
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
        fs::write(&destination, &file.bytes).map_err(display_err)?;
        if let Some(name) = destination
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
        {
            imported_names.push(name);
        }
    }
    unhide_imported_basenames(&paths, &imported_names)?;
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
    // WalkDir depth: 0 = root only (no children). Files in the chosen folder are depth 1.
    // UI depth 0 ⇒ only that folder; UI depth N ⇒ N subfolder levels under it.
    // So max_depth = folder_depth + 1 (not +2).
    let walk_depth = max_depth.saturating_add(1);
    let mut imported_names = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(walk_depth)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_audio(entry.path()))
    {
        // Enforce UI depth: parts under root (file depth = relative components after root − 1 for file).
        let rel = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path());
        let file_depth = rel.components().count().saturating_sub(1);
        if file_depth > max_depth {
            continue;
        }
        if let Some(name) = copy_to_library(&paths, entry.path())? {
            imported_names.push(name);
        }
    }
    unhide_imported_basenames(&paths, &imported_names)?;
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

/// Read raw audio bytes for playlist-share packing (avoids webview CSP fetch of asset://).
#[tauri::command]
fn read_track_bytes(paths: State<LibraryPaths>, id: String) -> Result<Vec<u8>, String> {
    let track = find_track(&paths, &id)?;
    let path = Path::new(&track.media_path);
    if !path.is_file() {
        return Err(format!("Audio file missing: {}", track.file_name));
    }
    if !is_audio(path) {
        return Err("Not an audio file".into());
    }
    // Bound size so a bad path cannot allocate multi-GB into IPC.
    let meta = fs::metadata(path).map_err(display_err)?;
    const MAX: u64 = 120 * 1024 * 1024;
    if meta.len() > MAX {
        return Err(format!(
            "Track “{}” is too large to share (max 120 MB per file).",
            track.title
        ));
    }
    fs::read(path).map_err(display_err)
}

const SHARE_MAX_TRACKS: usize = 25;
const SHARE_MAX_DURATION_SEC: f64 = 100.0 * 60.0;
const SHARE_MAX_TRACK_BYTES: u64 = 120 * 1024 * 1024;

fn normalize_share_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_owned()
}

fn share_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(45))
        .user_agent("Prismatic-Desktop/2.1")
        .build()
        .map_err(display_err)
}

fn emit_share_progress(app: Option<&AppHandle>, message: &str) {
    if let Some(app) = app {
        let _ = app.emit("share-progress", serde_json::json!({ "message": message }));
    }
}

/// Wake Railway Serverless host (retries on cold boot / connection errors).
fn share_wake_inner(app: Option<&AppHandle>, base_url: &str) -> Result<(), String> {
    let base = normalize_share_base(base_url);
    if base.is_empty() {
        return Err("Share host URL is empty".into());
    }
    let client = share_http_client()?;
    let health = format!("{base}/api/health");
    let mut last = String::from("no response");
    emit_share_progress(app, "Waking share server…");
    for attempt in 0..12 {
        if attempt > 0 {
            emit_share_progress(
                app,
                &format!("Waking share server… (try {}/12)", attempt + 1),
            );
        }
        match client.get(&health).send() {
            Ok(response) if response.status().is_success() => {
                emit_share_progress(app, "Share server ready.");
                return Ok(());
            }
            Ok(response) => {
                last = format!("HTTP {}", response.status().as_u16());
                let code = response.status().as_u16();
                if code < 500 && code != 502 && code != 503 && code != 504 {
                    return Err(format!("Share host health failed ({code})"));
                }
            }
            Err(error) => {
                last = error.to_string();
            }
        }
        thread::sleep(Duration::from_millis(1200 + attempt as u64 * 700));
    }
    Err(format!(
        "Share server did not wake at {base} after several tries ({last}). Is Railway Serverless still deploying?"
    ))
}

/// Non-blocking command wrapper — keeps the UI thread free during cold start.
#[tauri::command]
async fn share_wake(app: AppHandle, base_url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || share_wake_inner(Some(&app), &base_url))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareCreateResult {
    code: String,
    expires_at: String,
    track_count: u32,
    total_duration: f64,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareTrackMetaOut {
    file_name: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    bitrate: Option<u32>,
    format: String,
    content_type: String,
}

/// Pack library tracks and POST multipart share package via native HTTP (not WebView).
fn share_create_playlist_inner(
    app: Option<&AppHandle>,
    paths: &LibraryPaths,
    base_url: String,
    name: String,
    track_ids: Vec<String>,
) -> Result<ShareCreateResult, String> {
    if track_ids.is_empty() {
        return Err("Playlist is empty.".into());
    }
    if track_ids.len() > SHARE_MAX_TRACKS {
        return Err(format!(
            "Shared playlists are limited to {SHARE_MAX_TRACKS} tracks."
        ));
    }

    emit_share_progress(app, "Resolving playlist tracks…");
    let mut tracks = Vec::with_capacity(track_ids.len());
    let mut total_duration = 0.0_f64;
    for id in &track_ids {
        let track = find_track(paths, id)?;
        let path = Path::new(&track.media_path);
        if !path.is_file() {
            return Err(format!("Audio file missing: {}", track.file_name));
        }
        let size = fs::metadata(path).map_err(display_err)?.len();
        if size == 0 {
            return Err(format!("Track “{}” is empty.", track.title));
        }
        if size > SHARE_MAX_TRACK_BYTES {
            return Err(format!(
                "Track “{}” exceeds the per-file size limit.",
                track.title
            ));
        }
        total_duration += track.duration;
        tracks.push(track);
    }
    if total_duration >= SHARE_MAX_DURATION_SEC {
        return Err("Shared playlists must be under 100 minutes total.".into());
    }

    share_wake_inner(app, &base_url)?;

    let base = normalize_share_base(&base_url);
    let client = share_http_client()?;

    let playlist_name = if name.trim().is_empty() {
        "Shared playlist".to_owned()
    } else {
        name.trim().to_owned()
    };

    // Stream from disk (Part::file) — no full-library RAM copy / clone per retry.
    let mut meta: Vec<ShareTrackMetaOut> = Vec::with_capacity(tracks.len());
    let mut file_specs: Vec<(PathBuf, String, String)> = Vec::with_capacity(tracks.len());
    for track in &tracks {
        let path = PathBuf::from(&track.media_path);
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp3")
            .to_lowercase();
        let content_type = match ext.as_str() {
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "m4a" | "mp4" => "audio/mp4",
            "aac" => "audio/aac",
            "ogg" | "opus" => "audio/ogg",
            _ => "application/octet-stream",
        }
        .to_owned();
        meta.push(ShareTrackMetaOut {
            file_name: track.file_name.clone(),
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            duration: track.duration,
            bitrate: track.bitrate,
            format: track.format.clone(),
            content_type: content_type.clone(),
        });
        file_specs.push((path, track.file_name.clone(), content_type));
    }
    let meta_json = serde_json::to_string(&meta).map_err(display_err)?;

    let mut last_err = String::new();
    for attempt in 0..4 {
        let upload_status = if attempt == 0 {
            format!("Uploading {} tracks (streaming)…", tracks.len())
        } else {
            format!("Upload retry {}/4…", attempt + 1)
        };
        emit_share_progress(app, &upload_status);
        let mut form = reqwest::blocking::multipart::Form::new()
            .text("name", playlist_name.clone())
            .text("tracks", meta_json.clone());
        for (path, file_name, content_type) in &file_specs {
            let part = reqwest::blocking::multipart::Part::file(path)
                .map_err(display_err)?
                .file_name(file_name.clone())
                .mime_str(content_type)
                .map_err(display_err)?;
            form = form.part("audio", part);
        }

        match client
            .post(format!("{base}/api/playlist-share"))
            .multipart(form)
            .send()
        {
            Ok(response) => {
                let status = response.status();
                let text = response.text().unwrap_or_default();
                if status.is_success() {
                    let value: serde_json::Value =
                        serde_json::from_str(&text).map_err(display_err)?;
                    let code = value
                        .get("code")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_owned();
                    if code.len() != 4 {
                        return Err("Share host returned an invalid code.".into());
                    }
                    emit_share_progress(app, "Share code ready.");
                    return Ok(ShareCreateResult {
                        code,
                        expires_at: value
                            .get("expiresAt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_owned(),
                        track_count: value
                            .get("trackCount")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(tracks.len() as u64) as u32,
                        total_duration: value
                            .get("totalDuration")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(total_duration),
                        name: value
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&playlist_name)
                            .to_owned(),
                    });
                }
                last_err = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("error")
                            .and_then(|e| e.as_str())
                            .map(|s| s.to_owned())
                    })
                    .unwrap_or_else(|| format!("Share host error ({})", status.as_u16()));
                let code = status.as_u16();
                if code != 502 && code != 503 && code != 504 && code < 500 {
                    return Err(last_err);
                }
            }
            Err(error) => {
                last_err = error.to_string();
            }
        }
        if attempt + 1 < 4 {
            thread::sleep(Duration::from_millis(1200 + attempt as u64 * 800));
        }
    }
    Err(format!("Share upload failed after retries: {last_err}"))
}

/// Runs share packing/upload off the UI thread so the share dialog stays responsive.
#[tauri::command]
async fn share_create_playlist(
    app: AppHandle,
    paths: State<'_, LibraryPaths>,
    base_url: String,
    name: String,
    track_ids: Vec<String>,
) -> Result<ShareCreateResult, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        share_create_playlist_inner(Some(&app), &paths, base_url, name, track_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn share_get_manifest_inner(
    app: Option<&AppHandle>,
    base_url: &str,
    code: &str,
    do_wake: bool,
) -> Result<serde_json::Value, String> {
    if do_wake {
        share_wake_inner(app, base_url)?;
    }
    let base = normalize_share_base(base_url);
    let client = share_http_client()?;
    let url = format!("{base}/api/playlist-share/{}", code.trim());
    emit_share_progress(app, "Loading shared playlist…");
    let mut last = String::new();
    for attempt in 0..4 {
        match client.get(&url).send() {
            Ok(response) => {
                let status = response.status();
                let text = response.text().unwrap_or_default();
                if status.is_success() {
                    return serde_json::from_str(&text).map_err(display_err);
                }
                last = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("error")
                            .and_then(|e| e.as_str())
                            .map(|s| s.to_owned())
                    })
                    .unwrap_or_else(|| format!("Share host error ({})", status.as_u16()));
                let code_n = status.as_u16();
                if code_n != 502 && code_n != 503 && code_n != 504 && code_n < 500 {
                    return Err(last);
                }
            }
            Err(error) => last = error.to_string(),
        }
        thread::sleep(Duration::from_millis(800 + attempt as u64 * 500));
    }
    Err(format!("Could not load share: {last}"))
}

#[tauri::command]
async fn share_get_manifest(
    app: AppHandle,
    base_url: String,
    code: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        share_get_manifest_inner(Some(&app), &base_url, &code, true)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn share_download_track_inner(
    app: Option<&AppHandle>,
    base_url: &str,
    code: &str,
    index: u32,
    do_wake: bool,
) -> Result<Vec<u8>, String> {
    if do_wake {
        share_wake_inner(app, base_url)?;
    }
    let base = normalize_share_base(base_url);
    let client = share_http_client()?;
    let url = format!(
        "{base}/api/playlist-share/{}/tracks/{}",
        code.trim(),
        index
    );
    let mut last = String::new();
    for attempt in 0..4 {
        match client.get(&url).send() {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    return response.bytes().map(|b| b.to_vec()).map_err(display_err);
                }
                last = format!("HTTP {}", status.as_u16());
                let code_n = status.as_u16();
                if code_n != 502 && code_n != 503 && code_n != 504 && code_n < 500 {
                    return Err(format!("Download failed ({code_n})"));
                }
            }
            Err(error) => last = error.to_string(),
        }
        thread::sleep(Duration::from_millis(800 + attempt as u64 * 500));
    }
    Err(format!("Download failed after retries: {last}"))
}

/// `wake`: when false, skips host wake (caller already woke once for multi-track redeem).
#[tauri::command]
async fn share_download_track(
    app: AppHandle,
    base_url: String,
    code: String,
    index: u32,
    wake: Option<bool>,
) -> Result<Vec<u8>, String> {
    let do_wake = wake.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        share_download_track_inner(Some(&app), &base_url, &code, index, do_wake)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareRedeemResult {
    name: String,
    track_ids: Vec<String>,
    imported: u32,
    skipped: u32,
}

/// Wake once, download all tracks straight into the library folder (no multi-MB IPC).
fn share_redeem_to_library_inner(
    app: Option<&AppHandle>,
    paths: &LibraryPaths,
    base_url: String,
    code: String,
) -> Result<ShareRedeemResult, String> {
    let code = code.trim().to_owned();
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("Enter a 4-digit share code.".into());
    }

    share_wake_inner(app, &base_url)?;
    // Already awake — do not wake again for manifest or each track.
    let manifest = share_get_manifest_inner(app, &base_url, &code, false)?;
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Shared playlist")
        .to_owned();
    let tracks = manifest
        .get("tracks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if tracks.is_empty() {
        return Err("Shared playlist has no tracks.".into());
    }
    if tracks.len() > SHARE_MAX_TRACKS {
        return Err(format!(
            "Shared playlists are limited to {SHARE_MAX_TRACKS} tracks."
        ));
    }

    let mut imported_names = Vec::new();
    let mut skipped = 0u32;
    let mut imported = 0u32;

    for (i, row) in tracks.iter().enumerate() {
        let index = row
            .get("index")
            .and_then(|v| v.as_u64())
            .unwrap_or(i as u64) as u32;
        let file_name = row
            .get("fileName")
            .and_then(|v| v.as_str())
            .unwrap_or("track.mp3");
        let title = row
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(file_name);
        emit_share_progress(
            app,
            &format!("Downloading {}/{}: {title}", i + 1, tracks.len()),
        );
        // Already woke once above — do not re-wake per track (was ~30s each).
        let bytes = share_download_track_inner(app, &base_url, &code, index, false)?;
        if bytes.is_empty() {
            return Err(format!("Empty download for “{title}”."));
        }

        let safe = Path::new(file_name)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("track.mp3");
        if !is_audio(Path::new(safe)) {
            skipped += 1;
            continue;
        }

        let mut destination = paths.music_directory.join(safe);
        if destination.exists() {
            let existing = fs::metadata(&destination).map_err(display_err)?.len();
            if existing == bytes.len() as u64 {
                imported_names.push(safe.to_owned());
                skipped += 1;
                continue;
            }
            let stem = Path::new(safe)
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("audio");
            let extension = Path::new(safe)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("mp3");
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            destination = paths
                .music_directory
                .join(format!("{stem}-{suffix:x}.{extension}"));
        }
        fs::write(&destination, &bytes).map_err(display_err)?;
        if let Some(written) = destination
            .file_name()
            .and_then(|v| v.to_str())
            .map(ToOwned::to_owned)
        {
            imported_names.push(written);
            imported += 1;
        }
    }

    unhide_imported_basenames(paths, &imported_names)?;
    GENERATION.fetch_add(1, Ordering::Relaxed);
    emit_share_progress(app, "Scanning library…");
    let scanned = scan_tracks(paths)?;

    // Preserve share order when matching by file name.
    let mut track_ids = Vec::new();
    for name in &imported_names {
        if let Some(track) = scanned.iter().find(|t| &t.file_name == name) {
            if !track_ids.contains(&track.id) {
                track_ids.push(track.id.clone());
            }
        }
    }

    if track_ids.is_empty() {
        return Err("Tracks downloaded but none could be matched into the library.".into());
    }

    emit_share_progress(app, "Redeem complete.");
    Ok(ShareRedeemResult {
        name,
        track_ids,
        imported,
        skipped,
    })
}

#[tauri::command]
async fn share_redeem_to_library(
    app: AppHandle,
    paths: State<'_, LibraryPaths>,
    base_url: String,
    code: String,
) -> Result<ShareRedeemResult, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        share_redeem_to_library_inner(Some(&app), &paths, base_url, code)
    })
    .await
    .map_err(|error| error.to_string())?
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
        .plugin(tauri_plugin_process::init())
        .manage(paths.clone())
        .manage(watcher)
        .setup(move |app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            allow_library_scope(app.handle(), &paths)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            tracks,
            library_meta,
            update_track,
            remove_track,
            clear_library,
            import_paths,
            import_audio_bytes,
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
            read_track_bytes,
            share_wake,
            share_create_playlist,
            share_get_manifest,
            share_download_track,
            share_redeem_to_library,
            output_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prismatic");
}

#[cfg(test)]
mod deletion_tests {
    use super::ensure_managed_path;
    use std::path::Path;

    #[test]
    fn managed_path_guard_accepts_children() {
        // Use relative components so tests pass on Windows and Unix CI runners.
        let root = Path::new("Users").join("Example").join("Music").join("Prismatic");
        let track = root.join("song.mp3");
        assert!(ensure_managed_path(&root, &track).is_ok());
    }

    #[test]
    fn managed_path_guard_rejects_external_sources() {
        let root = Path::new("Users").join("Example").join("Music").join("Prismatic");
        let track = Path::new("Imported Music").join("song.mp3");
        assert!(ensure_managed_path(&root, &track).is_err());
    }
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
    fn reimport_track_id_matches_managed_basename() {
        // Soft-hidden ids use the same derivation as music-root basenames after import.
        assert_eq!(track_id("music", "Song.mp3"), track_id("music", "song.mp3"));
        assert_eq!(track_id("music", "Album/Track.flac").len(), 14);
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
