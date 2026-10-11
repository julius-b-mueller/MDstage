#!/bin/sh
# Builds target/bundle/MDstage.app from the native (Rust) app.
#
#   scripts/bundle-macos.sh [--dmg]
#
# With --dmg, also writes target/bundle/MDstage-macos-arm64.dmg.
set -eu

cd "$(dirname "$0")/.."
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
app=target/bundle/MDstage.app

cargo build --release -p mdstage-app

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp target/release/mdstage "$app/Contents/MacOS/MDstage"

# App icon from the PNG, in the sizes macOS asks for.
iconset=target/bundle/MDstage.iconset
rm -rf "$iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" crates/mdstage-app/assets/icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" crates/mdstage-app/assets/icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/MDstage.icns"
rm -rf "$iconset"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>MDstage</string>
    <key>CFBundleDisplayName</key><string>MDstage</string>
    <key>CFBundleIdentifier</key><string>de.mdstage.app</string>
    <key>CFBundleExecutable</key><string>MDstage</string>
    <key>CFBundleIconFile</key><string>MDstage</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>MDstage Show</string>
            <key>CFBundleTypeRole</key><string>Editor</string>
            <key>CFBundleTypeExtensions</key><array><string>md</string></array>
        </dict>
    </array>
</dict>
</plist>
EOF

# Sign the bundle ad hoc. The linker signs the executable by itself, but that signature
# knows nothing of Info.plist and the icon: downloaded from the web, macOS then calls
# the app "damaged" and offers no way to open it. With the whole bundle sealed it is
# merely from an unidentified developer and can be let through in System Settings.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

echo "Built $app (version $version)"

if [ "${1:-}" = "--dmg" ]; then
    dmg=target/bundle/MDstage-macos-arm64.dmg
    rm -f "$dmg"
    hdiutil create -quiet -volname MDstage -srcfolder "$app" -ov -format UDZO "$dmg"
    echo "Built $dmg"
fi
