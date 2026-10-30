// Real mouse input on macOS for e2e/phoneWidth.spec.ts: the events a person's
// mouse makes, posted to the system (CGEvent, HID tap) — not into the page.
// Compiled once per run (`swiftc -O`, os/real.ts); macOS lets it post only
// when the process holding it may (Accessibility / "post events"), which a
// GitHub runner may or may not grant: `access` says what the system says, and
// the spec judges by whether the page actually saw a move.
//
//   access                         → "post=<bool> listen=<bool>"
//   move   x y
//   click  x y
//   dclick x y                     (a double-click: click states 1 then 2)
//   drag   x1 y1 x2 y2 ms steps    (down, `steps` drags over `ms`, up)
//
// Coordinates are global screen points, top-left of the main display — what
// Electron's screen / BrowserWindow bounds use on macOS.

import CoreGraphics
import Foundation

let args = CommandLine.arguments
func num(_ i: Int) -> Double { Double(args[i]) ?? 0 }
func point(_ i: Int) -> CGPoint { CGPoint(x: num(i), y: num(i + 1)) }
let source = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ p: CGPoint, clicks: Int64 = 1) {
  guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.post(tap: .cghidEventTap)
}
func pause(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

guard args.count >= 2 else {
  FileHandle.standardError.write("usage: macInput access|move|click|dclick|drag …\n".data(using: .utf8)!)
  exit(2)
}

switch args[1] {
case "access":
  print("post=\(CGPreflightPostEventAccess()) listen=\(CGPreflightListenEventAccess())")
case "move":
  post(.mouseMoved, point(2))
case "click":
  let p = point(2)
  post(.mouseMoved, p); pause(60)
  post(.leftMouseDown, p); pause(60)
  post(.leftMouseUp, p)
case "dclick":
  let p = point(2)
  post(.mouseMoved, p); pause(60)
  post(.leftMouseDown, p, clicks: 1); pause(40)
  post(.leftMouseUp, p, clicks: 1); pause(80)
  post(.leftMouseDown, p, clicks: 2); pause(40)
  post(.leftMouseUp, p, clicks: 2)
case "drag":
  let a = point(2), b = point(4)
  let ms = num(6), steps = max(1, Int(num(7)))
  post(.mouseMoved, a); pause(80)
  post(.leftMouseDown, a); pause(120)
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    post(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
    pause(ms / Double(steps))
  }
  pause(120)
  post(.leftMouseUp, b)
default:
  FileHandle.standardError.write("macInput: unknown command \(args[1])\n".data(using: .utf8)!)
  exit(2)
}
