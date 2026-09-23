# HTTP/2 and TLS native build inputs

The HTTP/2 and TLS runtimes are built from pinned upstream release archives. The archives are not committed because they are third-party source distributions. The committed descriptors pin each archive and the exact files that enter the build.

These steps require Emscripten 5.0.1. Set `EMCC` to that installation's `emcc` executable.

## HTTP/2

Download and verify `nghttp2-1.70.0.tar.bz2` before extracting it:

```sh
curl -fL -o nghttp2-1.70.0.tar.bz2 https://github.com/nghttp2/nghttp2/releases/download/v1.70.0/nghttp2-1.70.0.tar.bz2
echo '8faca1f78aa99ac3bc1768a76b7e0f6b36d8e6a62c13818751b1d205f02f9405  nghttp2-1.70.0.tar.bz2' | shasum -a 256 -c -
tar -xjf nghttp2-1.70.0.tar.bz2
```

Build with the extracted source root:

```sh
HTTP2_SOURCE_ROOT=/absolute/path/to/nghttp2-1.70.0 \
EMCC=/absolute/path/to/emscripten/emcc \
npm run build:http2-runtime
```

You can also pass both paths as positional arguments:

```sh
node scripts/build-http2-runtime.mjs /absolute/path/to/nghttp2-1.70.0 /absolute/path/to/emscripten/emcc
```

Set `HTTP2_RUNTIME_OUTPUT` or pass a third positional argument to build into a directory other than `public/http2-runtime`.

## TLS

Download and verify `mbedtls-3.6.7.tar.bz2` before extracting it:

```sh
curl -fL -o mbedtls-3.6.7.tar.bz2 https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2
echo 'a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6  mbedtls-3.6.7.tar.bz2' | shasum -a 256 -c -
tar -xjf mbedtls-3.6.7.tar.bz2
```

Build with the extracted source root:

```sh
TLS_SOURCE_ROOT=/absolute/path/to/mbedtls-3.6.7 \
EMCC=/absolute/path/to/emscripten/emcc \
npm run build:tls-runtime
```

You can also pass both paths as positional arguments:

```sh
node scripts/build-tls-runtime.mjs /absolute/path/to/mbedtls-3.6.7 /absolute/path/to/emscripten/emcc
```

Set `TLS_RUNTIME_OUTPUT` or pass a third positional argument to build into a directory other than `public/tls-runtime`.

Both build scripts verify the selected C sources, headers, and license before starting Emscripten. They stop if a relevant file is missing, added, or changed. The archive hash verifies the complete downloaded source distribution. Compiler prefix maps keep host source paths out of the generated WASM so different extraction directories produce the same artifacts.
