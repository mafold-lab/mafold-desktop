import AppKit

/// Mafold in the system share menu (macOS). It saves what it was given where
/// the app can read it and opens the app, which asks where it should go
/// (ShareSpool.swift has the why, src/main/shareInbox.ts is the reading side).
final class ShareViewController: NSViewController {
  private static let appGroup = "UGZPUZZYDD.com.mafold.share"

  override func loadView() {
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 64))
    let spinner = NSProgressIndicator(frame: NSRect(x: 94, y: 16, width: 32, height: 32))
    spinner.style = .spinning
    spinner.startAnimation(nil)
    root.addSubview(spinner)
    view = root
  }

  override func viewDidAppear() {
    super.viewDidAppear()
    let items = (extensionContext?.inputItems ?? []).compactMap { $0 as? NSExtensionItem }
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
    else { return finish() }
    ShareSpool.save(items, into: container.appendingPathComponent("Inbox", isDirectory: true)) { [weak self] saved in
      if saved, let url = URL(string: "mafold://share") { NSWorkspace.shared.open(url) }
      self?.finish()
    }
  }

  private func finish() {
    extensionContext?.completeRequest(returningItems: nil)
  }
}
