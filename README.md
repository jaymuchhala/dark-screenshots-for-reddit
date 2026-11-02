# Dark Screenshots for Reddit

Turns bright screenshots dark on Reddit, such as Chrome Web Store dashboard shots and payment emails.

- **Screenshots you read:** bright UI screenshots on Reddit are shown dark. By default this follows Chrome's light or dark theme, and it can be set to Always. Photos are left alone.
- **Screenshots you upload:** a bright screenshot chosen, pasted or dropped on Reddit is replaced with a dark copy before Reddit receives it.
- **Wrong call:** right-click an image and choose "Switch dark mode for this image".

Images are analyzed on your computer. Nothing is sent anywhere.

## Install

Download this repo (Code, then Download ZIP) and unzip it, or clone it. Open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the folder.

## Test

`test/run.py` runs a copy of the extension on a localhost mock page in Playwright's Chromium. It takes a folder of light screenshots named `1.png` to `4.png` and an empty work folder.

## License

MIT
