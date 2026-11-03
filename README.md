# Dark Screenshots for Reddit

Turns bright screenshots dark on Reddit, such as Chrome Web Store dashboard shots and payment emails.

- **Screenshots you read:** bright UI screenshots on Reddit are shown dark. By default this follows Chrome's light or dark theme, and it can be set to Always. Photos are left alone.
- **Screen recordings (optional, off by default):** light-mode screen recordings and software demos in Reddit's video player are shown dark too. The extension samples five frames from Reddit's small preview copy of each video, and darkens the whole video if at least four look like a bright UI. A video that mixes screen capture with real-life footage is usually left alone. A bright real-life clip, such as a white studio or snow, can be darkened by mistake. Old Reddit, embeds such as YouTube, and uploads aren't covered.
- **Screenshots you upload:** a bright screenshot chosen, pasted or dropped on Reddit is replaced with a dark copy before Reddit receives it.
- **Wrong call:** right-click an image or video and choose "Change dark mode".

Images are analyzed on your computer. Nothing is sent anywhere.

## Install

Download this repo (Code, then Download ZIP) and unzip it, or clone it. Open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the folder.

## Test

`test/run.py` runs a copy of the extension on a localhost mock page in Playwright's Chromium. It takes a folder of light screenshots named `1.png` to `4.png` and an empty work folder.

## License

MIT
