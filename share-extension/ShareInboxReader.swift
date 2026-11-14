import Foundation

/// The reading side of the inbox on iPhone: takes the oldest finished share out
/// of the App Group folder and into the app's own caches, because staged files
/// stay on a draft until they are sent. The format is ShareSpool's; the desktop
/// shell's reader is src/main/shareInbox.ts, and holds to the same limits.
enum ShareInboxReader {
  /// The API's upload limit (mafold-api `MAX_BYTES`).
  static let maxFileBytes: Int64 = 500 * 1024 * 1024
  /// Staged files stay on a draft across days; older ones were sent or forgotten.
  private static let keepSeconds: TimeInterval = 7 * 24 * 60 * 60
  /// An unfinished folder this old lost its writer.
  private static let abandonedSeconds: TimeInterval = 60 * 60

  /// `{text, files: [{uri, name, type, size}], skipped}` for JS, or nil.
  static func take(inbox: URL, keep: URL, now: Date = Date()) -> [String: Any]? {
    let fm = FileManager.default
    purge(keep, olderThan: now.addingTimeInterval(-keepSeconds))
    let keys: [URLResourceKey] = [.contentModificationDateKey]
    let dirs = (try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: keys)) ?? []
    var waiting: [(dir: URL, at: Date)] = []
    for dir in dirs {
      let manifest = dir.appendingPathComponent("manifest.json")
      if let at = modified(manifest) {
        waiting.append((dir, at))
      } else if let at = modified(dir), now.timeIntervalSince(at) > abandonedSeconds {
        try? fm.removeItem(at: dir)
      }
    }
    for (dir, _) in waiting.sorted(by: { $0.at < $1.at }) {
      if let share = takeOne(dir, keep: keep) { return share }
    }
    return nil
  }

  private static func takeOne(_ dir: URL, keep: URL) -> [String: Any]? {
    let fm = FileManager.default
    let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json"))
    let manifest = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    guard let manifest, let text = manifest["text"] as? String, let rows = manifest["files"] as? [[String: Any]],
          (try? fm.createDirectory(at: keep, withIntermediateDirectories: true)) != nil
    else {
      try? fm.removeItem(at: dir)
      return nil
    }
    let kept = keep.appendingPathComponent(dir.lastPathComponent, isDirectory: true)
    guard (try? fm.moveItem(at: dir, to: kept)) != nil else {
      try? fm.removeItem(at: dir)
      return nil
    }
    var files: [[String: Any]] = []
    for row in rows {
      guard let name = row["name"] as? String, name != "manifest.json", (name as NSString).lastPathComponent == name
      else { continue }
      let url = kept.appendingPathComponent(name)
      let attrs = try? fm.attributesOfItem(atPath: url.path)
      guard attrs?[.type] as? FileAttributeType == .typeRegular,
            let size = (attrs?[.size] as? NSNumber)?.int64Value, size <= maxFileBytes
      else { continue }
      files.append([
        "uri": url.absoluteString,
        "name": name,
        "type": row["mime"] as? String ?? "application/octet-stream",
        "size": size,
      ])
    }
    let skipped = rows.count - files.count
    guard !text.isEmpty || !files.isEmpty || skipped > 0 else {
      try? fm.removeItem(at: kept)
      return nil
    }
    return ["text": text, "files": files, "skipped": skipped]
  }

  private static func purge(_ dir: URL, olderThan cutoff: Date) {
    let fm = FileManager.default
    for item in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
      if let at = modified(item), at < cutoff { try? fm.removeItem(at: item) }
    }
  }

  private static func modified(_ url: URL) -> Date? {
    try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
  }
}
