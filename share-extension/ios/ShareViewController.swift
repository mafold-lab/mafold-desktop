import UIKit

/// Mafold in the system share sheet (iPhone). It saves what it was given where
/// the app can read it and opens the app, which asks where it should go
/// (ShareSpool.swift has the why, mafold-rn/src/lib/shareInbox.ts the reading side).
final class ShareViewController: UIViewController {
  private static let appGroup = "group.com.mafold.app"

  override func viewDidLoad() {
    super.viewDidLoad()
    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    spinner.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
    spinner.startAnimating()
    view.addSubview(spinner)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    let items = (extensionContext?.inputItems ?? []).compactMap { $0 as? NSExtensionItem }
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
    else { return finish() }
    ShareSpool.save(items, into: container.appendingPathComponent("Inbox", isDirectory: true)) { [weak self] saved in
      if saved { self?.openApp() }
      self?.finish()
    }
  }

  /// `NSExtensionContext.open` is refused to share extensions. The process's
  /// UIApplication is still in the responder chain, which is the one way to the
  /// app, and why this target sets APPLICATION_EXTENSION_API_ONLY = NO. If it
  /// stops working the share waits in the inbox for the next time Mafold opens.
  private func openApp() {
    guard let url = URL(string: "mafold://share") else { return }
    var responder: UIResponder? = self
    while let current = responder {
      if let app = current as? UIApplication {
        app.open(url, options: [:], completionHandler: nil)
        return
      }
      responder = current.next
    }
  }

  private func finish() {
    extensionContext?.completeRequest(returningItems: nil)
  }
}
