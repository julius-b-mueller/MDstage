//! Where the pointer is on the screen, asked of the system directly.
//!
//! A window is not told where the pointer is while something is dragged over it from
//! another program — only that a file hovers, and later that it was dropped. To show
//! where a dragged file would land, the position has to come from the system.
//!
//! macOS and Windows have a call for that. On Linux there is none that works everywhere
//! (Wayland keeps the position to itself), so there the answer is `None` and the caller
//! does without.

/// The pointer's position on the screen, from the top left corner: in points on macOS,
/// in pixels on Windows.
#[cfg(target_os = "macos")]
pub fn on_screen() -> Option<(f64, f64)> {
    use std::ffi::c_void;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: *const c_void);
    }
    // SAFETY: an event made from no source is the documented way to read the current
    // pointer location; it is checked for null and released again.
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Some((point.x, point.y))
    }
}

#[cfg(windows)]
pub fn on_screen() -> Option<(f64, f64)> {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
    }
    let mut point = Point { x: 0, y: 0 };
    // SAFETY: GetCursorPos writes one POINT to the address given.
    let found = unsafe { GetCursorPos(&mut point) } != 0;
    found.then_some((point.x as f64, point.y as f64))
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn on_screen() -> Option<(f64, f64)> {
    None
}

#[cfg(test)]
mod tests {
    /// Asking must never bring the app down, whatever the answer.
    #[test]
    fn asking_for_the_pointer_is_harmless() {
        if let Some((x, y)) = super::on_screen() {
            assert!(x.is_finite() && y.is_finite());
        }
    }
}
