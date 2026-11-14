import Foundation
import UniformTypeIdentifiers

// What ShareSpool writes from the kinds of thing a share sheet hands over. Runs
// on the macOS test runner (share-extension/test/run.sh): the providers are the
// real NSItemProvider, which only exists there.

var failed = 0
func check(_ ok: Bool, _ what: String) {
  print(ok ? "ok   \(what)" : "FAIL \(what)")
  if !ok { failed += 1 }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("share-spool-\(UUID().uuidString)")
try fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

func spool(_ items: [NSExtensionItem]) -> (saved: Bool, manifest: [String: Any]?, dir: URL?) {
  let inbox = root.appendingPathComponent(UUID().uuidString)
  var saved: Bool?
  ShareSpool.save(items, into: inbox) { saved = $0 }
  let deadline = Date().addingTimeInterval(20)
  while saved == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  guard let dir = (try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil))?.first,
        let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
        let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return (saved ?? false, nil, nil) }
  return (saved ?? false, manifest, dir)
}

func item(_ providers: [NSItemProvider], text: String? = nil) -> NSExtensionItem {
  let item = NSExtensionItem()
  item.attachments = providers
  if let text { item.attributedContentText = NSAttributedString(string: text) }
  return item
}

func names(_ m: [String: Any]?) -> [String] {
  ((m?["files"] as? [[String: String]]) ?? []).compactMap { $0["name"] }.sorted()
}
func mimes(_ m: [String: Any]?) -> [String] {
  ((m?["files"] as? [[String: String]]) ?? []).compactMap { $0["mime"] }.sorted()
}

// A file by URL: what Finder and most Mac apps hand over.
let doc = root.appendingPathComponent("report.pdf")
try Data("%PDF-1.4".utf8).write(to: doc)
do {
  let r = spool([item([NSItemProvider(contentsOf: doc)!])])
  check(r.saved, "file: saved")
  check(names(r.manifest) == ["report.pdf"], "file: keeps its name")
  check(mimes(r.manifest) == ["application/pdf"], "file: mime from its extension")
  check((try? Data(contentsOf: r.dir!.appendingPathComponent("report.pdf"))) == Data("%PDF-1.4".utf8), "file: bytes copied")
}

// Plain text, both ways it arrives; said twice, kept once.
do {
  let r = spool([item([NSItemProvider(object: "hello" as NSString)], text: "hello")])
  check(r.manifest?["text"] as? String == "hello", "text: attachment and item text collapse")
  check(names(r.manifest).isEmpty, "text: no files")
}

// A web link goes in the text, not in a file.
do {
  let r = spool([item([NSItemProvider(object: URL(string: "https://mafold.com/a")! as NSURL)], text: "look")])
  check(r.manifest?["text"] as? String == "look\nhttps://mafold.com/a" || r.manifest?["text"] as? String == "https://mafold.com/a\nlook" , "link: joins the text")
}

// Bytes with no file behind them, the way a chat app often offers a picture.
do {
  let png = Data([0x89, 0x50, 0x4E, 0x47])
  let p = NSItemProvider()
  p.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in done(png, nil); return nil }
  p.suggestedName = "screenshot"
  let r = spool([item([p])])
  check(names(r.manifest) == ["screenshot.png"], "image bytes: named with an extension (\(names(r.manifest)))")
  check(mimes(r.manifest) == ["image/png"], "image bytes: mime")
  check((try? Data(contentsOf: r.dir!.appendingPathComponent("screenshot.png"))) == png, "image bytes: copied")
}

// Two files of one name must not overwrite each other.
do {
  let other = root.appendingPathComponent("again")
  try fm.createDirectory(at: other, withIntermediateDirectories: true)
  let twin = other.appendingPathComponent("report.pdf")
  try Data("second".utf8).write(to: twin)
  let r = spool([item([NSItemProvider(contentsOf: doc)!, NSItemProvider(contentsOf: twin)!])])
  check(names(r.manifest) == ["report 2.pdf", "report.pdf"], "same name: both kept (\(names(r.manifest)))")
}

// A file named like the manifest can't take its place.
do {
  let f = root.appendingPathComponent("manifest.json")
  try Data("{}".utf8).write(to: f)
  let r = spool([item([NSItemProvider(contentsOf: f)!])])
  check(names(r.manifest) == ["manifest 2.json"], "manifest name: reserved (\(names(r.manifest)))")
}

// Nothing to keep leaves nothing behind.
do {
  let r = spool([item([])])
  check(!r.saved && r.manifest == nil, "empty: nothing saved")
}

// The iPhone's reader takes what the spool wrote, and the oldest first.
do {
  let inbox = root.appendingPathComponent(UUID().uuidString)
  let keep = root.appendingPathComponent(UUID().uuidString)
  func write(_ items: [NSExtensionItem]) {
    var saved: Bool?
    ShareSpool.save(items, into: inbox) { saved = $0 }
    while saved == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  }
  write([item([NSItemProvider(contentsOf: doc)!], text: "first")])
  Thread.sleep(forTimeInterval: 1.1)
  write([item([], text: "second")])
  let one = ShareInboxReader.take(inbox: inbox, keep: keep)
  check(one?["text"] as? String == "first", "reader: oldest first")
  let row = (one?["files"] as? [[String: Any]])?.first
  check(row?["name"] as? String == "report.pdf" && row?["type"] as? String == "application/pdf", "reader: file row")
  let uri = (row?["uri"] as? String).flatMap(URL.init(string:))
  check(uri.map { (try? Data(contentsOf: $0)) == Data("%PDF-1.4".utf8) } ?? false, "reader: file readable where it moved")
  check(uri?.path.hasPrefix(keep.path) ?? false, "reader: moved out of the inbox")
  check(ShareInboxReader.take(inbox: inbox, keep: keep)?["text"] as? String == "second", "reader: then the next")
  check(ShareInboxReader.take(inbox: inbox, keep: keep) == nil, "reader: each once")
}

// A manifest can name only plain files in its own folder.
do {
  let inbox = root.appendingPathComponent(UUID().uuidString)
  let keep = root.appendingPathComponent(UUID().uuidString)
  let dir = inbox.appendingPathComponent("a")
  try fm.createDirectory(at: dir, withIntermediateDirectories: true)
  try Data("ok".utf8).write(to: dir.appendingPathComponent("fine.txt"))
  try fm.createSymbolicLink(at: dir.appendingPathComponent("link"), withDestinationURL: doc)
  let manifest: [String: Any] = ["v": 1, "text": "", "files": [
    ["name": "../../report.pdf", "mime": "application/pdf"],
    ["name": "link", "mime": "application/pdf"],
    ["name": "manifest.json", "mime": "application/json"],
    ["name": "missing", "mime": "text/plain"],
    ["name": "fine.txt", "mime": "text/plain"],
  ]]
  try JSONSerialization.data(withJSONObject: manifest).write(to: dir.appendingPathComponent("manifest.json"))
  let got = ShareInboxReader.take(inbox: inbox, keep: keep)
  check(((got?["files"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String } == ["fine.txt"], "reader: own plain files only")
  check(got?["skipped"] as? Int == 4, "reader: the rest counted")
}

// A folder still being written stays; an abandoned one goes.
do {
  let inbox = root.appendingPathComponent(UUID().uuidString)
  let keep = root.appendingPathComponent(UUID().uuidString)
  try fm.createDirectory(at: inbox.appendingPathComponent("writing"), withIntermediateDirectories: true)
  check(ShareInboxReader.take(inbox: inbox, keep: keep) == nil, "reader: nothing finished yet")
  check(fm.fileExists(atPath: inbox.appendingPathComponent("writing").path), "reader: leaves a folder being written")
  _ = ShareInboxReader.take(inbox: inbox, keep: keep, now: Date().addingTimeInterval(2 * 60 * 60))
  check(!fm.fileExists(atPath: inbox.appendingPathComponent("writing").path), "reader: clears an abandoned one")
}

if failed > 0 { print("\(failed) failed"); exit(1) }
print("all passed")
