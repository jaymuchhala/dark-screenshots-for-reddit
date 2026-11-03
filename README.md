# Dark Screenshots for Reddit

Turns bright screenshots dark on Reddit, such as Chrome Web Store dashboard shots and payment emails.

- **Screenshots you read:** bright UI screenshots on Reddit are shown dark. By default this follows Chrome's light or dark theme, and it can be set to Always. Photos are left alone. A white page with dark panels or photos on it gets only the page darkened. A dark panel on a blurred screenshot gets the blur darkened, and a photo under a pale browser toolbar gets the toolbar darkened.
- **Videos (optional, off by default):** light-mode screen recordings and software demos in Reddit's video player are shown dark. A video mixing light UI with real-life footage gets only the UI darkened, as far as the extension can find it. People on webcam keep their natural colors. Old Reddit, embeds such as YouTube, and uploads aren't covered.
- **Screenshots you upload:** a bright screenshot chosen, pasted or dropped on Reddit is replaced with a dark copy before Reddit receives it.
- **A tiny model has the last word:** the built-in checks can't tell a drawing from an app, so what they would darken also goes to a small image model that ships inside the extension (8 MB, tens of milliseconds, one CPU core). If it says the image isn't a screen, the image stays as it is. There's nothing to install or turn on, and it doesn't heat up the laptop or slow scrolling.
- **Wrong call:** right-click an image or video and choose "Change dark mode".

Images are analyzed on your computer. Nothing is sent anywhere.

## Known limitation: real-world videos

Screen recordings render well. Real-world footage doesn't render as well: the extension can miss light UI over footage, darken part of something real, or show rough edges while panels move or fade in. There's no setting yet to turn dark mode off for those videos alone, though one could be added. For now, right-click a video and choose "Change dark mode", or turn videos off in the popup.

## Install

Download this repo (Code, then Download ZIP) and unzip it, or clone it. Open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the folder.

## Test

`test/run.py` runs a copy of the extension on a localhost mock page in Playwright's Chromium. It needs light screenshots named `1.png` to `4.png` in `test/shots`, which isn't committed. Name sections to run only those: `python3 test/run.py video`. The sections are `detector`, `reader`, `upload`, `video`, `popup` and `ai`.

## License

MIT

## Credits

The video approach comes from [DarkTube AI](https://chromewebstore.google.com/detail/jdpkenafpomapadgdkjdjdddicobmkgb): no copy of the video, a CSS filter on the real video, and a canvas right after it that draws each frame through a mask. Selfie segmentation for keeping people's natural colors is also its idea. The extension uses its own code and its own detector for what counts as UI, and isn't affiliated with DarkTube AI.

## Third-party

- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), in `vendor/ort`.
- [MediaPipe selfie segmentation](https://github.com/google-ai-edge/mediapipe) (Apache-2.0), in `model/selfie-segmentation.onnx`.
- [MobileNetV4 conv small](https://huggingface.co/onnx-community/mobilenetv4_conv_small.e2400_r224_in1k) (Apache-2.0), in `model/`.
