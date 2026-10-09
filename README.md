# Airgapped QR File Transfer (Offline Version)

Airgapped QR File Transfer is a simple static JS site to transfer data between devices using QR codes. It allows for the transfer of files without the need for network connectivity, leveraging QR codes to encode and decode file data. The web pages are fully self-contained: pako for compression, qrcode-generator for QR code generation, and jsQR for scanning — no CDN, framework or WASM dependencies.

This is a fully offline and heavily rewritten fork of the nice work of https://github.com/mohankumarelec/airgap-qr-transfer.git.

## Online @:
https://qrft.org

## Installation
Visit the above link once, and bookmark it in your browser (on Android, via hamburger icon -> "Install shortcut"). After the initial load, the page will be cached and available offline.

## Features

### Fully offline

- pako, qrcode-generator and jsQR are inlined, and there are no CDN, Vue or WASM dependencies that require fetches on each use. They work from `file://` and are served with a service worker (`offline/sw.js`) so that once a page is opened once over http(s) the browser precaches it and it keeps working — fully interactive, camera included — when offline. Rebuild them with `python3 build_offline.py`; the pinned libraries live in `offline/vendor/`.

### Fast, loss-tolerant transfers

- Codes carry raw bytes instead of base64 text, at a selectable code size of up to 2.9 KB per code (the original format carries 250 bytes).
- After each pass over the file the sender shows repair codes, each an XOR of many chunks. The receiver rebuilds whatever it missed from them, so a dropped code costs one extra code, not another full pass.
- The receiver finds the code in the camera picture, then decodes only that region at a fixed number of pixels per module. It decodes each camera frame once, at full camera resolution, and lets you pick the camera.
- The receiver can also scan a window or screen of its own machine ("Capture a Window"), for senders shown in a remote desktop client. No camera or virtual camera is needed for that.
- The wire format is specific to this fork (`offline/templates/codec.js`). Codes are not compatible with the sender or scanner of the online repo.

### Transfers both files and pastes

- The sender adds Prev/Next buttons, speed and code size selectors, and support for pastes in addition to files.

### Hardening and self-hosting instructions

- Adds basic hardening and unit tests against malicious payloads and self-hosting instructions for popular cloud providers.

## Technical overview

### Data Sender (offline/generator.html)

1. **Source Selection**: The user either picks a file from their device or pastes text into the text box (text takes priority over any selected file). Pastes are sent as a file named `Paste @ <timestamp>` (local time, e.g. `Paste @ 2026-08-11_14-30-05`).
2. **Validation**: Text is checked for an empty value, a size limit (`1000000` characters), and malformed Unicode (unpaired surrogates) before sending; file names are sanitized to a bare, safe name.
3. **Compression**: The file name and payload are gzipped into one blob using the pako library.
4. **Chunking**: The blob is split into chunks sized to fit the chosen code size.
5. **QR Code Generation**: Each frame (a 15-byte header plus one chunk) is drawn as a byte-mode QR code using qrcode-generator, with a white margin so it scans on any page background.
6. **Display QR Codes**: The sender loops until stopped: every chunk in order, then a batch of repair codes (new ones on each loop).

### Data Receiver (offline/scanner.html)

1. **QR Code Scanning**: The device's camera scans QR codes using jsQR, tracking the code's position between frames.
2. **Decoding**: Each frame's header is validated and its chunk or repair data is collected.
3. **Reconstruction**: Missing chunks are solved from repair frames by Gaussian elimination, and the chunks are reassembled into the gzipped blob.
4. **Decompression**: The blob is decompressed using pako.
5. **File Download**: The reconstructed file is made available for download under its sanitized name.

## Self-Hosting

The receiver needs a **secure context** for camera access, so serve the pages over https. The site is fully static (`offline/`), needs no build step, and has zero dependencies. The bundled zero-dependency Node server (`server.js`, Node 18+) serves it, listens on `$PORT` (default `3000`), and auto-redirects plain http to https when behind a reverse proxy that sets `X-Forwarded-Proto` (e.g. Heroku or Cloud Run). To test locally, `npm start` serves `offline/` at <http://localhost:3000/> — `localhost` is a secure context, so the scanner can use the camera.

### Heroku

The repo ships with a `Procfile` (`web: npm start`), so it deploys as-is:

```sh
heroku create my-airgap-qr
git push heroku main
heroku open
```

Heroku terminates TLS and sets `X-Forwarded-Proto`, so the bundled server's http→https redirect works out of the box.

### Google Cloud (Cloud Run)

`gcloud run deploy` builds the repo with Google Cloud buildpacks, which honor the included `Procfile`, and provisions TLS for you:

```sh
gcloud run deploy airgap-qr --source . --region us-central1 --allow-unauthenticated
```

### AWS (Amplify Hosting)

Since the site is static, host the `offline/` files directly — no Node server needed. In the [Amplify Hosting console](https://console.aws.amazon.com/amplify/), connect the GitHub repo and use this build spec (no build, static artifacts):

```yaml
version: 1
frontend:
  phases:
    build:
      commands: []
  artifacts:
    baseDirectory: offline
    files:
      - "**/*"
```

Amplify provisions the https domain. (An S3 bucket alone won't work — its website endpoint is plain http, and the camera needs a secure context; if you prefer S3, put CloudFront with https in front of it.)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo's assumptions (minimal code, minimal features, broad platform compatibility) and how to submit changes.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

It is a heavily modified fork of [Airgapped QR Code Transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer) by Mohankumar Ramachandran, which was originally released under the MIT License. Due to extensive rewriting, original MIT-licensed code is interleaved throughout the codebase; the original MIT copyright notice and license text are preserved verbatim in the [LICENSE](LICENSE) file, as that license requires.

## Acknowledgments
- [pako](https://github.com/nodeca/pako) - Compression library.
- [qrcode.js](https://github.com/davidshimjs/qrcodejs) - QR code generation library.
- [jsQR](https://github.com/cozmo/jsQR) - QR code scanning library.
