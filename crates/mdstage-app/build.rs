//! Gives the Windows executable its icon. Does nothing on other systems.

fn main() {
    println!("cargo:rerun-if-changed=assets/mdstage.ico");
    #[cfg(windows)]
    {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("assets/mdstage.ico");
        // An .exe without an icon is better than no .exe.
        if let Err(e) = resource.compile() {
            println!("cargo:warning=the executable gets no icon: {e}");
        }
    }
}
