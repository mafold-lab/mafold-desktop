// The one call Electron doesn't make: cutting a whole window in macOS's own
// continuous corner, the curve the system draws its own shapes with (ops 11-07:
// a plain circle looks odd next to them). `View.setBorderRadius` does circles
// only, and one view at a time.
//
// It cuts the layer of the window's content view, which holds everything the
// shell puts in the window, so the page, the title bar and the loading cover
// stand in one shape, and what's outside it is see-through (windowCorners.ts
// has why the window is see-through, and which windows are).

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

// cut(handle, radius): `handle` is BaseWindow.getNativeWindowHandle(), which
// holds the content view's NSView*; 0 takes the cut off and leaves the system's
// corners. Says whether it found a layer to cut.
static napi_value cut(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  void* data = NULL;
  size_t length = 0;
  double radius = 0;
  bool done = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc == 2 &&
      napi_get_buffer_info(env, argv[0], &data, &length) == napi_ok && length == sizeof(void*) &&
      napi_get_value_double(env, argv[1], &radius) == napi_ok) {
    NSView* view = (__bridge NSView*)*(void**)data;
    CALayer* layer = view.layer;
    if (layer) {
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      layer.cornerCurve = kCACornerCurveContinuous;
      layer.cornerRadius = radius;
      layer.masksToBounds = radius > 0;
      [CATransaction commit];
      done = true;
    }
  }
  napi_value result = NULL;
  napi_get_boolean(env, done, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn = NULL;
  if (napi_create_function(env, "cut", NAPI_AUTO_LENGTH, cut, NULL, &fn) == napi_ok) {
    napi_set_named_property(env, exports, "cut", fn);
  }
  return exports;
}
