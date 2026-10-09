# Airgapped QR File Transfer (offline)

Move a file between two machines using only a screen on one side and a camera or window capture on the other. No network, cable, clipboard or USB stick is involved. The sender shows a stream of codes and the receiver reads them and rebuilds the file.

Everything is static HTML. The sender and receiver are single files with their libraries inlined, so they run from `file://` or a local server and keep working offline.

This is a fork of [chrislengerich/airgap-qr-offline](https://github.com/chrislengerich/airgap-qr-offline), itself a rewrite of [Airgapped QR Code Transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer). It uses its own wire format and is **not compatible** with either of them, or with the hosted site at qrft.org.

## Quick start

```sh
npm start        # serves offline/ at http://localhost:3000
```

1. Open `generator.html` on the machine that has the file. Pick a file or paste text, then press Start Transfer.
2. Open `scanner.html` on the machine that should get it. Press Start Receiver to use a camera, or Capture a Window to read a window on the same machine.
3. The receiver downloads the file once it has enough codes.

The receiver needs a secure context (`https://` or `http://localhost`) to open a camera or capture a window. The sender has no such need and also works from `file://`.

## Which mode to use

| | QR code | Grid code | `mini.html` |
|---|---|---|---|
| Read by | camera or window capture | window capture only | window capture only |
| Data per picture | 0.4 to 2.9 KB | 24 KB at 4px cells on a 2560x1440 window, 70 KB in colour | same as grid, black and white |
| Lost pictures | rebuilt from repair codes | rebuilt from repair codes | wait for the loop to come round |
| Sender size | 101 KB, one file | same file | about 50 lines, typeable |

Use **QR** when a camera points at a screen. Use the **grid** when the receiver can capture the sender's window directly, for example a remote desktop client. Use **`mini.html`** when nothing can be copied to the sending machine and you have to type the sender in.

Measured with both pages in headless Chromium, the sender's canvas fed to the receiver as its video, at 20 pictures per second:

| Mode | File | Time |
|---|---|---|
| QR, 1.3 KB codes | 200 KB | 10.4 s |
| Grid, 4px, black and white, 2528x1400 picture | 2 MB | 4.9 s |
| Grid, 4px, colour, 2528x1400 picture | 2 MB | 2.2 s |
| Grid, 4px, colour, 1256x1280 picture | 2 MB | 4.2 s |
| `mini.html`, 2528x1360 picture | 2 MB | 8.3 s |

Those runs skip the real camera and screen capture paths, so expect somewhat less in practice. Files were random bytes, which do not compress.

## Sender (`offline/generator.html`)

- **File or text.** Pasted text takes priority over a selected file and is sent as `Paste @ <timestamp>`.
- **Speed.** From 2 s down to 0.05 s per picture.
- **Code type.** QR or grid.
- **Code size** (QR). 0.4 to 2.9 KB per code. Larger codes need a sharper picture: the largest is 177 modules wide.
- **Grid cell** and **Colour** (grid). Cells of 3 to 12 pixels. Colour stores three bits per cell, one per RGB channel.
- **Prev / Next** step through pictures by hand.

The sender loops until stopped: every chunk of the file in order, then half a pass of repair codes, with new repair codes on each loop.

Two things matter for grid mode. The picture fills the window, so a bigger window sends more per picture. And the whole picture has to stay visible in the captured window, border included.

## Receiver (`offline/scanner.html`)

- **Start Receiver** opens a camera at up to 1080p. A dropdown appears when there are several. Switching cameras keeps what was received so far.
- **Capture a Window** reads a window or screen of the receiver's own machine, chosen in the browser's picker. Nothing connects the two machines.
- It detects QR or grid, and colour or not, by itself.
- For QR it finds the code once, then decodes only that region, scaled to five pixels per module.
- For grid it finds the border once, then only samples cell centres.
- The **stats line** shows the video size, what it is tracking, how many frames it read from the last picture, and the decode time. Use it to tune the sender: if frames go missing, pick bigger cells or a slower speed.

## Over a remote desktop

This is the case the grid code was built for. The sender runs inside the remote session. The receiver runs locally and captures the remote desktop client's window. The data crosses as pixels.

Remote desktop codecs are usually lossy, and they compress colour harder than brightness. Start with black and white at 4px cells. If the stats line shows every frame read, try colour, and go to 8 or 12px cells if colour loses frames.

## The typeable sender (`offline/mini.html`)

About 50 lines and 2,200 characters without comments and indentation, with no libraries. It compresses with the browser's `CompressionStream` (Chrome and Edge 80+, Firefox 113+, Safari 16.4+), sends black and white grid codes with 4px cells, and loops the file with no repair codes. The normal receiver reads it.

A typo in it fails silently: the receiver rejects every frame and the sender shows no error.

## How it works

The file name and contents are gzipped into one blob. The blob is cut into chunks, and each chunk travels in a frame with a 15-byte header that names the transfer, the blob length, the chunk size and the frame number. A receiver can start on any frame.

**Repair codes.** Frames past the last chunk are the XOR of a pseudo-random subset of chunks, derived from the frame number. The receiver solves for missing chunks by Gaussian elimination, so any set of independent frames as large as the file rebuilds it. In simulation, losing 5% of frames cost 1.05 times the file's frames and losing 30% cost 1.42 times.

**QR codes** carry one frame as raw bytes at error correction level L.

**Grid codes** are a black border, a white gap, timing marks along the top and left, and the data cells. The marks give the number of columns and rows and where they sit. A grid has no error correction of its own, so one picture carries many frames, each followed by a CRC32. Damage to part of a picture only loses the frames it touches.

The format is defined in `offline/templates/codec.js` and `offline/templates/grid.js`, which both pages inline.

## Limits and hardening

- A transfer is at most 64 MB compressed and 200,000 chunks.
- The receiver validates every header, sanitizes the file name, and fails loudly if the reassembled blob is not valid.
- A frame from a different transfer replaces the current one only after three arrive in a row.

## Development

```sh
python3 offline/build_offline.py   # rebuild generator.html and scanner.html from offline/templates/
npm test                           # Node's built-in test runner, no dependencies
```

- Templates and the shared `codec.js` and `grid.js` live in `offline/templates/`. Vendored libraries live in `offline/vendor/`. Pass `--fetch` to the build script to download them again.
- `mini.html` is hand-written and not part of the build.
- A service worker (`offline/sw.js`) caches the pages for offline use. Bump its `CACHE` name when the pages change, or browsers keep the old ones.

## Self-hosting

The site is static, so any https host works. The bundled Node server (`server.js`, Node 18+) serves `offline/`, listens on `$PORT` (default `3000`), and redirects http to https behind a proxy that sets `X-Forwarded-Proto`.

### Heroku

The repo ships with a `Procfile` (`web: npm start`):

```sh
heroku create my-airgap-qr
git push heroku main
heroku open
```

### Google Cloud (Cloud Run)

```sh
gcloud run deploy airgap-qr --source . --region us-central1 --allow-unauthenticated
```

### AWS (Amplify Hosting)

Host the `offline/` files directly. In the [Amplify Hosting console](https://console.aws.amazon.com/amplify/), connect the repo and use this build spec:

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

An S3 bucket alone will not do, because its website endpoint is plain http. Put CloudFront with https in front of it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GNU General Public License v3.0, see [LICENSE](LICENSE).

This is a heavily modified fork of [Airgapped QR Code Transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer) by Mohankumar Ramachandran, originally released under the MIT License. The original MIT copyright notice and license text are preserved in [LICENSE](LICENSE), as that license requires.

## Acknowledgments

- [pako](https://github.com/nodeca/pako), compression.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), QR code generation.
- [jsQR](https://github.com/cozmo/jsQR), QR code scanning.
