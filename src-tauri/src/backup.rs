//! Whole-library backup: one zip holding every audio file plus a manifest with
//! playlists, title/artist edits and player preferences. Restoring merges into
//! the existing library, deduplicating audio by content hash.

use super::*;
use std::{io::Write as _, sync::atomic::AtomicBool};

const FORMAT_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024 * 1024;

static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct BackupTrack {
    id: String,
    file: String,
    entry: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    sha1: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct BackupManifest {
    kind: String,
    format_version: u32,
    app_version: String,
    created_at: String,
    includes_audio: bool,
    tracks: Vec<BackupTrack>,
    playlists: Vec<Playlist>,
    overrides: HashMap<String, Override>,
    prefs: Option<PlayerPrefs>,
    watch_folders: Vec<WatchFolder>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportOptions {
    include_audio: bool,
    include_playlists: bool,
    include_settings: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportOptions {
    restore_playlists: bool,
    restore_settings: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    path: String,
    tracks: u32,
    bytes: u64,
    missing: Vec<String>,
    cancelled: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportResult {
    tracks_added: u32,
    tracks_duplicate: u32,
    tracks_failed: Vec<String>,
    playlists_added: u32,
    playlists_skipped: u32,
    settings_restored: bool,
    created_at: String,
    cancelled: bool,
}

fn cancelled() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

/// Audio that is already compressed gains nothing from deflate and costs CPU.
fn is_precompressed(path: &str) -> bool {
    !matches!(
        Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("wav")
    )
}

fn unique_name(used: &mut HashSet<String>, wanted: String) -> String {
    if used.insert(wanted.to_lowercase()) {
        return wanted;
    }
    let stem = Path::new(&wanted)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("track")
        .to_owned();
    let ext = Path::new(&wanted)
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    let mut n = 2;
    loop {
        let candidate = format!("{stem}-{n}{ext}");
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
        n += 1;
    }
}

fn export_inner(
    app: Option<&AppHandle>,
    paths: &LibraryPaths,
    dest_path: String,
    options: BackupExportOptions,
) -> Result<BackupExportResult, String> {
    CANCEL.store(false, Ordering::Relaxed);
    emit_zip_progress(app, "Scanning library…", Some(0.01));
    let tracks = scan_tracks(paths)?;
    let config = settings(paths);
    let overrides: HashMap<String, Override> =
        read_json(&paths.state_directory.join("library.json"));

    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(display_err)?;
    }
    // Write to a sibling temp file so a cancelled or failed run never leaves a
    // half-written archive at the chosen path.
    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".partial");
    let tmp = PathBuf::from(tmp_name);

    let result = (|| -> Result<BackupExportResult, String> {
        let file = File::create(&tmp).map_err(display_err)?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
        let mut manifest = BackupManifest {
            kind: "prismatic-library-backup".into(),
            format_version: FORMAT_VERSION,
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: now_iso(),
            includes_audio: options.include_audio,
            ..Default::default()
        };
        let mut missing = Vec::new();
        let mut bytes = 0u64;
        let mut used = HashSet::new();
        let total = tracks.len().max(1);

        for (index, track) in tracks.iter().enumerate() {
            if cancelled() {
                return Ok(BackupExportResult {
                    path: dest_path.clone(),
                    tracks: 0,
                    bytes,
                    missing,
                    cancelled: true,
                });
            }
            let source = Path::new(&track.media_path);
            let mut entry = BackupTrack {
                id: track.id.clone(),
                file: track.file_name.clone(),
                title: track.title.clone(),
                artist: track.artist.clone(),
                album: track.album.clone(),
                duration: track.duration,
                ..Default::default()
            };
            if options.include_audio {
                if !source.is_file() {
                    missing.push(track.file_name.clone());
                    continue;
                }
                emit_zip_progress(
                    app,
                    &format!("Adding {}/{}: {}", index + 1, total, track.title),
                    Some(0.03 + (index as f64 / total as f64) * 0.92),
                );
                let name = unique_name(&mut used, safe_zip_entry_name(&track.file_name, index));
                let entry_name = format!("audio/{name}");
                let size = fs::metadata(source).map_err(display_err)?.len();
                let method = if is_precompressed(&track.file_name) {
                    zip::CompressionMethod::Stored
                } else {
                    zip::CompressionMethod::Deflated
                };
                let opts = zip::write::SimpleFileOptions::default()
                    .compression_method(method)
                    .large_file(size >= u32::MAX as u64);
                zip.start_file(&entry_name, opts).map_err(display_err)?;
                let mut src = File::open(source).map_err(display_err)?;
                let mut hasher = Sha1::new();
                let mut buffer = vec![0u8; 256 * 1024];
                loop {
                    if cancelled() {
                        return Ok(BackupExportResult {
                            path: dest_path.clone(),
                            tracks: 0,
                            bytes,
                            missing,
                            cancelled: true,
                        });
                    }
                    let read = src.read(&mut buffer).map_err(display_err)?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                    zip.write_all(&buffer[..read]).map_err(display_err)?;
                    bytes += read as u64;
                }
                entry.sha1 = format!("{:x}", hasher.finalize());
                entry.entry = entry_name;
            }
            manifest.tracks.push(entry);
        }

        let kept: HashSet<&str> = manifest.tracks.iter().map(|t| t.id.as_str()).collect();
        manifest.overrides = overrides
            .into_iter()
            .filter(|(id, _)| kept.contains(id.as_str()))
            .collect();
        if options.include_playlists {
            manifest.playlists = read_json(&playlists_path(paths));
        }
        if options.include_settings {
            manifest.prefs = Some(read_json(&paths.state_directory.join("player.json")));
            manifest.watch_folders = config.watch_folders;
        }

        emit_zip_progress(app, "Writing manifest…", Some(0.97));
        zip.start_file(
            MANIFEST_NAME,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(display_err)?;
        let text = serde_json::to_vec_pretty(&manifest).map_err(display_err)?;
        zip.write_all(&text).map_err(display_err)?;
        zip.finish().map_err(display_err)?;

        let count = manifest.tracks.len() as u32;
        Ok(BackupExportResult {
            path: dest_path.clone(),
            tracks: count,
            bytes,
            missing,
            cancelled: false,
        })
    })();

    match result {
        Ok(done) if !done.cancelled => {
            if dest.exists() {
                fs::remove_file(&dest).map_err(display_err)?;
            }
            fs::rename(&tmp, &dest).map_err(display_err)?;
            emit_zip_progress(app, "Backup complete.", Some(1.0));
            Ok(done)
        }
        other => {
            let _ = fs::remove_file(&tmp);
            other
        }
    }
}

fn read_manifest(archive: &mut zip::ZipArchive<File>) -> Result<BackupManifest, String> {
    let entry = archive
        .by_name(MANIFEST_NAME)
        .map_err(|_| "This zip is not a Prismatic library backup (manifest.json missing).")?;
    if entry.size() > MAX_MANIFEST_BYTES {
        return Err("Backup manifest is unreasonably large.".into());
    }
    let mut text = String::new();
    entry
        .take(MAX_MANIFEST_BYTES)
        .read_to_string(&mut text)
        .map_err(display_err)?;
    let manifest: BackupManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Backup manifest is corrupt: {error}"))?;
    if manifest.kind != "prismatic-library-backup" {
        return Err("This zip is not a Prismatic library backup.".into());
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(format!(
            "This backup was made by a newer Prismatic (format {}). Update the app to restore it.",
            manifest.format_version
        ));
    }
    Ok(manifest)
}

/// Audio files at the managed library root grouped by size, so content
/// de-duplication only hashes files that could possibly match.
fn root_files_by_size(paths: &LibraryPaths) -> HashMap<u64, Vec<PathBuf>> {
    let mut map: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    if let Ok(read) = fs::read_dir(&paths.music_directory) {
        for item in read.flatten() {
            let path = item.path();
            if path.is_file() && is_audio(&path) {
                if let Ok(meta) = item.metadata() {
                    map.entry(meta.len()).or_default().push(path);
                }
            }
        }
    }
    map
}

fn import_inner(
    app: Option<&AppHandle>,
    paths: &LibraryPaths,
    zip_path: String,
    options: BackupImportOptions,
) -> Result<BackupImportResult, String> {
    CANCEL.store(false, Ordering::Relaxed);
    let zip_path = PathBuf::from(zip_path);
    if !zip_path.is_file() {
        return Err("Backup file not found.".into());
    }
    emit_zip_progress(app, "Reading backup…", Some(0.02));
    let file = File::open(&zip_path).map_err(display_err)?;
    let mut archive = zip::ZipArchive::new(file).map_err(display_err)?;
    let manifest = read_manifest(&mut archive)?;

    let mut result = BackupImportResult {
        created_at: manifest.created_at.clone(),
        ..Default::default()
    };
    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut written_names = Vec::new();
    let mut by_size = root_files_by_size(paths);
    let total = manifest.tracks.len().max(1);

    for (index, track) in manifest.tracks.iter().enumerate() {
        if cancelled() {
            result.cancelled = true;
            break;
        }
        if track.entry.is_empty() {
            continue;
        }
        let label = if track.title.is_empty() { &track.file } else { &track.title };
        emit_zip_progress(
            app,
            &format!("Restoring {}/{}: {}", index + 1, total, label),
            Some(0.05 + (index as f64 / total as f64) * 0.85),
        );

        // Entry names come from a file we do not control: only accept plain
        // `audio/<name>` entries and re-derive the destination from the basename.
        if !track.entry.starts_with("audio/") || track.entry.contains("..") {
            result.tracks_failed.push(track.file.clone());
            continue;
        }
        let base = safe_zip_entry_name(&track.file, index);
        if base.starts_with('.') || !is_audio(Path::new(&base)) {
            result.tracks_failed.push(track.file.clone());
            continue;
        }

        let mut entry = match archive.by_name(&track.entry) {
            Ok(entry) => entry,
            Err(_) => {
                result.tracks_failed.push(track.file.clone());
                continue;
            }
        };
        if entry.size() > MAX_ENTRY_BYTES {
            result.tracks_failed.push(track.file.clone());
            continue;
        }

        // Stream into a temp file while hashing; nothing is buffered in memory.
        let temp = paths.music_directory.join(format!(".restore-{index}.tmp"));
        let (digest, size) = {
            let mut out = File::create(&temp).map_err(display_err)?;
            let mut hasher = Sha1::new();
            let mut buffer = vec![0u8; 256 * 1024];
            let mut size = 0u64;
            let mut limited = (&mut entry).take(MAX_ENTRY_BYTES + 1);
            loop {
                if cancelled() {
                    break;
                }
                let read = limited.read(&mut buffer).map_err(display_err)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
                out.write_all(&buffer[..read]).map_err(display_err)?;
                size += read as u64;
            }
            (format!("{:x}", hasher.finalize()), size)
        };
        drop(entry);
        if cancelled() {
            let _ = fs::remove_file(&temp);
            result.cancelled = true;
            break;
        }
        if size > MAX_ENTRY_BYTES || (!track.sha1.is_empty() && track.sha1 != digest) {
            let _ = fs::remove_file(&temp);
            result.tracks_failed.push(track.file.clone());
            continue;
        }

        // Same content already in the library (under any name)? Reuse it.
        let duplicate = by_size.get(&size).and_then(|candidates| {
            candidates
                .iter()
                .find(|candidate| sha1_file(candidate).map(|h| h == digest).unwrap_or(false))
                .cloned()
        });
        if let Some(existing) = duplicate {
            let _ = fs::remove_file(&temp);
            if let Some(name) = existing.file_name().and_then(|v| v.to_str()) {
                id_map.insert(track.id.clone(), track_id("music", name));
                written_names.push(name.to_owned());
            }
            result.tracks_duplicate += 1;
            continue;
        }

        let mut destination = paths.music_directory.join(&base);
        if destination.exists() {
            let stem = Path::new(&base)
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("audio");
            let ext = Path::new(&base)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("mp3");
            destination = paths
                .music_directory
                .join(format!("{stem}-{}.{ext}", &digest[..8]));
        }
        fs::rename(&temp, &destination).map_err(|error| {
            let _ = fs::remove_file(&temp);
            display_err(error)
        })?;
        if let Some(name) = destination.file_name().and_then(|v| v.to_str()) {
            id_map.insert(track.id.clone(), track_id("music", name));
            written_names.push(name.to_owned());
        }
        by_size.entry(size).or_default().push(destination);
        result.tracks_added += 1;
    }

    // Tracks restored (or already present) must not stay soft-hidden.
    unhide_imported_basenames(paths, &written_names)?;

    if !result.cancelled {
        if options.restore_playlists && !manifest.playlists.is_empty() {
            emit_zip_progress(app, "Restoring playlists…", Some(0.93));
            let mut list: Vec<Playlist> = read_json(&playlists_path(paths));
            for playlist in &manifest.playlists {
                if list.iter().any(|existing| existing.id == playlist.id) {
                    result.playlists_skipped += 1;
                    continue;
                }
                let track_ids: Vec<String> = playlist
                    .track_ids
                    .iter()
                    // Metadata-only backups keep their old ids; those tracks
                    // resolve if the same files are already in the library.
                    .map(|old| id_map.get(old).cloned().unwrap_or_else(|| old.clone()))
                    .collect();
                list.push(Playlist {
                    track_ids,
                    ..playlist.clone()
                });
                result.playlists_added += 1;
            }
            write_json(&playlists_path(paths), &list)?;
        }

        if !manifest.overrides.is_empty() {
            let mut current: HashMap<String, Override> =
                read_json(&paths.state_directory.join("library.json"));
            for (old, change) in &manifest.overrides {
                let id = id_map.get(old).cloned().unwrap_or_else(|| old.clone());
                current.entry(id).or_insert_with(|| change.clone());
            }
            write_json(&paths.state_directory.join("library.json"), &current)?;
        }

        if options.restore_settings {
            if let Some(prefs) = &manifest.prefs {
                write_json(&paths.state_directory.join("player.json"), prefs)?;
                result.settings_restored = true;
            }
        }
    }

    GENERATION.fetch_add(1, Ordering::Relaxed);
    emit_zip_progress(app, "Restore complete.", Some(1.0));
    Ok(result)
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn list_inner(paths: &LibraryPaths, dest_path: String, format: String) -> Result<u32, String> {
    let tracks = scan_tracks(paths)?;
    let mut out = String::new();
    if format == "m3u8" {
        out.push_str("#EXTM3U\n");
        for track in &tracks {
            out.push_str(&format!(
                "#EXTINF:{},{} - {}\n{}\n",
                track.duration.round() as i64,
                track.artist,
                track.title,
                track.media_path
            ));
        }
    } else {
        out.push_str("title,artist,album,duration_seconds,format,file\n");
        for track in &tracks {
            out.push_str(&format!(
                "{},{},{},{},{},{}\n",
                csv_cell(&track.title),
                csv_cell(&track.artist),
                csv_cell(&track.album),
                track.duration.round() as i64,
                csv_cell(&track.format),
                csv_cell(&track.file_name)
            ));
        }
    }
    fs::write(&dest_path, out).map_err(display_err)?;
    Ok(tracks.len() as u32)
}

#[tauri::command]
pub async fn export_library_backup(
    app: AppHandle,
    paths: State<'_, LibraryPaths>,
    dest_path: String,
    options: BackupExportOptions,
) -> Result<BackupExportResult, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export_inner(Some(&app), &paths, dest_path, options))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_library_backup(
    app: AppHandle,
    paths: State<'_, LibraryPaths>,
    zip_path: String,
    options: BackupImportOptions,
) -> Result<BackupImportResult, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || import_inner(Some(&app), &paths, zip_path, options))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_library_backup() {
    CANCEL.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn export_library_list(
    paths: State<'_, LibraryPaths>,
    dest_path: String,
    format: String,
) -> Result<u32, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_inner(&paths, dest_path, format))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(tag: &str) -> LibraryPaths {
        let root = std::env::temp_dir().join(format!(
            "prismatic-backup-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = LibraryPaths {
            state_directory: root.join(".prismatic"),
            output_directory: root.join("output"),
            music_directory: root.clone(),
            data_root: root,
        };
        fs::create_dir_all(&paths.state_directory).unwrap();
        paths
    }

    #[test]
    fn unique_names_never_collide_case_insensitively() {
        let mut used = HashSet::new();
        assert_eq!(unique_name(&mut used, "a.mp3".into()), "a.mp3");
        assert_eq!(unique_name(&mut used, "A.mp3".into()), "A-2.mp3");
        assert_eq!(unique_name(&mut used, "a.mp3".into()), "a-3.mp3");
    }

    #[test]
    fn round_trip_restores_audio_playlists_and_dedupes() {
        let source = temp_paths("src");
        fs::write(source.music_directory.join("one.wav"), b"RIFFaaaaWAVEone").unwrap();
        fs::write(source.music_directory.join("two.wav"), b"RIFFbbbbWAVEtwo").unwrap();
        let ids: Vec<String> = ["one.wav", "two.wav"]
            .iter()
            .map(|n| track_id("music", n))
            .collect();
        let playlists = vec![Playlist {
            id: "pl-test".into(),
            name: "Mix".into(),
            track_ids: vec![ids[1].clone(), ids[0].clone()],
            created_at: now_iso(),
            updated_at: now_iso(),
        }];
        write_json(&playlists_path(&source), &playlists).unwrap();

        let zip_file = source.data_root.join("backup.zip");
        let exported = export_inner(
            None,
            &source,
            zip_file.to_string_lossy().into_owned(),
            BackupExportOptions {
                include_audio: true,
                include_playlists: true,
                include_settings: true,
            },
        )
        .unwrap();
        assert_eq!(exported.tracks, 2);
        assert!(exported.missing.is_empty());

        let target = temp_paths("dst");
        let opts = || BackupImportOptions {
            restore_playlists: true,
            restore_settings: true,
        };
        let first = import_inner(None, &target, zip_file.to_string_lossy().into_owned(), opts()).unwrap();
        assert_eq!(first.tracks_added, 2);
        assert_eq!(first.playlists_added, 1);
        let restored: Vec<Playlist> = read_json(&playlists_path(&target));
        assert_eq!(restored[0].track_ids, vec![ids[1].clone(), ids[0].clone()]);

        // Restoring again changes nothing: audio is deduped, playlist skipped.
        let second = import_inner(None, &target, zip_file.to_string_lossy().into_owned(), opts()).unwrap();
        assert_eq!(second.tracks_added, 0);
        assert_eq!(second.tracks_duplicate, 2);
        assert_eq!(second.playlists_skipped, 1);
    }

    #[test]
    fn rejects_zip_without_manifest() {
        let paths = temp_paths("bad");
        let zip_file = paths.data_root.join("plain.zip");
        {
            let file = File::create(&zip_file).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("song.mp3", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
        }
        let error = import_inner(
            None,
            &paths,
            zip_file.to_string_lossy().into_owned(),
            BackupImportOptions {
                restore_playlists: true,
                restore_settings: true,
            },
        )
        .unwrap_err();
        assert!(error.contains("not a Prismatic library backup"));
    }

    #[test]
    fn rejects_entries_that_escape_the_audio_folder() {
        let paths = temp_paths("evil");
        let zip_file = paths.data_root.join("evil.zip");
        {
            let file = File::create(&zip_file).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("audio/../../escape.mp3", opts).unwrap();
            zip.write_all(b"x").unwrap();
            let manifest = BackupManifest {
                kind: "prismatic-library-backup".into(),
                format_version: 1,
                tracks: vec![BackupTrack {
                    id: "x".into(),
                    file: "escape.mp3".into(),
                    entry: "audio/../../escape.mp3".into(),
                    ..Default::default()
                }],
                ..Default::default()
            };
            zip.start_file(MANIFEST_NAME, opts).unwrap();
            zip.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
            zip.finish().unwrap();
        }
        let result = import_inner(
            None,
            &paths,
            zip_file.to_string_lossy().into_owned(),
            BackupImportOptions {
                restore_playlists: false,
                restore_settings: false,
            },
        )
        .unwrap();
        assert_eq!(result.tracks_added, 0);
        assert_eq!(result.tracks_failed.len(), 1);
    }
}
