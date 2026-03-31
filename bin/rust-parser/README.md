Pre-built rust-parser binaries go here.

Binary naming convention: `rust-parser-{platform}-{arch}[.exe]`

Where `platform` and `arch` match Node.js `process.platform` and `process.arch`:

| File | Platform |
| --- | --- |
| `rust-parser-win32-x64.exe` | Windows x64 |
| `rust-parser-darwin-x64` | macOS Intel |
| `rust-parser-darwin-arm64` | macOS Apple Silicon |
| `rust-parser-linux-x64` | Linux x64 |
| `rust-parser-linux-arm64` | Linux ARM64 |
| `rust-parser-linux-arm` | Linux ARMv7 |

To rebuild all binaries, cross-compile from the `rust-parser/` source directory or build natively on each target platform with `cargo build --release`.
