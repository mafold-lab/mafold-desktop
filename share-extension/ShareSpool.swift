import Foundation
import UniformTypeIdentifiers

/// Writes what the share sheet hands an extension into an inbox folder that the
/// app reads. Both extensions compile this one file: the Mac's
/// (mafold-desktop/share-extension/mac) and the iPhone's (mafold-rn/ios/MafoldShare).
///
/// An extension is a separate process with little memory and no use for a
/// session, so it does none of the sending. It saves, and the app stages the
/// result in the composer of the chat the person picks.
///
/// The folder is `<inbox>/<uuid>/`: the files, then `manifest.json`, always last,
/// because the reader treats a folder without one as still being written.
///
///     {"v":1,"text":"…","files":[{"name":"a.jpg","mime":"image/jpeg"}]}
enum ShareSpool {

  /// Saves `items` and calls back on the main queue with whether anything was
  /// saved. The callback fires only after every provider has answered.
  static func save(_ items: [NSExtensionItem], into inbox: URL, done: @escaping (Bool) -> Void) {
    let dir = inbox.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let spool = Spool(dir: dir)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      DispatchQueue.main.async { done(false) }
      return
    }
    let group = DispatchGroup()
    for item in items {
      if let text = item.attributedContentText?.string { spool.add(text: text) }
      for provider in item.attachments ?? [] {
        group.enter()
        read(provider, into: spool) { group.leave() }
      }
    }
    group.notify(queue: .global(qos: .userInitiated)) {
      let saved = spool.finish()
      DispatchQueue.main.async { done(saved) }
    }
  }

  /// One attachment, read as the most specific thing it offers: a file, then
  /// media, then a link, then text. A photo is usually offered as a file AND an
  /// image, and a picture from a chat app can come with a text caption type.
  private static func read(_ provider: NSItemProvider, into spool: Spool, done: @escaping () -> Void) {
    let types = provider.registeredTypeIdentifiers
    func first(_ kinds: UTType...) -> String? {
      types.first { id in kinds.contains { UTType(id)?.conforms(to: $0) ?? false } }
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, _ in
        if let url = fileURL(from: value) { spool.add(file: url, name: nil, type: UTType(filenameExtension: url.pathExtension)) }
        done()
      }
      return
    }
    let media = first(.image, .audiovisualContent)
    // A bare link. A file on disk is also a URL, which the branch above took.
    if media == nil, let id = first(.url) {
      provider.loadItem(forTypeIdentifier: id, options: nil) { value, _ in
        if let url = value as? URL {
          url.isFileURL ? spool.add(file: url, name: nil, type: UTType(id)) : spool.add(text: url.absoluteString)
        } else if let data = value as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
          spool.add(text: url.absoluteString)
        } else if let text = value as? String {
          spool.add(text: text)
        }
        done()
      }
      return
    }
    if media == nil, let id = first(.plainText) {
      provider.loadItem(forTypeIdentifier: id, options: nil) { value, _ in
        if let url = fileURL(from: value) {
          spool.add(file: url, name: provider.suggestedName, type: UTType(id))
        } else if let text = value as? String {
          spool.add(text: text)
        } else if let data = value as? Data, let text = String(data: data, encoding: .utf8) {
          spool.add(text: text)
        }
        done()
      }
      return
    }
    // Everything else is bytes: images, video, audio, documents. The system
    // deletes this file when the handler returns, so it is copied inside it.
    guard let id = media ?? types.first else { return done() }
    provider.loadFileRepresentation(forTypeIdentifier: id) { url, _ in
      if let url { spool.add(file: url, name: provider.suggestedName, type: UTType(id)) }
      done()
    }
  }

  private static func fileURL(from value: NSSecureCoding?) -> URL? {
    if let url = value as? URL, url.isFileURL { return url }
    if let data = value as? Data, let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL { return url }
    return nil
  }

  /// Collects results from the providers' callbacks, which land on any queue.
  private final class Spool {
    private let dir: URL
    private let lock = NSLock()
    private var texts: [String] = []
    private var files: [[String: String]] = []
    private var taken = Set<String>()

    init(dir: URL) { self.dir = dir }

    func add(text: String) {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return }
      lock.lock(); defer { lock.unlock() }
      // A share often repeats itself: the item's text and a text attachment.
      if !texts.contains(trimmed) { texts.append(trimmed) }
    }

    func add(file source: URL, name: String?, type: UTType?) {
      let original = source.lastPathComponent
      let picked = name.flatMap { Self.named($0, like: original, type: type) } ?? original
      let accessed = source.startAccessingSecurityScopedResource()
      defer { if accessed { source.stopAccessingSecurityScopedResource() } }
      lock.lock()
      let own = uniqueName(picked)
      lock.unlock()
      do {
        try FileManager.default.copyItem(at: source, to: dir.appendingPathComponent(own))
      } catch {
        return
      }
      let found = UTType(filenameExtension: (own as NSString).pathExtension)
      let mime = found?.preferredMIMEType ?? type?.preferredMIMEType ?? "application/octet-stream"
      lock.lock(); defer { lock.unlock() }
      files.append(["name": own, "mime": mime])
    }

    /// Writes the manifest, or takes the empty folder away.
    func finish() -> Bool {
      lock.lock(); defer { lock.unlock() }
      let text = texts.joined(separator: "\n")
      let manifest: [String: Any] = ["v": 1, "text": text, "files": files]
      guard !text.isEmpty || !files.isEmpty,
            let data = try? JSONSerialization.data(withJSONObject: manifest),
            (try? data.write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)) != nil
      else {
        try? FileManager.default.removeItem(at: dir)
        return false
      }
      return true
    }

    /// A provider's suggested name, keeping an extension: suggested names come
    /// without one, and the app reads a file's kind off its name.
    private static func named(_ name: String, like original: String, type: UTType?) -> String? {
      let clean = safe(name)
      guard !clean.isEmpty else { return nil }
      if !(clean as NSString).pathExtension.isEmpty { return clean }
      let ext = (original as NSString).pathExtension
      if !ext.isEmpty { return "\(clean).\(ext)" }
      return type?.preferredFilenameExtension.map { "\(clean).\($0)" } ?? clean
    }

    private static func safe(_ name: String) -> String {
      name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
    }

    /// Two attachments can share a name; the manifest's name is reserved too.
    private func uniqueName(_ name: String) -> String {
      let base = (name as NSString).deletingPathExtension
      let ext = (name as NSString).pathExtension
      var candidate = name
      var n = 1
      while taken.contains(candidate) || candidate == "manifest.json" {
        n += 1
        candidate = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
      }
      taken.insert(candidate)
      return candidate
    }
  }
}
