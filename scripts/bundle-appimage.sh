#!/bin/sh
# Builds target/bundle/MDstage-linux-<arch>.AppImage from the native (Rust) app.
# Run on Linux, on the architecture the AppImage is for.
#
#   scripts/bundle-appimage.sh
#
# The AppImage holds the program itself. What every Linux desktop brings along (ALSA,
# OpenGL, X11 or Wayland) is used from the system.
set -eu

cd "$(dirname "$0")/.."

# appimagetool 1.9.0, checked against the checksums of its release files.
case "$(uname -m)" in
    x86_64)
        machine=x86_64 name=x64
        checksum=46fdd785094c7f6e545b61afcfb0f3d98d8eab243f644b4b17698c01d06083d1
        ;;
    aarch64 | arm64)
        machine=aarch64 name=arm64
        checksum=04f45ea45b5aa07bb2b071aed9dbf7a5185d3953b11b47358c1311f11ea94a96
        ;;
    *)
        echo "unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

cargo build --release -p mdstage-app --locked

dir=target/bundle/MDstage.AppDir
rm -rf "$dir"
mkdir -p "$dir/usr/bin" "$dir/usr/share/applications" "$dir/usr/share/icons/hicolor/512x512/apps"
cp target/release/mdstage "$dir/usr/bin/mdstage"
cp crates/mdstage-app/mdstage.desktop "$dir/mdstage.desktop"
cp crates/mdstage-app/mdstage.desktop "$dir/usr/share/applications/mdstage.desktop"
cp crates/mdstage-app/assets/mdstage-512.png "$dir/mdstage.png"
cp crates/mdstage-app/assets/mdstage-512.png "$dir/usr/share/icons/hicolor/512x512/apps/mdstage.png"
ln -s usr/bin/mdstage "$dir/AppRun"

tool=target/bundle/appimagetool-$machine.AppImage
if [ ! -x "$tool" ]; then
    curl -fsSL -o "$tool" "https://github.com/AppImage/appimagetool/releases/download/1.9.0/appimagetool-$machine.AppImage"
    echo "$checksum  $tool" | sha256sum -c -
    chmod +x "$tool"
fi

# --appimage-extract-and-run: build machines often have no FUSE.
ARCH=$machine "$tool" --appimage-extract-and-run "$dir" "target/bundle/MDstage-linux-$name.AppImage"
echo "target/bundle/MDstage-linux-$name.AppImage"
